import fs from 'fs'
import path from 'path'

export const PACKER_REGION_MAP: Record<string, string> = {
  LE: 'LE',
  TE: 'TE',
  CE: 'CE',
  BOX: 'TE',
  VISUAL: 'CE',
  // Suporte para pastas do Arthfilm 360
  CE_3H: 'CE',
  CE_9H: 'CE',
  LE_3H: 'LE',
  LE_9H: 'LE',
  CE_03: 'CE',
  CE_09: 'CE',
  LE_03: 'LE',
  LE_09: 'LE',
}

const PACKER_REGION_ORDER = ['CE', 'VISUAL', 'TE', 'BOX', 'LE']
const PACKER_EXTS = new Set(['.JPG', '.JPEG', '.HEIC'])

export function packerDetectInfo(
  filePath: string,
  basePath: string
): { region: string; location: number | null } | null {
  const ext = path.extname(filePath).toUpperCase()
  if (!PACKER_EXTS.has(ext)) return null

  const stem = path.basename(filePath, path.extname(filePath)).toUpperCase()

  // 0. Detecção para o padrão do Arthfilm 360: {turbine}_{blade}_{region}_{z}_{index}
  const parts = stem.split('_')
  if (parts.length >= 5) {
    try {
      const zVal = parseInt(parts[parts.length - 2], 10)
      const idxVal = parseInt(parts[parts.length - 1], 10)
      if (!isNaN(zVal) && !isNaN(idxVal)) {
        const regionCandidate = parts[parts.length - 3].toUpperCase()
        if (PACKER_REGION_MAP[regionCandidate]) {
          return { region: regionCandidate, location: zVal }
        }
      }
    } catch {
      // Ignorar e tentar fallbacks
    }
  }

  // 1. Padrão no nome do arquivo: --REGION_LOCATION_ — itera todas as ocorrências (não só
  // a primeira) e usa a primeira cuja região seja válida, evitando falso-positivo quando o
  // blade SN em si contém um trecho "letras_dígitos" antes do token de região de verdade.
  for (const m of stem.matchAll(/--([A-Z]+)_(\d+)/g)) {
    const region = m[1]
    if (PACKER_REGION_MAP[region]) {
      return { region, location: parseInt(m[2], 10) }
    }
  }

  // 2. Fallback: Pastas ancestrais correspondentes a regiões
  try {
    const relativePath = path.relative(basePath, filePath)
    const relativeParts = relativePath.split(path.sep)
    const folders = relativeParts.slice(0, -1).reverse() // Percorrer de trás para a frente
    for (const folder of folders) {
      const folderUpper = folder.toUpperCase()
      if (PACKER_REGION_MAP[folderUpper]) {
        const locMatch = stem.match(/_(\d+)_/)
        const location = locMatch ? parseInt(locMatch[1], 10) : null
        return { region: folderUpper, location }
      }
    }
  } catch {
    // Ignorar falha no cálculo relativo
  }

  return null
}

export function packerIsMultiBlade(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) return false
  const children = fs.readdirSync(dirPath, { withFileTypes: true })

  for (const child of children) {
    if (child.isDirectory()) {
      if (PACKER_REGION_MAP[child.name.toUpperCase()]) {
        return false
      }
    }
  }

  let bladeCandidates = 0
  for (const child of children) {
    if (!child.isDirectory() || child.name.startsWith('.')) continue

    const subpath = path.join(dirPath, child.name)
    const subChildren = fs.readdirSync(subpath, { withFileTypes: true })

    for (const item of subChildren) {
      if (item.isDirectory() && PACKER_REGION_MAP[item.name.toUpperCase()]) {
        bladeCandidates++
        break
      }
      if (
        item.isFile() &&
        PACKER_EXTS.has(path.extname(item.name).toUpperCase())
      ) {
        const stem = path
          .basename(item.name, path.extname(item.name))
          .toUpperCase()
        if (stem.match(/^(.+?)--(.+?)--/)) {
          bladeCandidates++
          break
        }
      }
    }
    if (bladeCandidates >= 2) return true
  }

  return false
}

function rglobFiles(dir: string): string[] {
  let results: string[] = []
  if (!fs.existsSync(dir)) return results
  const list = fs.readdirSync(dir, { withFileTypes: true })
  for (const file of list) {
    const res = path.join(dir, file.name)
    if (file.isDirectory()) {
      if (!file.name.startsWith('.')) {
        results = results.concat(rglobFiles(res))
      }
    } else {
      results.push(res)
    }
  }
  return results
}

