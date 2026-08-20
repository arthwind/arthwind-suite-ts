import fs from 'fs'
import path from 'path'

export async function enviarVideosDrive(
  localTurbineFolder: string,
  driveTurbineFolder: string,
  dryRun: boolean,
  sender: Electron.WebContents
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (sender) sender.send('arthlog', { type, text })
  }

  try {
    sendLog(`Iniciando sincronização de vídeos Arthfilm...`, 'info')
    sendLog(`Origem local (PC): ${localTurbineFolder}`, 'info')
    sendLog(`Destino (Google Drive): ${driveTurbineFolder}`, 'info')

    if (dryRun) {
      sendLog(`[DRY-RUN] Simulação ativa. Nenhum arquivo físico será alterado.`, 'warning')
    }

    if (!fs.existsSync(localTurbineFolder)) {
      sendLog(`Erro: Pasta de origem local não existe.`, 'error')
      return { success: false, error: 'Pasta de origem local não existe.' }
    }
    if (!fs.existsSync(driveTurbineFolder)) {
      sendLog(`Erro: Pasta de destino no Drive não existe.`, 'error')
      return { success: false, error: 'Pasta de destino no Drive não existe.' }
    }

    // Helper para normalizar nomes de diretório (substitui underscores/traços por espaços e tira excessos)
    const normalize = (name: string) => {
      return name.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
    }

    // 1. Escaneamento recursivo da pasta local à procura de pastas de output de
    // marca d'água. Match por SUBSTRING (contém "360" E "watermark"), não mais
    // igualdade exata — bug real achado pelo usuário: com só 1 pá pronta (as
    // outras ainda em processamento), a pasta gerada pela ArthFilm 360 Studio pra
    // essa pá isolada não batia com o nome exato esperado (variação de
    // nomenclatura ainda não confirmada — ex: sufixo, numeração, etc.), e a
    // varredura silenciosamente considerava que não existia pasta nenhuma,
    // mesmo achando 1 pasta de vídeo de verdade no disco. Substring é bem mais
    // tolerante a variações e não deveria mais deixar passar uma pasta real.
    sendLog(`Escaneando pasta local por diretórios de output de marca d'água...`, 'info')
    const localWatermarkDirs: string[] = []
    const allDirNamesScanned: string[] = []

    function scanDir(dir: string) {
      const list = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of list) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          const normName = normalize(entry.name)
          allDirNamesScanned.push(entry.name)
          if (normName.includes('360') && normName.includes('watermark')) {
            localWatermarkDirs.push(fullPath)
          } else if (!entry.name.startsWith('.')) {
            scanDir(fullPath)
          }
        }
      }
    }

    scanDir(localTurbineFolder)
    sendLog(`Varredura finalizada. Localizada(s) ${localWatermarkDirs.length} pasta(s) de vídeos.`, 'info')

    if (localWatermarkDirs.length === 0) {
      sendLog(`Nenhuma pasta de vídeos (ex: '360 WATERMARKED') foi encontrada na turbina local.`, 'warning')
      // Loga todas as pastas realmente encontradas na varredura — se uma pasta de
      // vídeo de verdade estiver aí com um nome diferente do esperado, fica óbvio
      // no log em vez de só "não achei nada".
      if (allDirNamesScanned.length > 0) {
        sendLog(`   Pastas encontradas na varredura: ${allDirNamesScanned.join(', ')}`, 'warning')
      }
      return { success: true, copiedFolders: 0, copiedFiles: 0 }
    }

    let copiedFolders = 0
    let copiedFiles = 0

    // 2. Processar cada pasta de watermark mapeada
    for (const srcWatermark of localWatermarkDirs) {
      // Identificar a pasta local da pá (pasta pai da watermark)
      const localBladePath = path.dirname(srcWatermark)
      const localBladeName = path.basename(localBladePath)
      const normLocalBladeName = normalize(localBladeName)

      sendLog(`Processando vídeos da pá: ${localBladeName}...`, 'info')

      // Buscar a pasta correspondente da pá no Google Drive (ex: BLADE_0487 no PC -> BLADE 0487 ou BLADE_0487 no Drive)
      const driveEntries = fs.readdirSync(driveTurbineFolder, { withFileTypes: true })
      let matchedDriveBladeName = ''
      
      for (const entry of driveEntries) {
        if (entry.isDirectory()) {
          if (normalize(entry.name) === normLocalBladeName) {
            matchedDriveBladeName = entry.name
            break
          }
        }
      }

      if (!matchedDriveBladeName) {
        sendLog(`⚠ Não foi possível encontrar a pasta correspondente no Drive para a pá local '${localBladeName}' (buscado por: '${normLocalBladeName}'). Pulando...`, 'warning')
        continue
      }

      const driveBladePath = path.join(driveTurbineFolder, matchedDriveBladeName)
      sendLog(`   Mapeado Pá: ${localBladeName} ➔ ${matchedDriveBladeName}`, 'info')

      // Ler subpastas de região de vídeo (CE_3h, CE_9h, LE_3h, LE_9h etc)
      const regions = fs.readdirSync(srcWatermark, { withFileTypes: true })
      for (const reg of regions) {
        if (reg.isDirectory()) {
          const regName = reg.name
          const srcRegPath = path.join(srcWatermark, regName)
          const normRegName = regName.toLowerCase()

          // Detectar a faixa de horário (3h ou 9h)
          let timeSlot = 3
          if (normRegName.includes('9h') || normRegName.includes('9hrs') || normRegName.includes('9 horas')) {
            timeSlot = 9
          }

          // Buscar pasta de horário correspondente no Drive da pá (ex: 360-03HRS ou 360-09HRS)
          const driveBladeEntries = fs.readdirSync(driveBladePath, { withFileTypes: true })
          let matchedTimeFolderName = ''

          for (const entry of driveBladeEntries) {
            if (entry.isDirectory()) {
              const normEntry = normalize(entry.name)
              if (timeSlot === 3) {
                if (normEntry.includes('3h') || normEntry.includes('3hrs') || normEntry.includes('03hrs') || normEntry.includes('3 horas')) {
                  matchedTimeFolderName = entry.name
                  break
                }
              } else if (timeSlot === 9) {
                if (normEntry.includes('9h') || normEntry.includes('9hrs') || normEntry.includes('09hrs') || normEntry.includes('9 horas')) {
                  matchedTimeFolderName = entry.name
                  break
                }
              }
            }
          }

          // Se não encontrou a pasta de horário, usa uma nomenclatura padrão padrão do Drive
          if (!matchedTimeFolderName) {
            matchedTimeFolderName = timeSlot === 3 ? '360-03HRS' : '360-09HRS'
            sendLog(`   ⚠ Pasta do horário (${timeSlot}h) não localizada no Drive. Será criada como: '${matchedTimeFolderName}'`, 'warning')
          }

          // Montar o caminho final no Drive: Blade -> Horário -> FINAL -> Região
          const destRegPath = path.join(driveBladePath, matchedTimeFolderName, 'FINAL', regName)
          sendLog(`   ➡ Copiando: [${localBladeName} ➔ ${regName}] ➔ [${matchedTimeFolderName} ➔ FINAL ➔ ${regName}]`, 'info')

          if (!dryRun) {
            fs.mkdirSync(destRegPath, { recursive: true })
          }

          // Copiar os vídeos
          const files = fs.readdirSync(srcRegPath, { withFileTypes: true })
          for (const file of files) {
            if (file.isFile()) {
              const srcFilePath = path.join(srcRegPath, file.name)
              const destFilePath = path.join(destRegPath, file.name)

              if (dryRun) {
                sendLog(`      [Dry-run] Copiaria: ${file.name}`, 'success')
                copiedFiles++
              } else {
                try {
                  fs.copyFileSync(srcFilePath, destFilePath)
                  sendLog(`      ✔ Copiado: ${file.name}`, 'success')
                  copiedFiles++
                } catch (copyErr: any) {
                  sendLog(`      ❌ Erro ao copiar ${file.name}: ${copyErr.message}`, 'error')
                }
              }
            }
          }
          copiedFolders++
        }
      }
    }

    sendLog(`\n=== PROCESSO FINALIZADO ===`, 'info')
    sendLog(`Total de regiões processadas: ${copiedFolders}`, 'success')
    sendLog(`Total de arquivos de vídeos copiados: ${copiedFiles}`, 'success')
    if (!dryRun) {
      sendLog(`Nota: O Google Drive para Computador começará a subir os arquivos na nuvem automaticamente.`, 'info')
    }

    return { success: true, copiedFolders, copiedFiles }
  } catch (err: any) {
    sendLog(`Erro crítico ao processar o upload de vídeos: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}
