import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { TurbinePackageItem, arthnexApi } from './arthnexApi'

const BASE_URL = 'https://scheduler.arthnex.com/'
const HOMOLOG_URL = 'https://scheduler-homolog.arthnex.com/'
const API_KEY = '22F9C68C-BC34-46A5-B10F-9E58759C7B95'

const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
}

function getClientBase(useHomolog: boolean): string {
  return useHomolog ? HOMOLOG_URL : BASE_URL
}

export async function listarWorkorders(useHomolog = false): Promise<any[]> {
  try {
    arthnexApi.setEnv(useHomolog ? 'homolog' : 'production')
    return await arthnexApi.getWorkorders()
  } catch {
    const url = `${getClientBase(useHomolog)}get-active-workorders`
    const resp = await fetch(url, { headers: HEADERS })
    if (!resp.ok)
      throw new Error(`HTTP ${resp.status} on get-active-workorders`)
    return resp.json() as Promise<any[]>
  }
}

export async function listarPasPendentes(
  workorderId: string,
  useHomolog = false
): Promise<any[]> {
  const url = `${getClientBase(useHomolog)}get-blades-pending-by-wo-packages/${workorderId}`
  const resp = await fetch(url, { headers: HEADERS })
  if (!resp.ok)
    throw new Error(`HTTP ${resp.status} on get-blades-pending-by-wo-packages`)
  return resp.json() as Promise<any[]>
}

export async function obterHierarquiaWorkorder(
  workorderId: string,
  useHomolog = false
): Promise<TurbinePackageItem[]> {
  arthnexApi.setEnv(useHomolog ? 'homolog' : 'production')
  return await arthnexApi.getTurbinesAndBladesByWo(workorderId)
}

function detectarSeFoto360(caminhoImagem: string): boolean {
  try {
    if (!fs.existsSync(caminhoImagem)) return false
    const fd = fs.openSync(caminhoImagem, 'r')
    const buffer = Buffer.alloc(512 * 1024)
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
    fs.closeSync(fd)

    const slice = buffer.subarray(0, bytesRead)
    return slice.includes('GPano:ProjectionType')
  } catch {
    return false
  }
}

function lerDimensoesJpeg(caminhoImagem: string): {
  width: number
  height: number
} {
  const buffer = fs.readFileSync(caminhoImagem)
  let i = 0
  if (buffer[i] !== 0xff || buffer[i + 1] !== 0xd8) {
    throw new Error('Not a valid JPEG')
  }
  i += 2
  while (i < buffer.length) {
    if (buffer[i] === 0xff) {
      const marker = buffer[i + 1]
      if (marker === 0xc0 || marker === 0xc2) {
        const height = buffer.readUInt16BE(i + 5)
        const width = buffer.readUInt16BE(i + 7)
        return { width, height }
      }
      i += 2 + buffer.readUInt16BE(i + 2)
    } else {
      i++
    }
  }
  throw new Error('SOF marker not found')
}

function lerCsv(csvPath: string): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    try {
      const content = fs.readFileSync(csvPath, 'utf-8')
      const lines = content.split(/\r?\n/)
      if (lines.length === 0) {
        return resolve([])
      }

      const headerLine = lines[0].replace(/^\uFEFF/, '') // strip BOM
      const headers = headerLine.split(',').map(h => h.trim())

      const results: Record<string, string>[] = []
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue

        const values = line.split(',').map(v => v.trim())
        const row: Record<string, string> = {}
        headers.forEach((h, idx) => {
          row[h] = values[idx] || ''
        })
        results.push(row)
      }
      resolve(results)
    } catch (e) {
      reject(e)
    }
  })
}

export function stripLeadingZeros(str: string): string {
  if (!str) return ''
  return str.replace(/(^|[^0-9])0+(?=[0-9])/g, '$1')
}

export function isPrefixMatch(longer: string, shorter: string): boolean {
  if (!longer || !shorter || !longer.endsWith(shorter)) return false
  const prefixLength = longer.length - shorter.length
  if (prefixLength === 0) return true
  const charBefore = longer[prefixLength - 1]
  return !/[0-9]/.test(charBefore)
}

export function normalizarBlade(name: string): string {
  if (!name) return ''
  let s = String(name).trim().toLowerCase()
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  s = stripLeadingZeros(s)
  const posClean = s
    .replace(/\b(pala|pá|blade|posicao|posição|pa)\b/gi, '')
    .replace(/[^a-z0-9]/g, '')
  const result = posClean || s.replace(/[-_\s]/g, '')
  return /^\d+$/.test(result)
    ? result.replace(/^0+(?=\d)/, '')
    : stripLeadingZeros(result)
}