export function packerCollectBlade(
  bladePath: string,
  basePath: string
): {
  turbine: string
  blade: string
  files: any[]
  skipped: number
  withoutLocation: number
} {
  const files: any[] = []
  let skipped = 0
  let withoutLocation = 0
  let turbine = ''
  let blade = ''

  const allFiles = rglobFiles(bladePath)
  for (const f of allFiles) {
    const ext = path.extname(f).toUpperCase()
    if (!PACKER_EXTS.has(ext)) continue

    const info = packerDetectInfo(f, basePath)
    if (info) {
      const { region, location } = info
      if (location === null) {
        withoutLocation++
      }

      if (!turbine) {
        const stem = path.basename(f, path.extname(f))
        const headerMatch = stem.match(/^(.+?)--(.+?)--/i)
        if (headerMatch) {
          turbine = headerMatch[1]
          blade = headerMatch[2]
        }
      }
      files.push({ region, location, filePath: f })
    } else {
      skipped++
    }
  }

  if (!blade) {
    blade = path.basename(bladePath)
  }

  return { turbine, blade, files, skipped, withoutLocation }
}

export function packerGenerateCsv(
  files: any[],
  turbine: string,
  blade: string,
  basePath: string,
  outputDir: string,
  sendLog: (msg: string, type?: string) => void
): void {
  const orderIdx = new Map<string, number>()
  PACKER_REGION_ORDER.forEach((r, idx) => orderIdx.set(r, idx))

  // Ordenar arquivos por região (Ordem do Packer), depois localização Z, depois nome.
  // Tenta a região crua primeiro — LE/TE/CE/BOX/VISUAL (as 5 regiões nativas do Python)
  // já batem direto em PACKER_REGION_ORDER, então BOX e VISUAL formam seus próprios grupos
  // de ordenação, distintos de TE/CE, igual ao Python original. Só cai no mapeamento pra
  // variantes extras (Arthfilm 360, ex: CE_3H) que não existem no Python.
  const regionOrder = (region: string): number =>
    orderIdx.get(region) ?? orderIdx.get(PACKER_REGION_MAP[region] || '') ?? 99

  files.sort((a, b) => {
    const regA = regionOrder(a.region)
    const regB = regionOrder(b.region)
    if (regA !== regB) return regA - regB

    const locA = a.location !== null ? a.location : 10 ** 9
    const locB = b.location !== null ? b.location : 10 ** 9
    if (locA !== locB) return locA - locB

    return path.basename(a.filePath).localeCompare(path.basename(b.filePath))
  })

  const rows: string[] = []
  rows.push(
    'id,workorder,turbine,blade,region,image_id,distance_to_hub,gimbal_pos,temperature,timestamp'
  )

  files.forEach((file, index) => {
    const csvRegion = PACKER_REGION_MAP[file.region] || file.region
    const relPath = path.relative(basePath, file.filePath)
    const imageId = relPath.replace(/\//g, '\\')
    const distanceToHub = file.location !== null ? String(file.location) : '0'

    const row = `${index + 1},,${turbine},${blade},${csvRegion},${imageId},${distanceToHub},00,00,00`
    rows.push(row)
  })

  let csvName = `${turbine}--${blade}.csv`
  if (!turbine) {
    csvName = `${blade}.csv`
  }

  csvName = csvName.replace(/[\/*?:"<>|]/g, '_')
  const csvPath = path.join(outputDir, csvName)

  fs.writeFileSync(csvPath, rows.join('\n'), 'utf-8')
  sendLog(`CSV gerado: ${csvName} (${files.length} linhas)`, 'success')
  sendLog(`  Output: ${csvPath}`, 'info')
}

export async function packerPlataforma(
  pastaBlade: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) {
      webContents.send('arthlog', { type, text })
    }
  }

  const sendDone = () => {
    if (webContents) {
      webContents.send('arthdone', {})
    }
  }

  try {
    const pasta = pastaBlade
    const isMulti = packerIsMultiBlade(pasta)

    if (isMulti) {
      const items = fs.readdirSync(pasta, { withFileTypes: true })
      const bladeDirs = items
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => path.join(pasta, d.name))
        .sort()

      sendLog(
        `Aerogerador detectado — ${bladeDirs.length} pasta(s) de pá encontrada(s)`,
        'info'
      )

      const bladesData: any[] = []
      for (const bladeDir of bladeDirs) {
        const { turbine, blade, files, skipped, withoutLocation } =
          packerCollectBlade(bladeDir, bladeDir)
        if (files.length === 0) {
          sendLog(
            `  ${path.basename(bladeDir)}: nenhuma imagem com região detectada, pulando`,
            'warning'
          )
          continue
        }
        bladesData.push({
          bladeDir,
          turbine,
          blade,
          files,
          skipped,
          withoutLocation,
        })
      }

      const snCounts: Record<string, number> = {}
      bladesData.forEach(bd => {
        snCounts[bd.blade] = (snCounts[bd.blade] || 0) + 1
      })
      const hasCollision = Object.values(snCounts).some(c => c >= 2)

      if (hasCollision) {
        sendLog('', 'info')
        sendLog(
          '⚠️  Conflito detectado: múltiplas pastas produzem o mesmo Blade SN.',
          'warning'
        )
        sendLog(
          '    Nome dos arquivos provavelmente foi gerado em campo com SN errado.',
          'warning'
        )
        sendLog(
          '    Usando nome da pasta como Blade SN (override automático):',
          'warning'
        )
        bladesData.forEach(bd => {
          const folderName = path.basename(bd.bladeDir)
          sendLog(
            `      ${folderName}/  →  blade=${folderName} (era ${bd.blade})`,
            'warning'
          )
        })
        sendLog('', 'info')
      }

      for (const bd of bladesData) {
        let finalBladeSn = bd.blade
        if (hasCollision) {
          finalBladeSn = path.basename(bd.bladeDir)
        }

        sendLog(
          `── Pá: ${bd.turbine}--${finalBladeSn} (${bd.files.length} imagens) ──`,
          'info'
        )

        const regionCounts: Record<string, number> = {}
        bd.files.forEach((f: any) => {
          regionCounts[f.region] = (regionCounts[f.region] || 0) + 1
        })
        PACKER_REGION_ORDER.forEach(r => {
          if (regionCounts[r]) {
            sendLog(`  ${r}: ${regionCounts[r]} imagens`, 'info')
          }
        })

        if (bd.withoutLocation > 0) {
          sendLog(
            `  ⚠️ ${bd.withoutLocation} imagem(ns) sem localização (Z) no nome`,
            'warning'
          )
        }
        if (bd.skipped > 0) {
          sendLog(
            `  ⚠️ Ignorados ${bd.skipped} arquivo(s) fora do padrão`,
            'warning'
          )
        }

        packerGenerateCsv(
          bd.files,
          bd.turbine,
          finalBladeSn,
          bd.bladeDir,
          pasta,
          sendLog
        )
      }
    } else {
      sendLog(`Iniciando classificação de pasta única...`, 'info')
      const { turbine, blade, files, skipped, withoutLocation } =
        packerCollectBlade(pasta, pasta)

      if (files.length === 0) {
        sendLog(
          `Nenhuma imagem com região detectada na pasta selecionada.`,
          'error'
        )
        sendDone()
        return { success: false, error: 'Nenhuma imagem com região detectada.' }
      }

      sendLog(
        `── Pá: ${turbine}--${blade} (${files.length} imagens) ──`,
        'info'
      )
      const regionCounts: Record<string, number> = {}
      files.forEach((f: any) => {
        regionCounts[f.region] = (regionCounts[f.region] || 0) + 1
      })
      PACKER_REGION_ORDER.forEach(r => {
        if (regionCounts[r]) {
          sendLog(`  ${r}: ${regionCounts[r]} imagens`, 'info')
        }
      })

      if (withoutLocation > 0) {
        sendLog(
          `  ⚠️ ${withoutLocation} imagem(ns) sem localização (Z) no nome`,
          'warning'
        )
      }
      if (skipped > 0) {
        sendLog(`  ⚠️ Ignorados ${skipped} arquivo(s) fora do padrão`, 'warning')
      }

      packerGenerateCsv(files, turbine, blade, pasta, pasta, sendLog)
    }

    sendDone()
    return { success: true }
  } catch (err: any) {
    sendLog(`Erro no processamento do Packer: ${err.message}`, 'error')
    sendDone()
    return { success: false, error: err.message }
  }
}
