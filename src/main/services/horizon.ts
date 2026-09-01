import fs from 'fs'
import path from 'path'
import JSZip from 'jszip'
import { parseDate } from './workflow'

// ─── Constants and Interfaces ──────────────────────────────────────────────────

export const INSPECTION_TYPES_VALIDOS = [
  'Autonomous Drone',
  'Blade External Other',
  'Blade Internal',
  'Gearbox Borescope',
  'Generic',
  'Ground Photo',
  'Manual Drone',
  'Rope Inspection',
  'Tower External',
  'Transition Piece',
]

export interface ValidationResult {
  success: boolean
  is_valid: boolean
  extras: string[]
  faltantes: string[]
  suggestions: Record<string, { suggestion: string; score: number }>
  auto_matches: Record<string, string>
  turbinas_horizon: number
  turbinas_atw: number
  turbinas_hor_list: string[]
  turbinas_atw_list: string[]
  n_duplicatas: number
}

export interface RequirementsResult {
  is_valid: boolean
  errors: string[]
  warnings: string[]
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

function cleanFilename(name: string): string {
  if (!name) return ''
  return path.basename(String(name).trim().replace(/['"]/g, '')).toLowerCase()
}

function loadCsvRobust(content: string, isDamage = false): any[] | null {
  try {
    const lines = content
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
    if (lines.length === 0) return null

    const firstLine = lines[0]
    const sep = isDamage
      ? ','
      : firstLine.split(';').length > firstLine.split(',').length
        ? ';'
        : ','
    const headers = firstLine.split(sep).map(h => h.trim().replace(/['"]/g, ''))

    const data: any[] = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      let parts = line.split(sep)
      if (isDamage && parts.length > headers.length) {
        const fixed = parts.slice(0, headers.length - 1)
        let coords = parts
          .slice(headers.length - 1)
          .join(',')
          .trim()
          .replace(/['"]/g, '')
        if (coords.startsWith('[[') && coords.endsWith(']]')) {
          coords = coords.substring(1, coords.length - 1)
        }
        fixed.push(coords)
        parts = fixed
      } else {
        parts = parts
          .slice(0, headers.length)
          .map(p => p.trim().replace(/['"]/g, ''))
      }

      const obj: any = {}
      headers.forEach((h, idx) => {
        obj[h] = parts[idx] || ''
      })
      data.push(obj)
    }
    return data
  } catch {
    return null
  }
}

function loadHorizonBase(content: string): any[] | null {
  try {
    const lines = content
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
    if (lines.length === 0) return null

    const headerLine = lines[0]
    const sep =
      headerLine.split(';').length > headerLine.split(',').length ? ';' : ','
    const headers = headerLine
      .split(sep)
      .map(h => h.trim().replace(/['"]/g, ''))

    const skipKeywords = [
      'delete this row',
      'explanation:',
      'valid data options',
    ]
    const data: any[] = []

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      const firstField = line
        .split(sep)[0]
        .trim()
        .replace(/['"]/g, '')
        .toLowerCase()
      if (skipKeywords.some(kw => firstField.includes(kw))) {
        continue
      }
      const parts = line
        .split(sep)
        .slice(0, headers.length)
        .map(p => p.trim().replace(/['"]/g, ''))

      const obj: any = {}
      headers.forEach((h, idx) => {
        if (h !== 'Notes') {
          obj[h] = parts[idx] || ''
        }
      })

      const hasValue = Object.values(obj).some(val => String(val).trim() !== '')
      if (hasValue) {
        data.push(obj)
      }
    }
    return data
  } catch {
    return null
  }
}

function mergeHorizonBases(paths: string[]): any[] | null {
  const dfs: any[] = []
  for (const p of paths) {
    if (!fs.existsSync(p)) continue
    const content = fs.readFileSync(p, 'utf-8')
    const df = loadHorizonBase(content)
    if (df && df.length > 0) {
      dfs.push(...df)
    }
  }
  if (dfs.length === 0) return null

  const seen = new Set<string>()
  const result: any[] = []
  dfs.forEach(row => {
    const t = String(row.Turbine || '').trim()
    if (!seen.has(t)) {
      seen.add(t)
      result.push(row)
    }
  })
  return result
}

function mergeAtwSummariesFromContents(contents: string[]): any[] | null {
  const dfs: any[] = []
  for (const content of contents) {
    const df = loadCsvRobust(content)
    if (df && df.length > 0) {
      dfs.push(...df)
    }
  }
  if (dfs.length === 0) return null

  const seen = new Set<string>()
  const result: any[] = []
  dfs.forEach(row => {
    const t = String(row.Turbine || '').trim()
    if (!seen.has(t)) {
      seen.add(t)
      result.push(row)
    }
  })
  return result
}

function mergeAtwSummaries(paths: string[]): any[] | null {
  const contents = paths
    .filter(p => fs.existsSync(p))
    .map(p => fs.readFileSync(p, 'utf-8'))
  return mergeAtwSummariesFromContents(contents)
}

function deduplicateAtw(df: any[]): { df: any[]; n_duplicatas: number } {
  if (!df || df.length === 0) return { df: [], n_duplicatas: 0 }
  const seen = new Set<string>()
  const result: any[] = []
  df.forEach(row => {
    const t = String(row.Turbine || '').trim()
    if (!seen.has(t)) {
      seen.add(t)
      result.push(row)
    }
  })
  return { df: result, n_duplicatas: df.length - result.length }
}

// Normaliza nome de turbina para auto-match exato. Remove s\u00f3 separadores
// (espa\u00e7o, h\u00edfen, underscore) \u2014 N\u00c3O remove zeros internos, pra evitar falso
// positivo (ex: OIT01-02 \u2260 OIT10-02).
function normalizar(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[-_\s]/g, '')
}

// Normaliza\u00e7\u00e3o profunda s\u00f3 pra scoring fuzzy (SequenceMatcher/suggestTurbineMatch):
// remove separadores E zeros \u00e0 esquerda em cada sequ\u00eancia de d\u00edgitos.
function normalizarFuzzy(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[-_\s]/g, '')
    .replace(/0+(\d)/g, '$1')
}

function getLcsLength(s1: string, s2: string): number {
  const m = s1.length
  const n = s2.length
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }
  return dp[m][n]
}

function sequenceMatcherRatio(s1: string, s2: string): number {
  if (!s1 || !s2) return 0
  const lcs = getLcsLength(s1, s2)
  return (2.0 * lcs) / (s1.length + s2.length)
}

function suggestTurbineMatch(
  nomeHorizon: string,
  opcoesAtw: string[]
): [string, number] {
  const nomeNorm = normalizarFuzzy(nomeHorizon)
  let melhorScore = -1.0
  let melhorOpcao = opcoesAtw.length > 0 ? opcoesAtw[0] : ''

  for (const opcao of opcoesAtw) {
    const score = sequenceMatcherRatio(nomeNorm, normalizarFuzzy(opcao))
    if (score > melhorScore) {
      melhorScore = score
      melhorOpcao = opcao
    }
  }
  return [melhorOpcao, melhorScore]
}

function parseDateFlexible(val: any): Date | null {
  if (
    !val ||
    ['nan', 'nat', 'none', 'null'].includes(String(val).trim().toLowerCase())
  ) {
    return null
  }
  const s = String(val).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  const parts = s.split('/')
  if (parts.length === 3 && !isNaN(Number(parts[0])) && Number(parts[0]) > 12) {
    const [d, m, y] = parts.map(Number)
    return new Date(y, m - 1, d)
  }
  return parseDate(s)
}

function formatDateIso(val: any): string {
  const d = parseDateFlexible(val)
  if (!d || isNaN(d.getTime())) {
    return String(val || '').trim()
  }
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function toCsv(data: any[], delimiter = ','): string {
  if (data.length === 0) return ''
  const headers = Object.keys(data[0])
  const csvLines = [headers.join(delimiter)]
  data.forEach(row => {
    const line = headers
      .map(h => {
        let val = String(row[h] || '')
        if (
          val.includes(delimiter) ||
          val.includes('"') ||
          val.includes('\n')
        ) {
          val = `"${val.replace(/"/g, '""')}"`
        }
        return val
      })
      .join(delimiter)
    csvLines.push(line)
  })
  return csvLines.join('\r\n')
}

function toDamageCsv(data: any[]): string {
  if (data.length === 0) return ''
  const csvLines = [SKYSPECS_COLUMNS.join(',')]
  data.forEach(row => {
    const line = SKYSPECS_COLUMNS.map(c => {
      let val = String(row[c] ?? '')
        .trim()
        .replace(/^"|"$/g, '')
        .replace(/^'|'$/g, '')
      if (c === 'Coordinates') {
        return `"${val}"`
      }
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`
      }
      return val
    }).join(',')
    csvLines.push(line)
  })
  return csvLines.join('\r\n')
}

interface MappingEntry {
  Component: string
  Material: string
  Type: string
  Subtype: string
  _is_checkpoint?: boolean
  _subtype_by_severity?: Record<string, string>
  _flag_severity?: string[]
  alternativas?: { Subtype: string }[]
}

const HORIZON_MAPPING: Record<string, MappingEntry> = {
  // --- SURFACE ---
  'contaminated layer': {
    Component: 'Blade',
    Material: 'Surface',
    Type: 'Discoloration',
    Subtype: 'Other',
  },
  'dirt /contamination': {
    Component: 'Blade',
    Material: 'Surface',
    Type: 'Discoloration',
    Subtype: 'Mechanical (Oil)',
  },
  dirt: {
    Component: 'Blade',
    Material: 'Surface',
    Type: 'Discoloration',
    Subtype: 'Mechanical (Oil)',
  },
  oxidation: {
    Component: 'Blade',
    Material: 'Surface',
    Type: 'Discoloration',
    Subtype: 'Other',
  },
  fungi: {
    Component: 'Blade',
    Material: 'Surface',
    Type: 'Discoloration',
    Subtype: 'Other',
  },
  depression: {
    Component: 'Blade',
    Material: 'Surface',
    Type: 'None',
    Subtype: 'None',
  },
  'resin excess': {
    Component: 'Blade',
    Material: 'Surface',
    Type: 'None',
    Subtype: 'None',
  },
  'foreign object': {
    Component: 'Blade',
    Material: 'Surface',
    Type: 'Foreign Object',
    Subtype: 'None',
  },
  gap: {
    Component: 'Blade',
    Material: 'Surface',
    Type: 'Core Gap',
    Subtype: 'None',
  },
  'step in upstand': {
    Component: 'Blade',
    Material: 'Surface',
    Type: 'Delamination',
    Subtype: 'Wrinkle',
  },

  // --- LAMINATE ---
  bubbles: {
    Component: 'Blade',
    Material: 'Laminate',
    Type: 'Air Inclusion',
    Subtype: 'Other',
  },
  microbubbles: {
    Component: 'Blade',
    Material: 'Laminate',
    Type: 'Air Inclusion',
    Subtype: 'Other',
  },
  'semi dry glass': {
    Component: 'Blade',
    Material: 'Laminate',
    Type: 'Delamination',
    Subtype: 'Dry Glass',
  },
  'dry glass': {
    Component: 'Blade',
    Material: 'Laminate',
    Type: 'Delamination',
    Subtype: 'Dry Glass',
  },
  wrinkle: {
    Component: 'Blade',
    Material: 'Laminate',
    Type: 'Delamination',
    Subtype: 'Wrinkle',
  },
  step: {
    Component: 'Blade',
    Material: 'Laminate',
    Type: 'Delamination',
    Subtype: 'Wrinkle',
  },
  'folded layer': {
    Component: 'Blade',
    Material: 'Laminate',
    Type: 'Delamination',
    Subtype: 'Wrinkle',
  },
  'damaged layer': {
    Component: 'Blade',
    Material: 'Laminate',
    Type: 'Delamination',
    Subtype: 'None',
  },
  'damaged laminate': {
    Component: 'Blade',
    Material: 'Laminate',
    Type: 'Delamination',
    Subtype: 'None',
  },
  'improper repair': {
    Component: 'Blade',
    Material: 'Laminate',
    Type: 'Delamination',
    Subtype: 'Old Repair',
  },

  // --- STRUCTURE ---
  delamination: {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Delamination',
    Subtype: 'None',
  },
  'root upstand delamination': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Delamination',
    Subtype: 'None',
  },
  'missing layer': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Delamination',
    Subtype: 'None',
  },
  'holes in laminate': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Delamination',
    Subtype: 'None',
  },
  'lightning strike': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Delamination',
    Subtype: 'Lightning',
  },
  'crack in the laminate': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Crack',
    Subtype: 'T-l-c Shaped',
  },
  'crack in the laminate longitudinal': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Crack',
    Subtype: 'Longitudinal',
  },
  'crack in the laminate transversal': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Crack',
    Subtype: 'Transverse',
  },
  'te insert crack': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Crack',
    Subtype: 'Longitudinal',
  },
  'crack around receptor': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Crack',
    Subtype: 'Longitudinal',
  },
  'core contamination': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Balsa Rot',
    Subtype: 'None',
  },
  'core material damaged': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Balsa Rot',
    Subtype: 'None',
  },
  'damaged core': {
    Component: 'Blade',
    Material: 'Structure',
    Type: 'Balsa Rot',
    Subtype: 'None',
  },

  // --- BONDLINE ---
  'bonding paste failure': {
    Component: 'Blade',
    Material: 'Bondline',
    Type: 'Bondline Failure',
    Subtype: 'None',
  },
  'crack in the bonding line': {
    Component: 'Blade',
    Material: 'Bondline',
    Type: 'Crack',
    Subtype: 'Transverse',
    alternativas: [{ Subtype: 'Longitudinal' }],
  },

  // --- LPS ---
  'lps disconnected/damaged': {
    Component: 'Lightning Protection System',
    Material: 'Auxiliary Component',
    Type: 'LPS Cable',
    Subtype: 'None',
    _subtype_by_severity: { '2': 'None', '4': 'Disconnected' },
    _flag_severity: ['3'],
  },
  'absence of the lps card': {
    Component: 'Lightning Protection System',
    Material: 'Auxiliary Component',
    Type: 'LPS Cable',
    Subtype: 'None',
  },
  'lps connections': {
    Component: 'Lightning Protection System',
    Material: 'Auxiliary Component',
    Type: 'Lug Connector',
    Subtype: 'Disconnected',
  },
  'lps receptor missing': {
    Component: 'Lightning Receptors',
    Material: 'Auxiliary Component',
    Type: 'Missing',
    Subtype: 'None',
  },
  'metallic tip missing': {
    Component: 'Lightning Receptors',
    Material: 'Auxiliary Component',
    Type: 'Missing',
    Subtype: 'None',
  },
  'check lps receptor': {
    Component: 'Other',
    Material: 'Auxiliary Component',
    Type: 'Other',
    Subtype: 'None',
  },

  // --- ROOT / CLOSEOUT ---
  'close out sealant damaged': {
    Component: 'Root Closeout',
    Material: 'Auxiliary Component',
    Type: 'Circumference Debonding',
    Subtype: 'None',
  },
  'absence of close out cover': {
    Component: 'Root Closeout',
    Material: 'Auxiliary Component',
    Type: 'Damaged Or Misaligned',
    Subtype: 'None',
  },

  // --- PITCH SYSTEM ---
  'gap in the root insert': {
    Component: 'Pitch System',
    Material: 'Auxiliary Component',
    Type: 'Bolts',
    Subtype: 'None',
  },
  'missing stud': {
    Component: 'Pitch System',
    Material: 'Auxiliary Component',
    Type: 'Bolts',
    Subtype: 'None',
  },

  // --- SEALS / DRAINAGE ---
  'sealant damaged': {
    Component: 'Seals',
    Material: 'Auxiliary Component',
    Type: 'None',
    Subtype: 'None',
  },
  'drain hole obstructed': {
    Component: 'Drainage System',
    Material: 'Auxiliary Component',
    Type: 'Damaged Or Obstructed',
    Subtype: 'None',
  },

  // --- HUB ---
  'damaged studs': {
    Component: 'Hub',
    Material: 'Auxiliary Component',
    Type: 'Other',
    Subtype: 'None',
  },

  // --- OTHER ---
  'damaged accessory': {
    Component: 'Other',
    Material: 'Auxiliary Component',
    Type: 'Other',
    Subtype: 'None',
  },

  // --- CHECK POINTS (excluídos do output) ---
  'check point': {
    Component: 'Other',
    Material: 'Auxiliary Component',
    Type: 'Other',
    Subtype: 'None',
    _is_checkpoint: true,
  },
  'check close poi': {
    Component: 'Other',
    Material: 'Auxiliary Component',
    Type: 'Other',
    Subtype: 'None',
    _is_checkpoint: true,
  },
  'check damage': {
    Component: 'Other',
    Material: 'Auxiliary Component',
    Type: 'Other',
    Subtype: 'None',
    _is_checkpoint: true,
  },
  'check delete': {
    Component: 'Other',
    Material: 'Auxiliary Component',
    Type: 'Other',
    Subtype: 'None',
    _is_checkpoint: true,
  },
  'check repair done': {
    Component: 'Other',
    Material: 'Auxiliary Component',
    Type: 'Other',
    Subtype: 'None',
    _is_checkpoint: true,
  },
}

export const SKYSPECS_COLUMNS = [
  'Photo File Name',
  'Date',
  'Component',
  'Material',
  'Type',
  'Subtype',
  'Damage Location',
  'Blade Side',
  'Severity',
  'Width (m)',
  'Length (m)',
  'Distance (m)',
  'Coordinates',
]

function cleanParentheses(str: string): string {
  if (!str) return ''
  const cleaned = String(str)
    .replace(/\s*\([^)]*\)/g, '')
    .trim()
  return cleaned === 'None' ? '' : cleaned
}

function remapSeverity(
  skyType: string,
  skyMaterial: string,
  sevStr: string,
  widthStr: string,
  subtype = ''
): [string, string] {
  const sev = parseInt(sevStr, 10)
  if (isNaN(sev)) {
    return [sevStr, '']
  }

  // Discoloration Mec.Oil → sempre Sev 2, inclusive quando sev original é 0
  if (
    skyType === 'Discoloration' &&
    (subtype.includes('Mechanical') || subtype.includes('Oil'))
  ) {
    if (sev !== 2) {
      return ['2', `Sev convertida Discoloration Mec.Oil: ${sev}➔2`]
    }
    return [sevStr, '']
  }

  if (sev === 0) {
    return [sevStr, '']
  }

  if (skyType === 'Bondline Failure') {
    const wCm = parseFloat(widthStr) * 100
    if (isNaN(wCm)) {
      return [sevStr, 'ALERTA: largura inválida para Bondline Failure']
    }
    const newSev = wCm <= 25 ? 4 : 5
    return [
      String(newSev),
      `Sev recalculada por largura (${wCm.toFixed(1)}cm): ${sev}➔${newSev}`,
    ]
  }

  if (skyType === 'Delamination') {
    if (sev === 2) {
      return ['3', 'Sev convertida Delamination: 2➔3']
    }
    return [sevStr, '']
  }

  if (skyType === 'Crack' && skyMaterial === 'Structure') {
    const remap: Record<number, number> = { 3: 4, 4: 4, 5: 5 }
    if (sev in remap) {
      const newSev = remap[sev]
      const nota =
        newSev !== sev ? `Sev convertida Crack: ${sev}➔${newSev}` : ''
      return [String(newSev), nota]
    }
    return [sevStr, '']
  }

  return [sevStr, '']
}

interface DmgConversionResult {
  convertedRows: any[]
  flags: any[]
}

function convertDamagesDf(df: any[], filename: string): DmgConversionResult {
  const convertedRows: any[] = []
  const flags: any[] = []

  // Coluna de superfície (Internal/External)
  const surfaceCol = Object.keys(df[0] || {}).find(c => {
    const l = c.toLowerCase()
    return (
      l.includes('surface') || l.includes('internal') || l.includes('external')
    )
  })

  df.forEach(row => {
    const arthwindType = String(row['Type'] || '').trim()
    const key = arthwindType.toLowerCase()
    const mapEntry = HORIZON_MAPPING[key]
    let flag = ''
    let isCheckpoint = false

    let component = ''
    let material = ''
    let skyType = ''
    let subtypeOut = ''
    const severityOrig = String(row['Severity'] || '').trim()

    if (mapEntry) {
      component = mapEntry.Component
      material = mapEntry.Material
      skyType = mapEntry.Type
      let subtype = mapEntry.Subtype
      isCheckpoint = !!mapEntry._is_checkpoint

      if (mapEntry._subtype_by_severity) {
        const sevMap = mapEntry._subtype_by_severity
        const flagSevs = mapEntry._flag_severity || []
        if (severityOrig in sevMap) {
          subtype = sevMap[severityOrig]
          if (flagSevs.includes(severityOrig)) {
            flag = `ALERTA: Sev ${severityOrig} — subtype ambíguo, revisar manualmente`
          }
        } else {
          flag = `ALERTA: LPS Sev ${severityOrig} sem regra definida — subtype padrão aplicado`
        }
      }

      subtypeOut = subtype || ''

      if (mapEntry.alternativas) {
        const altList = mapEntry.alternativas.map(a => a.Subtype)
        flag = `ALERTA: Subtype ambíguo — alternativas: ${altList.join(', ')}`
      }
    } else {
      // Tipo não cadastrado no MAPPING → cai automaticamente no bucket "Other" da SkySpecs
      component = 'Other'
      material = 'Auxiliary Component'
      skyType = 'Other'
      subtypeOut = 'None'
      flag = `ALERTA: Tipo '${arthwindType}' não encontrado no mapeamento — conversão de nomenclatura automática para Other/Other. Revisar manualmente.`
    }

    if (severityOrig === '0' && !isCheckpoint) {
      flag =
        (flag ? flag + ' | ' : '') +
        'ALERTA: Severidade 0 em registro que não é Check Point'
    }

    const widthStr = String(row['Width'] || '0')
    const [severityFinal, sevNota] = remapSeverity(
      skyType,
      material,
      severityOrig,
      widthStr,
      subtypeOut
    )
    if (sevNota) {
      flag = (flag ? flag + ' | ' : '') + sevNota
    }

    if (isCheckpoint) {
      return
    }

    const rawSurface = surfaceCol
      ? String(row[surfaceCol] || '')
          .trim()
          .toLowerCase()
      : ''
    const damageLocation = rawSurface === 'external' ? 'External' : 'Internal'

    const finalSkyType = cleanParentheses(skyType)
    const finalSubtype = cleanParentheses(subtypeOut)

    if (flag) {
      flags.push({
        Arquivo: filename,
        Foto: String(row['Photo File Name'] || ''),
        'Tipo original': arthwindType,
        'Component (novo)': component,
        'Material (novo)': material,
        'Type (novo)': finalSkyType,
        'Subtype (novo)': finalSubtype,
        'Severity (novo)': severityFinal,
        FLAG: flag,
      })
    }

    convertedRows.push({
      'Photo File Name': String(row['Photo File Name'] || ''),
      Date: formatDateIso(row['Date'] || row['Inspection Date'] || ''),
      Component: component,
      Material: material,
      Type: finalSkyType,
      Subtype: finalSubtype,
      'Damage Location': damageLocation,
      'Blade Side': String(row['Blade Side'] || ''),
      Severity: severityFinal,
      'Width (m)': widthStr,
      'Length (m)': String(row['Length'] || ''),
      'Distance (m)': String(row['Distance'] || ''),
      Coordinates: String(row['Coordinates'] || '').replace(/\s+/g, ''),
    })
  })

  return { convertedRows, flags }
}

// ─── Core Services ───────────────────────────────────────────────────────────

export async function horizonAnalisar(
  horizonPaths: string[],
  atwPaths: string[]
): Promise<any> {
  try {
    const dfHor = mergeHorizonBases(horizonPaths)
    const dfAtwRaw = mergeAtwSummaries(atwPaths)

    if (!dfHor || !dfAtwRaw) {
      return { success: false, error: 'Falha ao carregar ficheiros CSV.' }
    }

    const { df: dfAtw, n_duplicatas: nDup } = deduplicateAtw(dfAtwRaw)

    // Se atwPaths[0] existe, busca arquivos adicionais no mesmo diretório para avisar se houver inconsistência

    const result = validateNomenclature(dfHor, dfAtw, {}, [], [], nDup)
    return result
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

export function validateNomenclature(
  dfHor: any[],
  dfAtw: any[],
  vinculosConfirmados: Record<string, string> = {},
  turbinasRemovidas: string[] = [],
  turbinasHorizonRemovidas: string[] = [],
  nDuplicatas = 0
): ValidationResult {
  const vinculos = vinculosConfirmados
  const removidas = new Set(turbinasRemovidas)
  const horRemovidas = new Set(turbinasHorizonRemovidas)

  const turbinasAtwList = Array.from(
    new Set(dfAtw.map(row => String(row.Turbine || '').trim()).filter(Boolean))
  ).sort()

  const turbinasHorList = Array.from(
    new Set(dfHor.map(row => String(row.Turbine || '').trim()).filter(Boolean))
  ).sort()

  const setAtw = new Set(turbinasAtwList)
  const setHor = new Set(turbinasHorList)

  const setHorMapeado = new Set(Object.values(vinculos))
  const setHorVincKey = new Set(Object.keys(vinculos))

  const exactAtw = new Set([...setAtw].filter(x => setHor.has(x)))
  const remainingHor = [...setHor].filter(
    x => !exactAtw.has(x) && !setHorVincKey.has(x)
  )
  const remainingAtw = [...setAtw].filter(
    x => !exactAtw.has(x) && !setHorMapeado.has(x)
  )

  const atwNormMap: Record<string, string> = {}
  remainingAtw.forEach(t => {
    const nt = normalizar(t)
    if (!atwNormMap[nt]) {
      atwNormMap[nt] = t
    }
  })

  const autoMatches: Record<string, string> = {}
  const matchedAtwNorm = new Set<string>()
  remainingHor.sort().forEach(th => {
    const nh = normalizar(th)
    if (atwNormMap[nh] && !matchedAtwNorm.has(nh)) {
      autoMatches[th] = atwNormMap[nh]
      matchedAtwNorm.add(nh)
    }
  })

  const setHorResolvido = new Set([
    ...setHorVincKey,
    ...Object.keys(autoMatches),
  ])
  const setAtwResolvido = new Set([
    ...setHorMapeado,
    ...Object.values(autoMatches),
  ])

  const setHorSemVinculo = [...setHor].filter(x => !setHorResolvido.has(x))
  const extras = [...setAtw]
    .filter(x => !setHor.has(x) && !setAtwResolvido.has(x) && !removidas.has(x))
    .sort()
  const faltantes = setHorSemVinculo
    .filter(x => !setAtw.has(x) && !horRemovidas.has(x))
    .sort()

  const opcoesAtw = [...setAtw]
    .filter(x => !removidas.has(x) && !setAtwResolvido.has(x))
    .sort()
  const suggestions: Record<string, { suggestion: string; score: number }> = {}

  faltantes.forEach(th => {
    if (opcoesAtw.length > 0) {
      const [sugerido, score] = suggestTurbineMatch(th, opcoesAtw)
      suggestions[th] = {
        suggestion: sugerido,
        score: parseFloat(score.toFixed(2)),
      }
    }
  })

  return {
    success: true,
    is_valid: extras.length === 0 && faltantes.length === 0,
    extras,
    faltantes,
    suggestions,
    auto_matches: autoMatches,
    turbinas_horizon: turbinasHorList.length,
    turbinas_atw: turbinasAtwList.length,
    turbinas_hor_list: turbinasHorList,
    turbinas_atw_list: turbinasAtwList,
    n_duplicatas: nDuplicatas,
  }
}

export async function horizonValidarRequisitos(
  horizonPaths: string[],
  summaryPaths: string[],
  detailsPath: string,
  damagesPaths: string[],
  turbinasRemovidas: string[],
  vinculosConfirmados: Record<string, string>
): Promise<any> {
  try {
    const dfHor = mergeHorizonBases(horizonPaths)
    let taskMap: Record<string, any> = {}

    if (dfHor && dfHor.length > 0 && 'Turbine' in dfHor[0]) {
      const cols = ['Horizon Task ID', 'Site'].filter(c => c in dfHor[0])
      if (cols.length > 0) {
        const uniqueTurbines = new Set(
          dfHor.map(r => String(r.Turbine || '').trim()).filter(Boolean)
        )
        uniqueTurbines.forEach(t => {
          const matchedRow = dfHor.find(
            r => String(r.Turbine || '').trim() === t
          )
          if (matchedRow) {
            const entry: any = {}
            cols.forEach(c => {
              entry[c] = matchedRow[c]
            })
            taskMap[t] = entry
          }
        })
      }

      Object.entries(vinculosConfirmados).forEach(([th, ta]) => {
        if (taskMap[th]) {
          taskMap[ta] = taskMap[th]
        }
      })

      const atwContentsCheck = mergeAtwSummaries(summaryPaths)
      if (atwContentsCheck && atwContentsCheck.length > 0) {
        const normMap: Record<string, any> = {}
        Object.entries(taskMap).forEach(([k, v]) => {
          normMap[normalizar(k)] = v
        })

        const uniqueAtwTurbines = Array.from(
          new Set(
            atwContentsCheck
              .map(r => String(r.Turbine || '').trim())
              .filter(Boolean)
          )
        )

        uniqueAtwTurbines.forEach(ta => {
          if (!taskMap[ta]) {
            const entry = normMap[normalizar(ta)]
            if (entry) {
              taskMap[ta] = entry
            }
          }
        })
      }
    }

    const damagesContents: [string, string][] = []
    for (const dp of damagesPaths || []) {
      if (fs.existsSync(dp)) {
        damagesContents.push([path.basename(dp), fs.readFileSync(dp, 'utf-8')])
      }
    }

    const summariesContents = (summaryPaths || [])
      .filter(p => fs.existsSync(p))
      .map(p => fs.readFileSync(p, 'utf-8'))
    const summaryContent = summariesContents[0] || ''
    const detailsContent = fs.existsSync(detailsPath)
      ? fs.readFileSync(detailsPath, 'utf-8')
      : ''

    const result = validateRequirements(
      summaryContent,
      detailsContent,
      damagesContents,
      turbinasRemovidas,
      vinculosConfirmados,
      taskMap,
      summariesContents
    )

    return {
      success: true,
      is_valid: result.is_valid,
      errors: result.errors,
      warnings: result.warnings,
    }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

export function validateRequirements(
  contentSummary: string,
  contentDetails: string,
  damagesContents: [string, string][],
  turbinasRemovidas: string[] = [],
  vinculosConfirmados: Record<string, string> = {},
  taskMap: Record<string, any> = {},
  summariesContents?: string[]
): RequirementsResult {
  const erros: string[] = []
  const avisos: string[] = []
  const removidasSet = new Set(turbinasRemovidas)
  const vinculos = vinculosConfirmados
  const nomesAtwVinculados = new Set(Object.values(vinculos))
  const validSet = new Set(
    [...Object.keys(taskMap || {}), ...nomesAtwVinculados].filter(
      x => !removidasSet.has(x)
    )
  )

  // ── Inconsistências de Arquivos (Verificações Críticas de Integridade) ──
  const dfS =
    summariesContents && summariesContents.length > 0
      ? mergeAtwSummariesFromContents(summariesContents)
      : loadCsvRobust(contentSummary)
  const dfD = loadCsvRobust(contentDetails)

  // ── Summary ──
  if (dfS && dfS.length > 0 && 'Turbine' in dfS[0]) {
    const filteredDfS = dfS.filter(
      row => !removidasSet.has(String(row.Turbine || '').trim())
    )

    const dateCol = Object.keys(dfS[0]).find(
      c => c.toLowerCase().includes('date') || c.toLowerCase().includes('data')
    )
    if (!dateCol) {
      erros.push('Summary: coluna de data não encontrada')
    } else {
      const sample = filteredDfS
        .map(row => String(row[dateCol] || '').trim())
        .filter(Boolean)
        .slice(0, 20)
      let formatoBr = false
      let ambiguo = false

      sample.forEach(x => {
        const matchBr = x.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
        if (matchBr) {
          const day = parseInt(matchBr[1], 10)
          if (day > 12) {
            formatoBr = true
          } else {
            ambiguo = true
          }
        }
      })

      if (formatoBr) {
        avisos.push(
          'Summary: datas em formato BR (dd/mm/yyyy) — serão convertidas automaticamente para YYYY-MM-DD'
        )
      } else if (ambiguo) {
        avisos.push(
          'Summary: datas com formato ambíguo — verifique se estão no padrão YYYY-MM-DD'
        )
      }
    }

    if ('Inspection Type' in dfS[0]) {
      const inspectionTypesValidos = new Set(INSPECTION_TYPES_VALIDOS)
      const invalidTypes = new Set<string>()
      filteredDfS.forEach(row => {
        const t = String(row['Inspection Type'] || '').trim()
        if (t && !inspectionTypesValidos.has(t)) {
          invalidTypes.add(t)
        }
      })
      if (invalidTypes.size > 0) {
        erros.push(
          `Summary: Inspection Type inválido — ${Array.from(invalidTypes).join(', ')}`
        )
      }
    } else {
      erros.push("Summary: coluna 'Inspection Type' não encontrada")
    }
  }

  // ── Details ──
  if (dfD && dfD.length > 0) {
    const idc = 'ID' in dfD[0] ? 'ID' : Object.keys(dfD[0])[0]
    const dfDChk = dfD.filter(
      row => validSet.size === 0 || validSet.has(String(row[idc] || '').trim())
    )

    const pathCol =
      Object.keys(dfD[0]).find(c => c.toLowerCase() === 'path') ||
      Object.keys(dfD[0]).find(
        c =>
          (c.toLowerCase().includes('file') ||
            c.toLowerCase().includes('image')) &&
          !c.toLowerCase().includes('url')
      )
    const urlCol = Object.keys(dfD[0]).find(c =>
      c.toLowerCase().includes('url')
    )

    if (pathCol) {
      const vazios = dfDChk.filter(
        row =>
          row[pathCol] === null ||
          row[pathCol] === undefined ||
          String(row[pathCol]).trim() === ''
      ).length
      if (vazios > 0) {
        erros.push(`Details: ${vazios} linha(s) sem Path (${pathCol})`)
      }
    } else {
      avisos.push('Details: coluna de Path/File não identificada')
    }

    if (urlCol) {
      const vazios = dfDChk.filter(
        row =>
          row[urlCol] === null ||
          row[urlCol] === undefined ||
          String(row[urlCol]).trim() === ''
      ).length
      if (vazios > 0) {
        erros.push(`Details: ${vazios} linha(s) sem URL (${urlCol})`)
      }
    } else {
      avisos.push('Details: coluna de URL não identificada')
    }

    const radCol = Object.keys(dfD[0]).find(
      c =>
        c.toLowerCase().includes('radial') ||
        c.toLowerCase().includes('distance')
    )
    if (radCol) {
      let naoNumerico = 0
      let outOfRange = 0
      dfDChk.forEach(row => {
        const valStr = String(row[radCol] || '').trim()
        if (valStr !== '') {
          const valNum = parseFloat(valStr)
          if (isNaN(valNum)) {
            naoNumerico++
          } else if (valNum > 200 || valNum < -3) {
            outOfRange++
          }
        }
      })
      if (naoNumerico > 0) {
        erros.push(
          `Details: ${naoNumerico} valor(es) não numérico(s) em Radial Distance`
        )
      }
      if (outOfRange > 0) {
        avisos.push(
          `Details: ${outOfRange} valor(es) de Radial Distance fora de [-3, 200] (fotos humanizadas/VISUAL) — serão corrigidos para 0 automaticamente.`
        )
      }
    } else {
      avisos.push('Details: coluna de Radial Distance não identificada')
    }
  }

  // ── Damages ──
  if (damagesContents.length === 0) {
    avisos.push(
      'Nenhum arquivo de Damages carregado — confirme se não há registros de danos nesta inspeção.'
    )
  }

  const coordPattern = /^(\[\d+,\s*\d+\],?\s*)+$/
  const allCoveredPhotos = new Set<string>()

  damagesContents.forEach(([nomeDam, contentDam]) => {
    const dfM = loadCsvRobust(contentDam, true)
    if (dfM && dfM.length > 0) {
      if ('Photo File Name' in dfM[0]) {
        const vazios = dfM.filter(
          row =>
            row['Photo File Name'] === null ||
            row['Photo File Name'] === undefined ||
            String(row['Photo File Name']).trim() === ''
        ).length
        if (vazios > 0) {
          erros.push(
            `Damages (${nomeDam}): ${vazios} linha(s) sem Photo File Name`
          )
        }
        dfM.forEach(row => {
          const p = String(row['Photo File Name'] || '').trim()
          if (p) {
            allCoveredPhotos.add(cleanFilename(p))
          }
        })
      }
      if ('Coordinates' in dfM[0]) {
        let coordInvalidas = 0
        dfM.forEach(row => {
          const c = String(row['Coordinates'] || '').trim()
          if (c && !coordPattern.test(c)) {
            coordInvalidas++
          }
        })
        if (coordInvalidas > 0) {
          erros.push(
            `Damages (${nomeDam}): ${coordInvalidas} coordenada(s) com formato inválido`
          )
        }
      }
    }
  })

  // ── Cobertura de Damages por turbina ──
  if (
    damagesContents.length > 0 &&
    dfD &&
    dfD.length > 0 &&
    allCoveredPhotos.size > 0
  ) {
    const idc = 'ID' in dfD[0] ? 'ID' : Object.keys(dfD[0])[0]
    const pathCol =
      Object.keys(dfD[0]).find(c => c.toLowerCase() === 'path') ||
      Object.keys(dfD[0]).find(
        c =>
          (c.toLowerCase().includes('file') ||
            c.toLowerCase().includes('image')) &&
          !c.toLowerCase().includes('url')
      )
    const dfDChk = dfD.filter(
      row => validSet.size === 0 || validSet.has(String(row[idc] || '').trim())
    )

    if (pathCol) {
      const turbSet = new Set<string>()
      dfDChk.forEach(row => {
        const t = String(row[idc] || '').trim()
        if (t) turbSet.add(t)
      })

      Array.from(turbSet)
        .sort()
        .forEach(turbina => {
          const fotosTurbina = dfDChk
            .filter(row => String(row[idc] || '').trim() === turbina)
            .map(row => cleanFilename(String(row[pathCol] || '')))
            .filter(Boolean)

          const hasCovered = fotosTurbina.some(f => allCoveredPhotos.has(f))
          if (fotosTurbina.length > 0 && !hasCovered) {
            avisos.push(
              `Damages: ${turbina} — nenhum CSV de danos cobre as suas fotos`
            )
          }
        })
    }
  }

  return { is_valid: erros.length === 0, errors: erros, warnings: avisos }
}

export async function horizonGerarPacote(
  horizonPaths: string[],
  summaryPaths: string[],
  detailsPath: string,
  damagesPaths: string[],
  vinculosConfirmados: Record<string, string>,
  turbinasRemovidas: string[],
  turbinasHorizonRemovidas: string[]
): Promise<any> {
  try {
    const removidasSet = new Set(turbinasRemovidas)
    const horRemovidasSet = new Set(turbinasHorizonRemovidas)
    const vinculos = vinculosConfirmados

    const dfHor = mergeHorizonBases(horizonPaths)
    const dfAtwRaw = mergeAtwSummaries(summaryPaths)

    if (!dfHor || !dfAtwRaw) {
      return {
        success: false,
        error: 'Falha ao processar base Horizon ou Summary.',
      }
    }

    const { df: dfAtw } = deduplicateAtw(dfAtwRaw)
    const nomesHorizon = new Set(
      dfHor.map(r => String(r.Turbine || '').trim()).filter(Boolean)
    )

    // Auto-matches
    const horNormToName: Record<string, string> = {}
    nomesHorizon.forEach(t => {
      horNormToName[normalizar(t)] = t
    })

    const atwNamesAll = new Set(
      dfAtw.map(r => String(r.Turbine || '').trim()).filter(Boolean)
    )

    const autoHorToAtw: Record<string, string> = {}
    const atwNormSeen = new Set<string>()
    Array.from(atwNamesAll)
      .sort()
      .forEach(atwT => {
        const nt = normalizar(atwT)
        if (horNormToName[nt] && !atwNormSeen.has(nt)) {
          const horT = horNormToName[nt]
          if (!vinculos[horT]) {
            autoHorToAtw[horT] = atwT
          }
          atwNormSeen.add(nt)
        }
      })

    const allHorToAtw = { ...autoHorToAtw, ...vinculos }
    const atwParaHor: Record<string, string> = {}
    Object.entries(allHorToAtw).forEach(([k, v]) => {
      atwParaHor[v] = k
    })

    // Rebuild taskMap
    const taskMap: Record<string, any> = {}
    const cols = ['Horizon Task ID', 'Site'].filter(c => c in dfHor[0])
    if (cols.length > 0) {
      const uniqueTurbines = new Set(
        dfHor.map(r => String(r.Turbine || '').trim()).filter(Boolean)
      )
      uniqueTurbines.forEach(t => {
        const matchedRow = dfHor.find(r => String(r.Turbine || '').trim() === t)
        if (matchedRow) {
          const entry: any = {}
          cols.forEach(c => {
            entry[c] = matchedRow[c]
          })
          taskMap[t] = entry
        }
      })
    }

    Object.entries(allHorToAtw).forEach(([th, ta]) => {
      if (taskMap[th]) {
        taskMap[ta] = taskMap[th]
      }
    })

    const nomesAtwVinculados = new Set(Object.values(allHorToAtw))
    const validSet = new Set(
      [...nomesHorizon, ...nomesAtwVinculados].filter(x => !removidasSet.has(x))
    )

    const errosPos: string[] = []
    const zip = new JSZip()

    // 1. Summary Final
    let dfSummaryFinal: any[] | null = null
    const validSetHor = new Set(
      [...nomesHorizon].filter(
        x => !removidasSet.has(x) && !horRemovidasSet.has(x)
      )
    )
    const dfHorFilt = dfHor.filter(row =>
      validSetHor.has(String(row.Turbine || '').trim())
    )

    const dateColAtw = Object.keys(dfAtw[0]).find(
      c => c.toLowerCase().includes('date') || c.toLowerCase().includes('data')
    )
    const typeColAtw = Object.keys(dfAtw[0]).find(c =>
      c.toLowerCase().includes('inspection type')
    )

    const hasDateCol = dateColAtw || 'Inspection Date' in dfHor[0]
    const hasTypeCol = typeColAtw || 'Inspection Type' in dfHor[0]

    const atwDate: Record<string, string> = {}
    const atwType: Record<string, string> = {}

    dfAtw.forEach(row => {
      const t = String(row.Turbine || '').trim()
      if (t) {
        atwDate[t] = String(dateColAtw ? row[dateColAtw] || '' : '').trim()
        atwType[t] = String(typeColAtw ? row[typeColAtw] || '' : '').trim()
      }
    })

    const atwNormDate: Record<string, string> = {}
    const atwNormType: Record<string, string> = {}
    Object.keys(atwDate).forEach(t => {
      const nt = normalizar(t)
      if (!atwNormDate[nt]) {
        atwNormDate[nt] = atwDate[t]
        atwNormType[nt] = atwType[t] || ''
      }
    })

    const lookupVal = (
      tHor: string,
      dExact: Record<string, string>,
      dNorm: Record<string, string>
    ): string => {
      const resolved = vinculos[tHor] || tHor
      if (dExact[resolved] !== undefined) return dExact[resolved]
      if (dExact[tHor] !== undefined) return dExact[tHor]
      return dNorm[normalizar(tHor)] || ''
    }

    dfHorFilt.forEach(row => {
      const t = String(row.Turbine || '').trim()
      if (!row['ID']) {
        row['ID'] = t
      }
      if (hasDateCol) {
        const val = lookupVal(t, atwDate, atwNormDate)
        row['Inspection Date'] = formatDateIso(val)
      }
      if (hasTypeCol) {
        row['Inspection Type'] = lookupVal(t, atwType, atwNormType)
      }
    })

    dfSummaryFinal = dfHorFilt
    zip.file('summary_final.csv', toCsv(dfHorFilt, ','))

    // 2. Details Final
    const contentDetails = fs.readFileSync(detailsPath, 'utf-8')
    let dfD = loadCsvRobust(contentDetails)
    let dfDetailsFinal: any[] | null = null
    const validPhotos = new Set<string>()

    if (dfD && dfD.length > 0) {
      const idc = 'ID' in dfD[0] ? 'ID' : Object.keys(dfD[0])[0]
      dfD = dfD.filter(
        row =>
          validSet.has(String(row[idc] || '').trim()) ||
          nomesAtwVinculados.has(String(row[idc] || '').trim())
      )

      dfD.forEach(row => {
        const x = String(row[idc] || '').trim()
        row[idc] = atwParaHor[x] || x
      })

      const pathCol =
        Object.keys(dfD[0]).find(c => c.toLowerCase() === 'path') ||
        Object.keys(dfD[0]).find(
          c =>
            (c.toLowerCase().includes('file') ||
              c.toLowerCase().includes('image')) &&
            !c.toLowerCase().includes('url')
        ) ||
        Object.keys(dfD[0]).find(c => c.toLowerCase().includes('url')) ||
        Object.keys(dfD[0])[Object.keys(dfD[0]).length - 1]

      dfD.forEach(row => {
        const n = String(row[pathCol] || '')
        if (n) validPhotos.add(cleanFilename(n))
      })

      dfD.forEach(row => {
        const x = String(row[idc] || '').trim()
        row['Horizon Task ID'] = taskMap[x]?.['Horizon Task ID'] || ''
      })

      const radColDet = Object.keys(dfD[0]).find(
        c =>
          c.toLowerCase().includes('radial') ||
          c.toLowerCase().includes('distance')
      )
      let nRadCorrigidos = 0
      if (radColDet) {
        dfD.forEach(row => {
          const valStr = String(row[radColDet] || '').trim()
          if (valStr !== '') {
            const valNum = parseFloat(valStr)
            if (!isNaN(valNum) && (valNum > 200 || valNum < -3)) {
              row[radColDet] = '0'
              nRadCorrigidos++
            }
          }
        })
      }

      dfDetailsFinal = dfD
      zip.file('details_final.csv', toCsv(dfD, ';'))
      zip.file('Details/details_final.csv', toCsv(dfD, ';'))

      // Divisão do Details em lotes de até 20 aerogeradores (turbinas)
      const rowsByTurbine: Record<string, any[]> = {}
      const uniqueTurbinesInDetails: string[] = []

      dfD.forEach(row => {
        const turbId = String(row[idc] || '').trim()
        if (!rowsByTurbine[turbId]) {
          rowsByTurbine[turbId] = []
          uniqueTurbinesInDetails.push(turbId)
        }
        rowsByTurbine[turbId].push(row)
      })

      const CHUNK_SIZE = 20
      for (let i = 0; i < uniqueTurbinesInDetails.length; i += CHUNK_SIZE) {
        const chunkTurbines = uniqueTurbinesInDetails.slice(i, i + CHUNK_SIZE)
        const chunkRows: any[] = []
        chunkTurbines.forEach(t => {
          chunkRows.push(...rowsByTurbine[t])
        })
        const loteNum = Math.floor(i / CHUNK_SIZE) + 1
        const startNum = String(i + 1).padStart(2, '0')
        const endNum = String(
          Math.min(i + CHUNK_SIZE, uniqueTurbinesInDetails.length)
        ).padStart(2, '0')
        const loteFilename = `Details/details_lote_${loteNum}_turbinas_${startNum}_a_${endNum}.csv`
        zip.file(loteFilename, toCsv(chunkRows, ';'))
      }

      if (nRadCorrigidos > 0) {
        errosPos.push(
          `Details: ${nRadCorrigidos} valor(es) de Radial Distance fora de [-3, 200] corrigido(s) para 0 (fotos humanizadas/VISUAL) sem Z válido.`
        )
      }
    }

    // 3. Damages Final
    const coveredPhotosByTurbine: Record<string, Set<string>> = {}
    const horizonDates: Record<string, string> = {}
    const horizonSites: Record<string, string> = {}
    if (dfSummaryFinal) {
      dfSummaryFinal.forEach(row => {
        const t = String(row.Turbine || '').trim()
        horizonDates[t] = String(row['Inspection Date'] || '').trim()
        horizonSites[t] = String(row['Site'] || '').trim()
      })
    }

    const allFlags: any[] = []

    for (const dp of damagesPaths || []) {
      if (fs.existsSync(dp)) {
        const contentDam = fs.readFileSync(dp, 'utf-8')
        let dfM = loadCsvRobust(contentDam, true)
        if (dfM && dfM.length > 0 && 'Photo File Name' in dfM[0]) {
          dfM = dfM.filter(row =>
            validPhotos.has(cleanFilename(String(row['Photo File Name'] || '')))
          )
          if (dfM.length > 0) {
            const turbineFromFilename = path.basename(dp, '.csv').trim()
            const horizonTurbineName =
              atwParaHor[turbineFromFilename] || turbineFromFilename
            if (!horizonDates[horizonTurbineName]) {
              // Pula arquivos de danos extras que não pertencem ao resumo da Horizon
              continue
            }
            const dateVal = horizonDates[horizonTurbineName] || ''
            const siteVal = horizonSites[horizonTurbineName] || ''

            const filename = path.basename(dp)
            const { convertedRows, flags } = convertDamagesDf(dfM, filename)
            allFlags.push(...flags)

            if (convertedRows.length > 0) {
              convertedRows.forEach(row => {
                row['Turbine'] = horizonTurbineName
                row['Site'] = siteVal
                row['Inspection Date'] = dateVal
                row['Date'] = formatDateIso(row['Date'] || dateVal)
              })

              const zipFilename = `Damages/${horizonTurbineName}.csv`
              zip.file(zipFilename, toDamageCsv(convertedRows))

              convertedRows.forEach(row => {
                const p = String(row['Photo File Name'] || '').trim()
                if (p) {
                  const fp = cleanFilename(p)
                  if (!coveredPhotosByTurbine['__all__'])
                    coveredPhotosByTurbine['__all__'] = new Set()
                  coveredPhotosByTurbine['__all__'].add(fp)
                }
              })
            }
          }
        }
      }
    }

    if (allFlags.length > 0) {
      zip.file('ALERTAS_CONVERSAO.csv', toCsv(allFlags))
    }

    // Validation
    if (dfSummaryFinal) {
      for (const campo of [
        'Horizon Task ID',
        'Inspection Date',
        'Inspection Type',
      ]) {
        if (dfSummaryFinal.length > 0 && campo in dfSummaryFinal[0]) {
          const semValor = dfSummaryFinal.filter(row => {
            const val = String(row[campo] || '').trim()
            return (
              !val || ['nat', 'nan', 'none', 'null'].includes(val.toLowerCase())
            )
          })
          if (semValor.length > 0) {
            const turbinasProb = Array.from(
              new Set(semValor.map(row => String(row.Turbine || '').trim()))
            )
              .sort()
              .join(', ')
            errosPos.push(`Summary: ${campo} vazio em: ${turbinasProb}`)
          }
        } else {
          errosPos.push(`Summary: coluna '${campo}' ausente no resultado final`)
        }
      }
    }

    if (dfDetailsFinal) {
      const semTask = dfDetailsFinal.filter(
        row => !String(row['Horizon Task ID'] || '').trim()
      )
      if (semTask.length > 0) {
        errosPos.push(
          `Details: Horizon Task ID vazio em ${semTask.length} linha(s)`
        )
      }

      if (damagesPaths && damagesPaths.length > 0) {
        const idcDet2 =
          'ID' in dfDetailsFinal[0] ? 'ID' : Object.keys(dfDetailsFinal[0])[0]
        const pathColDet =
          Object.keys(dfDetailsFinal[0]).find(
            c => c.toLowerCase() === 'path'
          ) ||
          Object.keys(dfDetailsFinal[0]).find(
            c =>
              (c.toLowerCase().includes('file') ||
                c.toLowerCase().includes('image')) &&
              !c.toLowerCase().includes('url')
          )

        const allCovered = coveredPhotosByTurbine['__all__'] || new Set()
        if (pathColDet && allCovered.size > 0) {
          const uniqueTurbines = Array.from(
            new Set(
              dfDetailsFinal
                .map(row => String(row[idcDet2] || '').trim())
                .filter(Boolean)
            )
          ).sort()

          uniqueTurbines.forEach(turbina => {
            const fotosT = dfDetailsFinal!
              .filter(row => String(row[idcDet2] || '').trim() === turbina)
              .map(row => cleanFilename(String(row[pathColDet] || '')))
              .filter(Boolean)

            const hasCovered = fotosT.some(f => allCovered.has(f))
            if (fotosT.length > 0 && !hasCovered) {
              errosPos.push(
                `Damages: ${turbina} — nenhum CSV de danos inclui as suas fotos no pacote`
              )
            }
          })
        }
      } else {
        errosPos.push('Nenhum arquivo de Damages foi incluído no pacote.')
      }
    }

    const outDir = path.join(path.dirname(summaryPaths[0]), 'HORIZON_OUTPUT')
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true })
    }

    let siteName = ''
    if (dfAtw && dfAtw.length > 0 && 'Site' in dfAtw[0]) {
      const sites = Array.from(
        new Set(dfAtw.map(row => String(row.Site || '').trim()).filter(Boolean))
      )
      if (sites.length > 0) {
        siteName = sites[0].replace(/[\\/*?:"<>|]/g, '').replace(/\s+/g, '_')
      }
    }

    const zipName = siteName
      ? `${siteName}_horizon_package.zip`
      : 'horizon_package.zip'
    const zipPath = path.join(outDir, zipName)

    const zipContent = await zip.generateAsync({ type: 'nodebuffer' })
    fs.writeFileSync(zipPath, zipContent)

    return {
      success: true,
      zip_path: zipPath,
      output_dir: outDir,
      erros_pos: errosPos,
    }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

export async function horizonCorrigirDamagesDireto(
  paths: string[],
  siteName = '',
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  const correctedFiles: string[] = []
  try {
    for (const pStr of paths) {
      if (!fs.existsSync(pStr)) continue
      const p = pStr

      const text = fs.readFileSync(p, 'utf-8')
      const lines = text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
      if (lines.length === 0) continue

      const firstLine = lines[0]
      const sep =
        firstLine.split(';').length > firstLine.split(',').length ? ';' : ','
      const headers = firstLine
        .split(sep)
        .map(h => h.trim().replace(/['"]/g, ''))

      let coordsIdx = -1
      let dateIdx = -1
      headers.forEach((h, idx) => {
        if (h.toLowerCase() === 'coordinates') coordsIdx = idx
        else if (h.toLowerCase() === 'date') dateIdx = idx
      })

      if (coordsIdx === -1) {
        coordsIdx = headers.length - 1
      }

      const hasSite = headers.some(h => h.toLowerCase() === 'site')
      const hasTurbine = headers.some(h => h.toLowerCase() === 'turbine')
      const hasInspDate = headers.some(
        h => h.toLowerCase() === 'inspection date'
      )

      const newHeaders = [...headers]
      if (!hasSite) newHeaders.push('Site')
      if (!hasTurbine) newHeaders.push('Turbine')
      if (!hasInspDate) newHeaders.push('Inspection Date')

      let guessedSite = siteName
      if (!hasSite && !guessedSite) {
        const parentFolder = path.basename(path.dirname(path.dirname(p)))
        guessedSite = parentFolder
          .replace(/^(complexo\s+eólico\s+|complexo\s+eolico\s+)/i, '')
          .trim()
      }

      let turbineVal = ''
      if (!hasTurbine) {
        turbineVal = path
          .basename(p, path.extname(p))
          .replace(/_fixed$/i, '')
          .trim()
      }

      const outputRows: string[][] = []
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]
        let parts = line.split(sep)
        let rowData: string[] = []

        if (sep === ',' && parts.length > headers.length) {
          const extraParts = parts.length - headers.length
          const rowBefore = parts.slice(0, coordsIdx)
          const coordsParts = parts.slice(coordsIdx, coordsIdx + extraParts + 1)
          const rowAfter = parts.slice(coordsIdx + extraParts + 1)

          let coordsVal = coordsParts
            .join(',')
            .trim()
            .replace(/^['"]|['"]$/g, '')
          if (coordsVal.startsWith('[[') && coordsVal.endsWith(']]')) {
            coordsVal = coordsVal.substring(1, coordsVal.length - 1)
          }
          coordsVal = coordsVal.replace(/\s+/g, '')
          rowData = [...rowBefore, coordsVal, ...rowAfter]
        } else {
          rowData = parts
            .slice(0, headers.length)
            .map(val => val.trim().replace(/^['"]|['"]$/g, ''))
          if (rowData.length > coordsIdx) {
            let cVal = rowData[coordsIdx]
            if (cVal.startsWith('[[') && cVal.endsWith(']]')) {
              cVal = cVal.substring(1, cVal.length - 1)
            }
            cVal = cVal.replace(/\s+/g, '')
            rowData[coordsIdx] = cVal
          }
        }

        while (rowData.length < headers.length) {
          rowData.push('')
        }

        if (!hasSite) rowData.push(guessedSite)
        if (!hasTurbine) rowData.push(turbineVal)
        if (!hasInspDate) {
          let dateVal = ''
          if (dateIdx !== -1 && dateIdx < rowData.length) {
            dateVal = rowData[dateIdx].trim()
          }
          rowData.push(dateVal)
        }

        outputRows.push(rowData)
      }

      const outName = `${path.basename(p, path.extname(p))}_fixed.csv`
      const outPath = path.join(path.dirname(p), outName)

      const csvLines = [newHeaders.join(',')]
      outputRows.forEach(row => {
        const escapedRow = row.map(cell => {
          if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
            return `"${cell.replace(/"/g, '""')}"`
          }
          return cell
        })
        csvLines.push(escapedRow.join(','))
      })

      fs.writeFileSync(outPath, csvLines.join('\r\n'), 'utf-8')
      correctedFiles.push(outPath)
      sendLog(`✔ Higienizado: ${path.basename(p)} → ${outName}`, 'success')
    }

    return { success: true, corrected_files: correctedFiles }
  } catch (err: any) {
    sendLog(`Erro ao higienizar damages: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}