export function normalizarTurbine(name: string): string {
  if (!name) return ''
  let s = String(name).trim().toLowerCase()
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  s = stripLeadingZeros(s)
  s = s.replace(/[^a-z0-9]/g, '')
  return stripLeadingZeros(s)
}

export function bladesCombinam(csvBlade: string, apiBlade: string): boolean {
  if (!csvBlade || !apiBlade) return false
  const normCsv = normalizarBlade(csvBlade)
  const normApi = normalizarBlade(apiBlade)
  if (!normCsv || !normApi) return false
  if (normCsv === normApi) return true
  if (isPrefixMatch(normCsv, normApi) || isPrefixMatch(normApi, normCsv))
    return true
  return false
}

export function turbinasCombinam(
  csvTurbine: string,
  apiTurbine: string
): boolean {
  if (!csvTurbine || !apiTurbine) return false
  const normCsv = normalizarTurbine(csvTurbine)
  const normApi = normalizarTurbine(apiTurbine)
  if (!normCsv || !normApi) return false
  if (normCsv === normApi) return true
  if (isPrefixMatch(normCsv, normApi) || isPrefixMatch(normApi, normCsv))
    return true
  return false
}

export function inferirTurbinaDoCaminho(
  csvPath: string,
  blades: any[]
): string {
  if (!csvPath || !blades || blades.length === 0) return ''

  // 1. Verificar padrão de nome de arquivo: {turbina}--{pá}.csv
  const filename = path.basename(csvPath)
  const headerMatch = filename.match(/^(.+?)--(.+?)\.csv$/i)
  if (headerMatch) {
    const candidate = headerMatch[1].trim()
    for (const b of blades) {
      if (b.turbine && turbinasCombinam(candidate, b.turbine)) {
        return b.turbine
      }
    }
  }

  // 2. Analisar pastas ancestrais da mais profunda para a raiz
  const normalizedPath = csvPath.replace(/\\/g, '/')
  const segments = normalizedPath.split('/').filter(Boolean).reverse()

  for (const seg of segments) {
    for (const b of blades) {
      if (!b.turbine) continue
      if (turbinasCombinam(seg, b.turbine)) {
        return b.turbine
      }
    }

    const tokens = seg.split(/[-_\s.]+/).filter(Boolean)
    for (const tok of tokens) {
      if (tok.length < 2 && !/^\d+$/.test(tok)) continue
      for (const b of blades) {
        if (!b.turbine) continue
        if (turbinasCombinam(tok, b.turbine)) {
          return b.turbine
        }
      }
    }
  }

  return ''
}

// Colunas que só existem no CSV de upload (photo_data já convertido pra formato Arthnex),
// o suficiente pra distinguir de outros CSVs do fluxo (telemetria, relatório de altitude,
// blade split etc.) sem precisar ler o arquivo inteiro — só a linha de cabeçalho.
const COLUNAS_CSV_UPLOAD = ['image_id', 'blade', 'region']

function lerCabecalhoCsv(csvPath: string): string[] {
  const fd = fs.openSync(csvPath, 'r')
  const buffer = Buffer.alloc(4096)
  const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
  fs.closeSync(fd)
  const primeiraLinha = buffer
    .subarray(0, bytesRead)
    .toString('utf-8')
    .split(/\r?\n/)[0]
  return primeiraLinha
    .replace(/^\uFEFF/, '')
    .split(',')
    .map(h => h.trim().toLowerCase())
}

function ehCsvDeUpload(csvPath: string): boolean {
  try {
    const headers = lerCabecalhoCsv(csvPath)
    return COLUNAS_CSV_UPLOAD.every(col => headers.includes(col))
  } catch {
    return false
  }
}

export function descobrirCsvsUpload(rootPath: string): string[] {
  const encontrados: string[] = []

  function scan(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(fullPath)
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith('.csv') &&
        ehCsvDeUpload(fullPath)
      ) {
        encontrados.push(fullPath)
      }
    }
  }

  scan(rootPath)
  return encontrados
}

