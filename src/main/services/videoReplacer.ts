import fs from 'fs'
import path from 'path'

/**
 * Normaliza um nome de arquivo ou pasta para facilitar comparações flexíveis.
 * Remove diferenças de espaço vs underscore, hífen e case.
 */
function normName(str: string): string {
  return str.toLowerCase().replace(/[\s\-_]+/g, '')
}

/**
 * Extrai nomes de arquivos de vídeo MP4 referenciados dentro de um arquivo CSV de telemetria.
 * Ignora CSVs de fotos 360 ou de danos que não apontem para vídeos.
 */
function extractReferencedVideosFromCsv(csvPath: string): string[] {
  try {
    const content = fs.readFileSync(csvPath, 'utf-8')
    const lines = content.split(/\r?\n/)
    if (lines.length < 2) return []

    const referencedVideos = new Set<string>()

    // Regex estrita para capturar nomes de vídeo no padrão Insta360 (VID_YYYYMMDD_HHMMSS_XX_XXX.mp4)
    // e regex genérica para qualquer .mp4 referenciado na linha de telemetria
    const vidRegex = /VID_\d{8}_\d{6}_\d{2}_\d{3}\.mp4/gi
    const genericMp4Regex = /([a-zA-Z0-9_\-]+\.mp4)/gi

    for (const line of lines) {
      // 1. Tenta encontrar pelo padrão VID_...mp4
      let match: RegExpExecArray | null
      while ((match = vidRegex.exec(line)) !== null) {
        referencedVideos.add(match[0].toLowerCase())
      }

      // 2. Se a linha contiver palavra 'video_id' ou 'video_created_at' ou 'file_path'
      if (line.toLowerCase().includes('.mp4')) {
        let genMatch: RegExpExecArray | null
        while ((genMatch = genericMp4Regex.exec(line)) !== null) {
          const vName = genMatch[1].toLowerCase()
          if (vName.endsWith('.mp4')) {
            referencedVideos.add(vName)
          }
        }
      }
    }

    return Array.from(referencedVideos)
  } catch (err) {
    return []
  }
}

/**
 * Verifica se o arquivo é um vídeo MP4 esférico ou válido lendo seus primeiros bytes.
 */
function isValidSourceVideo(filePath: string): {
  valid: boolean
  reason?: string
} {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size === 0) {
      return { valid: false, reason: 'Arquivo zerado (0 bytes)' }
    }

    if (stat.size < 1024 * 1024) {
      return {
        valid: false,
        reason: `Arquivo muito pequeno (${(stat.size / 1024).toFixed(1)} KB)`,
      }
    }

    const buffer = Buffer.alloc(512)
    const fd = fs.openSync(filePath, 'r')
    fs.readSync(fd, buffer, 0, 512, 0)
    fs.closeSync(fd)

    const isMp4 = buffer.includes(Buffer.from('ftyp'))
    if (!isMp4) {
      return {
        valid: false,
        reason: 'Formato de container MP4 inválido (atom ftyp não encontrado)',
      }
    }

    return { valid: true }
  } catch (err: any) {
    return {
      valid: false,
      reason: `Erro ao inspecionar cabeçalho: ${err.message}`,
    }
  }
}