async function processarUploadCsv(
  csvPath: string,
  rows: Record<string, string>[],
  workorderId: string,
  windbladeId: string,
  pSurface: string,
  collectDate: string,
  turbineId: string,
  useHomolog: boolean,
  sendLog: (text: string, type?: string) => void,
  sendProgress: (current: number, total: number) => void
): Promise<{
  success: boolean
  enviados: number
  total: number
  falhas: any[]
  error?: string
}> {
  try {
    const fotosDir = path.dirname(csvPath)
    const base = getClientBase(useHomolog)

    if (!rows || rows.length === 0) {
      return {
        success: false,
        enviados: 0,
        total: 0,
        falhas: [],
        error: 'CSV vazio ou sem linhas válidas.',
      }
    }

    const technology = pSurface === 'internal' ? 'Arthbot' : 'Arthdrone'
    const payload: any[] = []
    const rowsByBasename: Record<string, any> = {}

    for (const row of rows) {
      const rowUuid = crypto.randomUUID()
      const normalizedRelPath = (row.image_id || '').replace(/\\/g, '/')
      const baseName = path.basename(normalizedRelPath)
      rowsByBasename[baseName] = row
      const caminhoFoto = path.join(fotosDir, ...normalizedRelPath.split('/'))

      let width = 0,
        height = 0
      try {
        const dims = lerDimensoesJpeg(caminhoFoto)
        width = dims.width
        height = dims.height
      } catch {
        // use 0, 0
      }

      const is360 = detectarSeFoto360(caminhoFoto)
      const itemPayload: any = {
        type: 'image/jpeg',
        originalFilename: baseName,
        location: row.distance_to_hub || '0',
        name: rowUuid,
        region: row.region || '',
        serial: row.blade || '',
        windblade_id: parseInt(windbladeId, 10),
        workorder_id: workorderId,
        width: width,
        height: height,
        date_image: collectDate,
        pixelSize: row.mm_px || '0.0',
        technology: technology,
        upload_source: 'Office',
      }
      if (is360) {
        itemPayload['is_360'] = true
      }
      payload.push(itemPayload)
    }

    sendLog(`Solicitando ${payload.length} URLs pré-assinadas...`, 'info')

    const presignResp = await fetch(`${base}get-presign-urls-incremental`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload),
    })
    if (!presignResp.ok)
      throw new Error(
        `HTTP ${presignResp.status} on get-presign-urls-incremental`
      )
    const presigns = (await presignResp.json()) as any[]

    if (!presigns || presigns.length === 0) {
      return {
        success: false,
        enviados: 0,
        total: 0,
        falhas: [],
        error:
          'Nenhuma foto retornada pelo servidor (já enviadas, ou nada a enviar).',
      }
    }

    await fetch(`${base}save-collect-date`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        workorder_id: workorderId,
        collect_date: collectDate,
        turbine_id: turbineId,
        windblade_id: parseInt(windbladeId, 10),
      }),
    })

    const total = presigns.length
    const falhas: any[] = []
    const enviadosQueue: any[] = []
    let completed = 0

    async function uploadOne(item: any): Promise<void> {
      const row = rowsByBasename[item.originalFilename]
      const rawLocalName = (row ? row.image_id : item.originalFilename) || ''
      const normalizedLocalName = rawLocalName.replace(/\\/g, '/')
      const localPath = path.join(fotosDir, ...normalizedLocalName.split('/'))

      try {
        const fileData = fs.readFileSync(localPath)
        const putResp = await fetch(item.url, {
          method: 'PUT',
          body: fileData,
          headers: {
            'Content-Type': 'image/jpeg',
            'Content-Disposition': 'inline',
          },
        })
        if (!putResp.ok) throw new Error(`PUT falhou (${putResp.status})`)

        enviadosQueue.push({
          serial: item.serial,
          workorder_id: workorderId,
          windblade_id: parseInt(windbladeId, 10),
        })
      } catch (e: any) {
        falhas.push({ arquivo: normalizedLocalName, erro: e.message })
        sendLog(`Falha ao enviar ${normalizedLocalName}: ${e.message}`, 'error')
      } finally {
        completed++
        sendProgress(completed, total)
      }
    }

    // Pool de concorrência limitada: antes cada PUT esperava o anterior terminar (1 por
    // vez), o que deixava o tempo total dominado pela latência de rede por requisição em
    // vez do throughput real da conexão — pra centenas de fotos isso soma minutos. O
    // Image Uploader oficial usa a mesma API mas sobe várias fotos ao mesmo tempo; 6
    // workers é um valor conservador que não deve estourar limite de conexões do storage.
    const CONCURRENCY = 6
    let nextIndex = 0
    async function worker(): Promise<void> {
      while (nextIndex < presigns.length) {
        const item = presigns[nextIndex++]
        await uploadOne(item)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, presigns.length) }, () =>
        worker()
      )
    )

    const enviados = enviadosQueue.length

    // Batching pro update de fila igual antes (grupos de 30) — só que agora depois que o
    // pool termina, em vez de durante, já que várias uploads concluindo ao mesmo tempo
    // tornaria o corte "a cada 30" da versão sequencial não-determinístico/arriscado de
    // duplicar envio.
    for (let i = 0; i < enviadosQueue.length; i += 30) {
      await fetch(`${base}update-galleries-urls-queue`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(enviadosQueue.slice(i, i + 30)),
      })
    }

    sendLog(
      `Upload concluído: ${enviados}/${total} fotos enviadas.`,
      falhas.length === 0 ? 'success' : 'warn'
    )
    return { success: true, enviados, total, falhas }
  } catch (err: any) {
    sendLog(`Erro no upload: ${err.message}`, 'error')
    return {
      success: false,
      enviados: 0,
      total: 0,
      falhas: [],
      error: err.message,
    }
  }
}

export async function uploadMultiplasCsv(
  csvPaths: string[],
  workorderId: string,
  pSurface: string,
  collectDate: string,
  useHomolog = false,
  webContents?: any,
  manualOverrides: Record<string, string> = {}
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }
  const sendProgress = (current: number, total: number) => {
    if (webContents) webContents.send('arthprogress', { current, total })
  }
  const sendFileProgress = (
    fileIndex: number,
    fileTotal: number,
    fileName: string
  ) => {
    if (webContents)
      webContents.send('arthnex_batch_progress', {
        fileIndex,
        fileTotal,
        fileName,
      })
  }

  const resultados: any[] = []
  let totalEnviados = 0
  let totalFotos = 0
  let arquivosComFalha = 0

  try {
    sendLog(
      `Buscando pás pendentes da workorder para casar com os CSVs...`,
      'info'
    )
    const blades = await listarPasPendentes(workorderId, useHomolog)

    for (let i = 0; i < csvPaths.length; i++) {
      const csvPath = csvPaths[i]
      const fileName = path.basename(csvPath)
      sendFileProgress(i + 1, csvPaths.length, fileName)
      sendLog(
        `\n=== Arquivo ${i + 1}/${csvPaths.length}: ${fileName} ===`,
        'info'
      )

      let rows: Record<string, string>[]
      try {
        rows = await lerCsv(csvPath)
      } catch (e: any) {
        sendLog(`Falha ao ler ${fileName}: ${e.message}`, 'error')
        resultados.push({ arquivo: fileName, success: false, error: e.message })
        arquivosComFalha++
        continue
      }

      let matched: any = null

      // 1. Checagem de Override Manual explícito
      const manualWindbladeId = manualOverrides[csvPath]
      if (manualWindbladeId) {
        matched = blades.find(b => String(b.id) === String(manualWindbladeId))
        if (matched) {
          sendLog(
            `   Pá selecionada manualmente ➔ Turbina: ${matched.turbine} | Pá: ${matched.blade}`,
            'info'
          )
        }
      }

      // 2. Auto-Match Inteligente Multi-Nível
      if (!matched) {
        const csvBladeRaw = rows[0]?.blade || ''
        let csvTurbineRaw = rows[0]?.turbine || ''

        if (!csvTurbineRaw) {
          csvTurbineRaw = inferirTurbinaDoCaminho(csvPath, blades)
        }

        // Nível 1: Match por Turbina E Pá
        const matchesNivel1 = blades.filter(b => {
          const bladeOk = bladesCombinam(csvBladeRaw, b.blade)
          const turbineOk = turbinasCombinam(csvTurbineRaw, b.turbine)
          return bladeOk && turbineOk
        })

        if (matchesNivel1.length === 1) {
          matched = matchesNivel1[0]
          sendLog(
            `   Match automático (Turbina+Pá): ${csvBladeRaw} / ${csvTurbineRaw} ➔ Turbina: ${matched.turbine} | Pá: ${matched.blade}`,
            'info'
          )
        } else if (matchesNivel1.length > 1) {
          matched = matchesNivel1[0]
          sendLog(
            `   ⚠ Múltiplas pás encontradas para Turbina+Pá. Selecionado: Turbina: ${matched.turbine} | Pá: ${matched.blade}`,
            'warning'
          )
        } else {
          // Nível 2: Match por Serial Único em toda a Workorder
          const matchesNivel2 = blades.filter(b =>
            bladesCombinam(csvBladeRaw, b.blade)
          )
          if (matchesNivel2.length === 1) {
            matched = matchesNivel2[0]
            sendLog(
              `   Match por Serial Único: ${csvBladeRaw} ➔ Turbina: ${matched.turbine} | Pá: ${matched.blade}`,
              'info'
            )
          } else if (matchesNivel2.length > 1) {
            sendLog(
              `⚠ Ambiguidade Crítica no arquivo '${fileName}': A pá '${csvBladeRaw}' existe em ${matchesNivel2.length} turbinas da Workorder, porém a turbina '${csvTurbineRaw || '(não informada)'}' não bateu com nenhuma. Envio cancelado para evitar erro!`,
              'error'
            )
            resultados.push({
              arquivo: fileName,
              success: false,
              error: `Ambiguidade: Pá '${csvBladeRaw}' existe em várias turbinas e turbina '${csvTurbineRaw}' não coincidiu.`,
            })
            arquivosComFalha++
            continue
          }
        }
      }

      if (!matched) {
        const bladeLabel = rows[0]?.blade || '(vazio)'
        sendLog(
          `⚠ Pá '${bladeLabel}' do CSV '${fileName}' não foi encontrada entre as pás pendentes desta workorder. Pulando...`,
          'warning'
        )
        resultados.push({
          arquivo: fileName,
          success: false,
          error: `Pá '${bladeLabel}' não encontrada na workorder`,
        })
        arquivosComFalha++
        continue
      }

      const r = await processarUploadCsv(
        csvPath,
        rows,
        workorderId,
        String(matched.id),
        pSurface,
        collectDate,
        String(matched.turbine_id),
        useHomolog,
        sendLog,
        sendProgress
      )

      resultados.push({
        arquivo: fileName,
        blade: matched.blade,
        turbine: matched.turbine,
        ...r,
      })
      if (r.success) {
        totalEnviados += r.enviados
        totalFotos += r.total
        if (r.falhas.length > 0) arquivosComFalha++
      } else {
        arquivosComFalha++
      }
    }

    sendLog(`\n=== LOTE FINALIZADO ===`, 'info')
    sendLog(
      `Arquivos processados: ${csvPaths.length}, com falha: ${arquivosComFalha}`,
      arquivosComFalha === 0 ? 'success' : 'warn'
    )
    sendLog(
      `Total de fotos enviadas: ${totalEnviados}/${totalFotos}`,
      'success'
    )

    return {
      success: true,
      resultados,
      totalEnviados,
      totalFotos,
      arquivosComFalha,
    }
  } catch (err: any) {
    sendLog(`Erro crítico no upload em lote: ${err.message}`, 'error')
    return { success: false, error: err.message, resultados }
  }
}