export async function substituirVideos360(
  outputFolder: string,
  targetFolder: string,
  dryRun: boolean,
  sender: Electron.WebContents
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (sender) sender.send('arthlog', { type, text })
  }

  try {
    sendLog(`Iniciando substituição robusta de vídeos 360...`, 'info')
    sendLog(`Origem (Insta360 Studio Output): ${outputFolder}`, 'info')
    sendLog(`Destino (Turbinas): ${targetFolder}`, 'info')
    if (dryRun) {
      sendLog(
        `[DRY-RUN] Simulação ativa. Nenhum arquivo físico será modificado.`,
        'warning'
      )
    }

    if (!fs.existsSync(outputFolder)) {
      sendLog(`Erro: Pasta de origem não existe.`, 'error')
      return { success: false, error: 'Pasta de origem não existe.' }
    }
    if (!fs.existsSync(targetFolder)) {
      sendLog(`Erro: Pasta de destino não existe.`, 'error')
      return { success: false, error: 'Pasta de destino não existe.' }
    }

    // 1. Mapear todos os arquivos da pasta de origem (Insta360 Output)
    sendLog(`Escaneando pasta de origem...`, 'info')
    const sourceMap = new Map<string, { fullPath: string; size: number }>()

    function scanSource(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          scanSource(fullPath)
        } else if (
          entry.isFile() &&
          entry.name.toLowerCase().endsWith('.mp4')
        ) {
          try {
            const stat = fs.statSync(fullPath)
            const nKey = normName(entry.name)
            sourceMap.set(nKey, { fullPath, size: stat.size })
          } catch (e) {
            // Ignora arquivos inacessíveis na origem
          }
        }
      }
    }

    scanSource(outputFolder)
    sendLog(
      `Escaneamento da origem concluído: ${sourceMap.size} vídeo(s) MP4 mapeado(s).`,
      'info'
    )

    // 2. Escanear a pasta de destino (Turbinas) e buscar correspondências
    sendLog(
      `Buscando vídeos correspondentes nas pastas das turbinas...`,
      'info'
    )

    type TargetMatch = {
      fullPath: string
      srcPath: string
      srcSize: number
      dstSize: number
      name: string
      locationStr: string
    }

    const matches: TargetMatch[] = []
    const existingLocalVideoNames = new Set<string>()

    function scanTarget(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          scanTarget(fullPath)
        } else if (
          entry.isFile() &&
          entry.name.toLowerCase().endsWith('.mp4')
        ) {
          const nKey = normName(entry.name)
          existingLocalVideoNames.add(nKey)
          existingLocalVideoNames.add(entry.name.toLowerCase())

          if (sourceMap.has(nKey)) {
            const srcInfo = sourceMap.get(nKey)!
            let dstSize = 0
            try {
              dstSize = fs.statSync(fullPath).size
            } catch (e) {}

            const relative = path.relative(targetFolder, fullPath)
            const parts = relative.split(path.sep)
            matches.push({
              fullPath,
              srcPath: srcInfo.fullPath,
              srcSize: srcInfo.size,
              dstSize,
              name: entry.name,
              locationStr: parts.slice(0, -1).join(' ➔ '),
            })
          }
        }
      }
    }

    scanTarget(targetFolder)
    const totalFound = matches.length
    sendLog(`${totalFound} vídeo(s) correspondente(s) encontrado(s).`, 'info')

    let totalReplaced = 0
    let totalSkipped = 0
    let totalLocked = 0
    let totalInvalid = 0

    // 3. Processamento de Substituição com Cópia Atômica e Tratamento de Bloqueio
    for (let i = 0; i < matches.length; i++) {
      const { fullPath, srcPath, srcSize, dstSize, name, locationStr } =
        matches[i]

      if (i % 5 === 0 || i === matches.length - 1) {
        sender.send('arthprogress', { current: i + 1, total: matches.length })
      }

      // Validação de integridade da origem
      const checkResult = isValidSourceVideo(srcPath)
      if (!checkResult.valid) {
        sendLog(
          `⚠️ Origem Inválida [${name}]: ${checkResult.reason}. Substituição ignorada.`,
          'warning'
        )
        totalInvalid++
        continue
      }

      // Se o tamanho do destino já for idêntico ao da origem, pula para evitar re-cópia desnecessária
      if (srcSize === dstSize && dstSize > 0) {
        sendLog(
          `⏭️ [Já Atualizado] ${name} em [${locationStr}] (${(srcSize / (1024 * 1024)).toFixed(1)} MB)`,
          'info'
        )
        totalSkipped++
        continue
      }

      if (dryRun) {
        sendLog(
          `[Dry-run] Substituiria: ${name} em [${locationStr}] (${(srcSize / (1024 * 1024)).toFixed(1)} MB)`,
          'success'
        )
        totalReplaced++
      } else {
        const tmpPath = `${fullPath}.tmp`
        try {
          await fs.promises.copyFile(srcPath, tmpPath)
          try {
            await fs.promises.rename(tmpPath, fullPath)
          } catch (renameErr: any) {
            await fs.promises.copyFile(tmpPath, fullPath)
            if (fs.existsSync(tmpPath)) {
              await fs.promises.unlink(tmpPath)
            }
          }

          sendLog(
            `✔ Substituído: ${name} em [${locationStr}] (${(srcSize / (1024 * 1024)).toFixed(1)} MB)`,
            'success'
          )
          totalReplaced++
        } catch (err: any) {
          if (fs.existsSync(tmpPath)) {
            try {
              await fs.promises.unlink(tmpPath)
            } catch (e) {}
          }

          if (
            err.code === 'EBUSY' ||
            err.code === 'EPERM' ||
            (err.message && err.message.includes('busy'))
          ) {
            sendLog(
              `⚠️ Arquivo Bloqueado pelo Windows/Player [${name}] em [${locationStr}]. Feche o player/visualizador.`,
              'warning'
            )
            totalLocked++
          } else {
            sendLog(
              `❌ Erro ao substituir ${name} em [${locationStr}]: ${err.message}`,
              'error'
            )
            totalLocked++
          }
        }
      }
    }

    // 4. Auditoria Precisa por Conteúdo de CSV de Telemetria e Geração de Relatório .txt
    sendLog(
      `\nAuditando CSVs de telemetria para identificar vídeos referenciados faltantes...`,
      'info'
    )

    type MissingVideoItem = {
      videoName: string
      csvFile: string
      locationStr: string
      inSourceOutput: boolean
    }

    const missingReferencedVideos: MissingVideoItem[] = []

    function auditCsvFiles(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          auditCsvFiles(fullPath)
        } else if (
          entry.isFile() &&
          entry.name.toLowerCase().endsWith('.csv')
        ) {
          const referencedVids = extractReferencedVideosFromCsv(fullPath)
          if (referencedVids.length > 0) {
            const relative = path.relative(targetFolder, fullPath)
            const parts = relative.split(path.sep)
            const locationStr = parts.slice(0, -1).join(' ➔ ')

            for (const vName of referencedVids) {
              const nKey = normName(vName)
              // Se o vídeo referenciado no CSV não existir na pasta de destino local
              if (
                !existingLocalVideoNames.has(nKey) &&
                !existingLocalVideoNames.has(vName.toLowerCase())
              ) {
                const inSourceOutput = sourceMap.has(nKey)
                missingReferencedVideos.push({
                  videoName: vName,
                  csvFile: entry.name,
                  locationStr,
                  inSourceOutput,
                })
              }
            }
          }
        }
      }
    }

    auditCsvFiles(targetFolder)

    // 5. Geração do Arquivo de Relatório TXT
    const now = new Date()
    const timestampStr = now.toISOString().replace('T', ' ').replace(/\..+/, '')
    const txtReportPath = path.join(
      targetFolder,
      'relatorio_videos_faltantes.txt'
    )

    let txtContent = `===================================================================\n`
    txtContent += `RELATÓRIO DE AUDITORIA DE VÍDEOS FALTANTES - ARTHWIND SUITE\n`
    txtContent += `Data/Hora: ${timestampStr}\n`
    txtContent += `Pasta de Destino: ${targetFolder}\n`
    txtContent += `Pasta de Origem (Insta360): ${outputFolder}\n`
    txtContent += `===================================================================\n\n`

    if (missingReferencedVideos.length > 0) {
      txtContent += `[VÍDEOS REFERENCIADOS NOS CSVS MAS FALTANTES NA PASTA LOCAL]\n\n`
      for (const item of missingReferencedVideos) {
        const statusSrc = item.inSourceOutput
          ? '(Disponível na pasta do Insta360 Studio)'
          : '(NÃO encontrado no Insta360 Studio)'
        txtContent += `• Vídeo Faltante: ${item.videoName}\n`
        txtContent += `  Localização: ${item.locationStr}\n`
        txtContent += `  CSV Referência: ${item.csvFile}\n`
        txtContent += `  Status na Origem: ${statusSrc}\n\n`
      }
      txtContent += `===================================================================\n`
      txtContent += `Total de Vídeos Referenciados Faltantes: ${missingReferencedVideos.length}\n`
      txtContent += `===================================================================\n`
    } else {
      txtContent += `✅ Nenhum vídeo de telemetria referenciado nos CSVs está faltando!\n`
      txtContent += `Todos os vídeos indicados nos CSVs estão presentes no diretório local.\n`
    }

    try {
      fs.writeFileSync(txtReportPath, txtContent, 'utf-8')
      sendLog(
        `📄 Relatório TXT gerado com sucesso: relatorio_videos_faltantes.txt`,
        'success'
      )
    } catch (e: any) {
      sendLog(
        `⚠️ Não foi possível salvar o arquivo .txt de relatório: ${e.message}`,
        'warning'
      )
    }

    // 6. Relatório Resumido de Conclusão na Interface
    sendLog(`\n=== PROCESSAMENTO E AUDITORIA CONCLUÍDOS ===`, 'info')
    sendLog(`• Total de correspondências encontradas: ${totalFound}`, 'info')
    sendLog(`• Vídeos substituídos com sucesso: ${totalReplaced}`, 'success')
    if (totalSkipped > 0)
      sendLog(`• Vídeos ignorados (já idênticos): ${totalSkipped}`, 'info')
    if (totalLocked > 0)
      sendLog(
        `• Vídeos bloqueados por outro processo: ${totalLocked}`,
        'warning'
      )
    if (totalInvalid > 0)
      sendLog(
        `• Vídeos da origem inválidos/zerados: ${totalInvalid}`,
        'warning'
      )

    if (missingReferencedVideos.length > 0) {
      sendLog(
        `\n⚠️ ATENÇÃO: ${missingReferencedVideos.length} vídeo(s) referenciado(s) nos CSVs de telemetria não foram encontrado(s) no local:`,
        'warning'
      )
      for (const item of missingReferencedVideos.slice(0, 10)) {
        sendLog(
          `  👉 [FALTANDO VÍDEO] ${item.videoName} em [${item.locationStr}] (CSV: ${item.csvFile})`,
          'warning'
        )
      }
      if (missingReferencedVideos.length > 10) {
        sendLog(
          `  ... e mais ${missingReferencedVideos.length - 10} vídeo(s). Consulte o arquivo relatorio_videos_faltantes.txt.`,
          'warning'
        )
      }
    } else {
      sendLog(
        `\n✅ Todos os vídeos de telemetria referenciados nos CSVs estão presentes!`,
        'success'
      )
    }

    return {
      success: true,
      totalFound,
      totalReplaced,
      totalSkipped,
      totalLocked,
      totalInvalid,
      missingReferencedVideosCount: missingReferencedVideos.length,
      txtReportPath,
    }
  } catch (err: any) {
    sendLog(`Erro crítico durante o processamento: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}