export async function analisarAmbiguidadesCsvs(
  csvPaths: string[],
  blades: any[]
): Promise<
  Record<
    string,
    {
      status: 'matched' | 'ambiguous' | 'no_match' | 'empty'
      bladeRaw: string
      turbineRaw: string
      matched?: any
      candidateBlades?: any[]
    }
  >
> {
  const analysis: Record<string, any> = {}
  for (const csvPath of csvPaths) {
    try {
      const rows = await lerCsv(csvPath)
      if (!rows || rows.length === 0) {
        analysis[csvPath] = { status: 'empty', bladeRaw: '', turbineRaw: '' }
        continue
      }
      const csvBladeRaw = rows[0]?.blade || ''
      let csvTurbineRaw = rows[0]?.turbine || ''
      if (!csvTurbineRaw) {
        csvTurbineRaw = inferirTurbinaDoCaminho(csvPath, blades)
      }

      const matchesNivel1 = blades.filter(b => {
        const bladeOk = bladesCombinam(csvBladeRaw, b.blade)
        const turbineOk = turbinasCombinam(csvTurbineRaw, b.turbine)
        return bladeOk && turbineOk
      })

      if (matchesNivel1.length === 1) {
        analysis[csvPath] = {
          status: 'matched',
          bladeRaw: csvBladeRaw,
          turbineRaw: csvTurbineRaw,
          matched: matchesNivel1[0],
        }
        continue
      }

      const matchesNivel2 = blades.filter(b =>
        bladesCombinam(csvBladeRaw, b.blade)
      )
      if (matchesNivel2.length === 1) {
        analysis[csvPath] = {
          status: 'matched',
          bladeRaw: csvBladeRaw,
          turbineRaw: csvTurbineRaw,
          matched: matchesNivel2[0],
        }
      } else if (matchesNivel2.length > 1) {
        analysis[csvPath] = {
          status: 'ambiguous',
          bladeRaw: csvBladeRaw,
          turbineRaw: csvTurbineRaw,
          candidateBlades: matchesNivel2.map(b => ({
            id: String(b.id),
            blade: b.blade,
            turbine: b.turbine,
          })),
        }
      } else {
        analysis[csvPath] = {
          status: 'no_match',
          bladeRaw: csvBladeRaw,
          turbineRaw: csvTurbineRaw,
        }
      }
    } catch {
      analysis[csvPath] = { status: 'empty', bladeRaw: '', turbineRaw: '' }
    }
  }
  return analysis
}
