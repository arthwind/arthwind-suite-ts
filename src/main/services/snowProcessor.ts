import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import os from 'os'
import ExcelJS from 'exceljs'
import sharp from 'sharp'
import { equirectPolygonToPinhole, renderEquirectPinhole, equirectPolygonCenter } from './polygonUtils'
import { getBladeInfo } from './bladeSets'

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface SnowProcessResult {
  success: boolean
  rowsProcessed: number
  rowsSkipped: number
  photosOk: number
  photosSkipped: number
  outputPath: string
  photosFolder: string
  error?: string
}

interface DownloadParams {
  turbineSn: string
  bladeSn: string
  bladeSection: string
  bladeArea: string
  dfStart: number
  dfEnd: number
  photoUrl: string
  coordinatesJson: string
  surface: string
  photosFolder: string
  baseName?: string
  pic1Name?: string
  pic2Name?: string
}


// ─── MAPPINGS ────────────────────────────────────────────────────────────────

export class SnowMappings {
  private static readonly FAILURE_TYPES: Record<string, string> = {
    'Delamination':                        'Delamination',
    'Crack in the bondline':               'Type of Failure is Missing',
    'Sealant Damaged':                     'Type of Failure is Missing',
    'Lightning Strike':                    'Burn Mark',
    'Damaged Laminate':                    'Type of Failure is Missing',
    'Wrinkle':                             'Waveness in the glassmaterial',
    'Gap':                                 'Deviation Core Material',
    // "Air Inclusion"/"Foreign Object" (singular) NÃO existem no dropdown real do SNOW
    // — o rótulo de verdade lá é plural ("Air inclusions"/"Foreign objects"), achado
    // comparando a planilha com a tabela ao vivo do ServiceNow (o robô nunca reconhecia
    // esses defeitos como já cadastrados por causa do "s" a mais/a menos).
    'Bubbles':                             'Air inclusions',
    'Semi dry glass':                      'Dry Laminate',
    'Foreign Object':                      'Foreign objects',
    'Bonding paste failure':               'Type of Failure is Missing',
    'Core Material Damaged':               'Deviation Core Material',
    'LPS Disconnected/Damaged':            'Type of Failure is Missing',
    'Step':                                'Deviation Core Material',
    'Crack in the Laminate Longitudinal':  'Crack, longitudinal',
    'Crack in the Laminate Transversal':   'Crack, transversal',
    'Missing Stud':                        'Type of Failure is Missing',
    'Accessory Damaged':                   'Type of Failure is Missing',
    'Improper Repair':                     'Type of Failure is Missing',
    'Others':                              'Type of Failure is Missing',
  }

  static getFailure(original: string, subComponent?: string): string {
    const key = (original || '').trim()
    const sub = (subComponent || '').trim()

    // Regra de negócio do cliente: "Air inclusion" com sub-componente "Web Laminate" não existe no SNOW.
    // Nesses casos, altera para "Type of Failure is Missing".
    if (/web\s*laminate/i.test(sub) && (/bubbles/i.test(key) || /air\s*inclusion/i.test(key))) {
      return 'Type of Failure is Missing'
    }

    return this.FAILURE_TYPES[key] ?? 'Type of Failure is Missing'
  }


  static getDamageDescription(bladeSn: string | number, originalFailure: string, turbineSn?: string): string {
    const rawSn = String(bladeSn || '').replace(/^B/i, '').replace(/^0+/, '')
    const paddedBladeSn = rawSn ? rawSn.padStart(4, '0') : '0000'
    const info = getBladeInfo(bladeSn, turbineSn)
    const setStr = info.setNumber ? String(info.setNumber).padStart(2, '0') : 'N/A'

    return [
      'Inspection as per SN_241',
      `Blade: S/N${paddedBladeSn} Set ${setStr}`,
      'Inspection number: 1',
      originalFailure,
    ].join('\n')
  }





  static getProfile(section: string): number | string {
    const s = (section || '').trim().toUpperCase()
    if (s === 'LE') return 0
    if (s === 'CE') return 50
    if (s === 'TE') return 100
    return ''
  }

  // Fonte equirretangular fixa do Arthnex — mesma premissa validada na
  // correção de posicionamento dos polígonos (85 pontos de calibração).
  private static readonly EQUIRECT_SRC_WIDTH = 3840
  // Abaixo disso a foto é GoPro fixa da raiz — a coordenada é pixel nativo,
  // não equirretangular, então não dá pra calcular ângulo a partir dela.
  private static readonly ROOT_LOCATION_THRESHOLD_M = 11

  // Âncoras reais (Section+Side → zonas da tabela do cliente, com o ângulo
  // onde cada uma foi confirmada). Extraídas de VSR05-06 pás 377/404/408 —
  // ver docs/pd-from-coordinate.md. Cada zona SÓ entra aqui com âncora(s)
  // real(is) confirmada(s); zonas sem referência ficam de fora (tratadas à
  // parte, sem inventar um ângulo que não medimos).
  //
  // LE|SS: 3 referências independentes (ângulos bem diferentes entre si, de
  // 101.9° a 140.7°) sempre confirmam PD 10 — a única zona possível pra esse
  // lado na tabela do cliente (SS, transition to MG, 10-15%), sem depender
  // do ângulo dentro dessa faixa.
  //
  // Section 2/SS tem uma segunda zona possível na tabela do cliente
  // ("transition to MG", 40-45%) sem âncora real — busca em outras turbinas
  // não trouxe uma (defeitos reais se repetem quase sempre nos mesmos
  // pontos, a amostragem não cresce só olhando mais dados). Tende a ficar
  // assim por um bom tempo; se algum dia aparecer um defeito real nessa
  // zona, basta adicionar a entrada aqui que a escolha por proximidade
  // passa a valer sozinha (pickNearestByAngle já suporta N âncoras).
  private static readonly PD_ANCHORS: Record<string, { angleDeg: number; pd: number }[]> = {
    'LE|SS': [
      { angleDeg: 101.9, pd: 10 },
      { angleDeg: 104.9, pd: 10 },
      { angleDeg: 140.7, pd: 10 },
    ],                                          // única zona possível: →MG (10-15%)
    'CE|SS': [{ angleDeg: 41.5, pd: 55 }],       // →TEG (55-60%); →MG (40-45%) ainda sem âncora
    'CE|PS': [{ angleDeg: 79.4, pd: 55 }],       // única zona possível: →TEG (55-60%)
  }

  private static pickNearestByAngle(
    angleDeg: number,
    anchors: { angleDeg: number; pd: number }[]
  ): number {
    let best = anchors[0]
    let bestDelta = Math.abs(angleDeg - best.angleDeg)
    for (const a of anchors.slice(1)) {
      const delta = Math.abs(angleDeg - a.angleDeg)
      if (delta < bestDelta) { best = a; bestDelta = delta }
    }
    return best.pd
  }

  /**
   * Profile Depth (%) a partir da posição angular real do polígono na bolha
   * equirretangular, em vez do valor fixo por região (getProfile). Calibrado
   * com pontos de referência reais (VSR05-06, pás 377/404/408) cruzados com a
   * especificação de PD% por posição do cliente — ver docs/pd-from-coordinate.md
   * pro estudo completo (inclusive as zonas que ainda não têm referência real
   * e por enquanto usam o valor mais próximo já validado).
   *
   * Cai no valor fixo antigo (getProfile) quando: Location < 11m (foto GoPro
   * da raiz — coordenada não é equirretangular), polígono inválido, Section
   * 3/TE (fora de escopo, "não trabalhamos"), ou Section 1/PS (2 zonas
   * possíveis na tabela do cliente, sem nenhuma referência real ainda).
   */
  static getProfileFromCoordinates(
    section: string,
    side: string,
    component: string,
    coordinatesJson: string,
    locationM: number
  ): number | string {
    const s = (section || '').trim().toUpperCase()
    const c = (component || '').trim().toUpperCase()

    // MSW (Main Shear Web / componente "MAIN WEB") tem PD fixo — único caso
    // da tabela do cliente que não depende de seção, lado nem ângulo.
    if (c === 'MAIN WEB') return 30

    // Section 3/TE não é trabalhado hoje — mantém o valor antigo.
    if (s !== 'LE' && s !== 'CE') return this.getProfile(section)

    const points = parseCoordinates(coordinatesJson)
    const isRootPhoto = locationM < this.ROOT_LOCATION_THRESHOLD_M
    if (isRootPhoto || points.length < 3) {
      return this.getProfile(section)
    }

    const sd = (side || '').trim().toUpperCase()
    // Mesmo default de getBladeArea: qualquer side que não seja PS cai em SS.
    const isPS = sd === 'PS'

    // Section 1/PS: 2 zonas possíveis (edge 0-5%, →MG 10-15%) sem nenhuma
    // referência real ainda — sem âncora, mantém o valor antigo.
    if (s === 'LE' && isPS) return this.getProfile(section)

    const anchors = this.PD_ANCHORS[`${s}|${isPS ? 'PS' : 'SS'}`]
    if (!anchors || anchors.length === 0) return this.getProfile(section)

    const center = equirectPolygonCenter(points, this.EQUIRECT_SRC_WIDTH)
    const angleDeg = ((center.x / this.EQUIRECT_SRC_WIDTH) * 2 - 1) * 180

    return this.pickNearestByAngle(angleDeg, anchors)
  }

  static getBladeSection(section: string): string {
    const s = (section || '').trim().toUpperCase()
    if (s === 'LE') return 'Section 1'
    if (s === 'CE') return 'Section 2'
    if (s === 'TE') return 'Section 3'
    return ''
  }

  static getBladeSubsection(component: string): string {
    const c = (component || '').trim().toUpperCase()
    if (c === 'TE WEB' || c === 'MAIN WEB') return 'Shear Web'
    return 'Shell'
  }

  static getSubComponent(component: string): string {
    const c = (component || '').trim().toUpperCase()
    if (c === 'TE WEB' || c === 'MAIN WEB') return 'Blade Inside - Web Laminate'
    return 'Blade Inside - Shell'
  }

  static getBladeArea(component: string, side: string): string {
    const c = (component || '').trim().toUpperCase()
    const s = (side || '').trim().toUpperCase()
    if (c === 'TE WEB')   return 'Shear Web B'
    if (c === 'MAIN WEB') return 'Shear Web A'
    if (s === 'SS') return 'SS'
    if (s === 'PS') return 'PS'
    return 'SS'
  }

  static getDfEnd(start: number, sizeMm: number): number {
    const end = start + sizeMm / 1000
    // Cliente só aceita 1 casa decimal no DF (padrão deles, mesmo pra todos os outros campos).
    return Math.round(end * 10) / 10
  }

  /** Converte blade_area para abreviação usada no nome do arquivo de foto */
  static areaToFileCode(bladeArea: string): string {
    if (bladeArea === 'Shear Web A') return 'MSW'
    if (bladeArea === 'Shear Web B') return 'TSW'
    return bladeArea
  }

  static shouldHighlight(failure: string, dfStart: number): boolean {
    return failure === 'Delamination' && dfStart >= 45
  }
}

// ─── PHOTO PROCESSOR ─────────────────────────────────────────────────────────

interface PolygonPoint { x: number; y: number }

async function fetchImageBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout 30s')) })
    req.on('error', reject)
  })
}

function parseCoordinates(json: string): PolygonPoint[] {
  if (!json) return []
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p: any) => typeof p.x === 'number' && typeof p.y === 'number' &&
                  isFinite(p.x) && isFinite(p.y)
    )
  } catch {
    return []
  }
}

/** Builds an SVG polygon-outline overlay to composite onto a base image via sharp. */
function buildPolygonOverlaySvg(
  points: PolygonPoint[],
  width: number,
  height: number,
  strokeWidth: number,
  color = '#FF0000'
): Buffer {
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z'
  const svg =
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" ` +
    `stroke-linejoin="round" stroke-linecap="round"/></svg>`
  return Buffer.from(svg)
}

interface MarkedImagesResult {
  pic1: Buffer | null
  pic2: Buffer | null
}

async function createMarkedImages(
  imageBuffer: Buffer,
  coordinatesJson: string,
  _surface: string,
  locationM: number
): Promise<MarkedImagesResult> {
  const points = parseCoordinates(coordinatesJson)
  if (points.length < 3) {
    return { pic1: imageBuffer, pic2: null }
  }

  const metadata = await sharp(imageBuffer).metadata()
  const width  = metadata.width  ?? 0
  const height = metadata.height ?? 0

  if (width === 0 || height === 0) {
    return { pic1: imageBuffer, pic2: null }
  }

  // Detect 360 equirectangular panorama (2:1 aspect ratio)
  const aspectRatio = width / height
  const is360 = Math.abs(aspectRatio - 2.0) <= 0.15

  if (is360) {
    // ── 360 PANORAMA PROCESSING ──────────────────────────────────────────────
    // Fotos 360 são sempre baixadas na mesma resolução nativa (4K/5.7K, 2:1) em
    // que o defeito foi marcado no visualizador Arthnex — não existe canvas de
    // preview reduzido para panoramas (diferente do fluxo GoPro/flat). Os Casos
    // 1/2 usados no fluxo flat são calibrados para o aspecto 4:3 do GoPro
    // (568.5×424.5 / 5568×4176) e distorcem polígonos pequenos ao serem
    // aplicados sobre uma equirretangular 2:1, então a coordenada é usada como
    // veio, só corrigindo o sinal de Y.
    const scaledPanoPoints: PolygonPoint[] = points.map((p) => ({
      x: p.x,
      y: Math.abs(p.y)
    }))

    try {
      // 1. Render perspective pinhole view (5568×4176) centered on defect
      const render = await renderEquirectPinhole(imageBuffer, scaledPanoPoints)

      // 2. Project 360 equirectangular polygon to pinhole camera space
      const projectedPoints = equirectPolygonToPinhole(scaledPanoPoints, width, height)
      const closedPoints = [...projectedPoints, projectedPoints[0]]
      const overlay = buildPolygonOverlaySvg(closedPoints, render.info.width, render.info.height, 18)

      // pic1: Full 5568×4176 perspective pinhole view with red polygon drawn on top
      const pic1Buffer = await sharp(render.data, { raw: render.info })
        .composite([{ input: overlay }])
        .jpeg({ quality: 85 })
        .toBuffer()

      // pic2: Clean perspective pinhole view (no polygon)
      const pic2Buffer = await sharp(render.data, { raw: render.info })
        .jpeg({ quality: 85 })
        .toBuffer()

      return { pic1: pic1Buffer, pic2: pic2Buffer }
    } catch {
      const pic1Buffer = await sharp(imageBuffer).jpeg({ quality: 85 }).toBuffer()
      return { pic1: pic1Buffer, pic2: null }
    }
  } else {
    // ── GOPRO / FLAT PHOTO PROCESSING ─────────────────────────────────────────
    // Duas fontes de foto diferentes acabam nesse branch (aspect ~4:3, não 2:1):
    //
    // 1) Location < 11m (perto da raiz): o robô não capta bem essa faixa, então
    //    é fotografado por uma GoPro à parte — a coordenada do Excel já é pixel
    //    nativo da própria foto achatada. Nenhuma correção necessária.
    // 2) Location >= 11m: a foto é o recorte pinhole (5568×4176) que o Arthnex
    //    renderiza a partir da captura 360 do robô — mas a coordenada do Excel
    //    continua sendo equirretangular BRUTA (mesma fonte 4K do
    //    `resolveCamera`/`toCameraRay` do Arthnex), não pixel da foto achatada.
    //
    // O corte em 11m e a resolução de origem 3840×1920 (4K, 2:1) vieram de
    // calibração: extraímos a posição real de 85 defeitos reais (3 turbinas, a
    // partir da imagem marcada que o Arthnex embute no relatório em PDF) e
    // cruzamos com a distância — abaixo de 11m a coordenada já bate 1:1 com a
    // foto (erro ~3%), acima disso só bate depois de rodar
    // `equirectPolygonToPinhole` com essa resolução de origem (erro mediano
    // ~25px num frame de 5568px, ~0,5%). Aplicar a projeção também nos casos
    // <11m foi o que causou a distorção reportada depois do fix anterior.
    const isRootGoPro = locationM < 11

    let pixelPoints: PolygonPoint[]
    if (isRootGoPro) {
      const sx = width / 5568.0
      const sy = height / 4176.0
      pixelPoints = points.map((p) => ({
        x: Math.round(p.x * sx),
        y: Math.round(Math.abs(p.y) * sy)
      }))
    } else {
      const SRC_W = 3840
      const SRC_H = 1920
      const equirectPoints: PolygonPoint[] = points.map((p) => ({ x: p.x, y: Math.abs(p.y) }))
      const projected = equirectPoints.length >= 3
        ? equirectPolygonToPinhole(equirectPoints, SRC_W, SRC_H)
        : equirectPoints

      // equirectPolygonToPinhole trabalha sempre em espaço 5568×4176 — escala
      // pro tamanho real da foto baixada (quase sempre já é 5568×4176, mas nem
      // toda foto do export é).
      const sx = width / 5568.0
      const sy = height / 4176.0
      pixelPoints = projected.map((p) => ({
        x: Math.round(p.x * sx),
        y: Math.round(p.y * sy)
      }))
    }

    // pic1: FULL original photo showing all regions with red polygon drawn on top
    const thickness = Math.max(8, Math.round(width / 300))
    const overlay = buildPolygonOverlaySvg([...pixelPoints, pixelPoints[0]], width, height, thickness)

    const pic1Buffer = await sharp(imageBuffer)
      .composite([{ input: overlay }])
      .jpeg({ quality: 85 })
      .toBuffer()

    // pic2: Contextual ZOOM crop centered on defect bounding box
    const xs   = pixelPoints.map((p) => p.x)
    const ys   = pixelPoints.map((p) => p.y)
    const minX = Math.max(0, Math.min(...xs))
    const maxX = Math.min(width, Math.max(...xs))
    const minY = Math.max(0, Math.min(...ys))
    const maxY = Math.min(height, Math.max(...ys))

    const polyW = maxX - minX || 1
    const polyH = maxY - minY || 1

    const cx = Math.round((minX + maxX) / 2)
    const cy = Math.round((minY + maxY) / 2)

    const cropW = Math.min(width,  Math.max(Math.round(width / 2.2), Math.round(polyW * 2.8)))
    const cropH = Math.min(height, Math.max(Math.round(height / 2.2), Math.round(polyH * 2.8)))

    let left = Math.max(0, cx - Math.round(cropW / 2))
    let top  = Math.max(0, cy - Math.round(cropH / 2))

    if (left + cropW > width)  left = width - cropW
    if (top  + cropH > height) top  = height - cropH
    left = Math.max(0, left)
    top  = Math.max(0, top)

    const extractW = Math.min(cropW, width - left)
    const extractH = Math.min(cropH, height - top)

    const pic2Buffer = await sharp(imageBuffer)
      .extract({ left, top, width: extractW, height: extractH })
      .resize(width, height)
      .jpeg({ quality: 85 })
      .toBuffer()

    return { pic1: pic1Buffer, pic2: pic2Buffer }
  }
}

export class SnowPhotoProcessor {
  async download(params: DownloadParams, log: (msg: string, type?: string) => void): Promise<boolean> {
    const {
      turbineSn, bladeSn, bladeSection, bladeArea,
      dfStart, dfEnd, photoUrl, coordinatesJson, surface, photosFolder
    } = params

    if (!photoUrl) return false

    const folder = path.join(photosFolder, String(turbineSn), String(bladeSn))
    fs.mkdirSync(folder, { recursive: true })

    const areaCode = SnowMappings.areaToFileCode(bladeArea)
    const paddedBladeSn = String(bladeSn).replace(/^B/i, '').padStart(4, '0')
    const bladeCode = `B${paddedBladeSn}`
    
    let secCode = 'S1'
    if (bladeSection === 'Section 2') secCode = 'S2'
    else if (bladeSection === 'Section 3') secCode = 'S3'
    else if (bladeSection.match(/^Section\s*(\d+)$/i)) {
      const match = bladeSection.match(/^Section\s*(\d+)$/i)
      if (match) secCode = `S${match[1]}`
    } else if (bladeSection.match(/^S\d+$/i)) {
      secCode = bladeSection.toUpperCase()
    }

    const baseName = `${bladeCode}_${secCode}_${areaCode}_DF${dfStart}-${dfEnd}`

    try {
      const imageBuffer = await fetchImageBuffer(photoUrl)

      let pic1Buffer: Buffer | null = imageBuffer
      let pic2Buffer: Buffer | null = null

      if (coordinatesJson) {
        try {
          const result = await createMarkedImages(imageBuffer, coordinatesJson, surface, dfStart)
          pic1Buffer = result.pic1
          pic2Buffer = result.pic2
        } catch (err: any) {
          log(`  ⚠ Erro ao marcar imagem (${baseName}): ${err.message}`, 'warning')
          pic1Buffer = imageBuffer
        }
      } else {
        log(`  ⚠ Sem coordenadas — pic1 sem marcação: ${baseName}`, 'warning')
      }

      if (pic1Buffer) {
        fs.writeFileSync(path.join(folder, `${baseName}_pic1.jpeg`), pic1Buffer)
        log(`  ✓ pic1: ${baseName}_pic1.jpeg`, 'success')
      }
      if (pic2Buffer) {
        fs.writeFileSync(path.join(folder, `${baseName}_pic2.jpeg`), pic2Buffer)
        log(`  ✓ pic2: ${baseName}_pic2.jpeg`, 'success')
      }

      return true
    } catch (err: any) {
      log(`  ✗ Erro no download (${baseName}): ${err.message}`, 'error')
      return false
    }
  }

  async addBlankImage(photosFolder: string) {
    const dst = path.join(photosFolder, 'Blank Image.jpg')
    const pathsToCheck = [
      path.join(__dirname, '..', '..', 'resources', 'blank_image.jpg'),
      path.join(__dirname, '..', '..', '..', 'resources', 'blank_image.jpg'),
      path.join(__dirname, 'resources', 'blank_image.jpg'),
      path.join(process.cwd(), 'resources', 'blank_image.jpg')
    ]

    for (const src of pathsToCheck) {
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, dst)
          return
        } catch {
          // ignore and fall through
        }
      }
    }

    // Generate a real 800x600 white JPEG image using sharp
    try {
      const whiteBuffer = await sharp({
        create: {
          width: 800,
          height: 600,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      })
      .jpeg({ quality: 90 })
      .toBuffer()

      fs.writeFileSync(dst, whiteBuffer)
    } catch {
      // Fallback: valid 1x1 white JPEG buffer
      const white1x1Jpg = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
        0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
        0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
        0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
        0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
        0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
        0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
        0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
        0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
        0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
        0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x01, 0x7d, 0x01,
        0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13,
        0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23,
        0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82,
        0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29,
        0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46,
        0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a,
        0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76,
        0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a,
        0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4,
        0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7,
        0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
        0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3,
        0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5,
        0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x0c, 0x01, 0x01, 0x00,
        0x00, 0x3f, 0x00, 0xfb, 0xd2, 0x8a, 0x28, 0xaf, 0xff, 0xd9
      ])
      fs.writeFileSync(dst, white1x1Jpg)
    }
  }
}

// ─── MAIN PROCESSOR FUNCTION ─────────────────────────────────────────────────

const BLANK_TURBINE_SN = 'VSR07-06'

const OUTPUT_HEADERS = [
  'Blade serial number',
  'Sub Component',
  'Failure Type',
  'Damage Description',
  'DF distance - Start (m)',
  'DF distance - End (m)',
  'Profile Depth (%) Start',
  'Profile Depth (%) End',
  'Inside/Outside',
  'Blade section',
  'Blade sub-section',
  'Blade area',
  'Size (mm)',
  'Link das fotos',
  'Turbine SN',
  'POI',
  'SNOW Entry #',
]

// "SNOW Entry #" (coluna 17) é reservada aqui em branco de propósito — o Módulo 24
// (snowAutomation.ts) escreve nela o número da entrada (ex.: "DAM1115650") assim que
// confirma a submissão automática de uma linha. Vira a ÚNICA fonte de verdade de "essa
// linha já foi submetida" — substitui o antigo histórico local em JSON
// (snow_submitted_rows.json), que podia ficar desatualizado/discordar da planilha.
const COLUMN_WIDTHS = [22, 28, 28, 55, 18, 18, 18, 18, 16, 18, 18, 18, 14, 50, 20, 15, 18]

function toFloat(val: any): number | null {
  if (val === null || val === undefined || val === '') return null
  const s = String(val).replace(',', '.')
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

/** Cliente só aceita 1 casa decimal nos campos de distância (DF) — padrão deles. */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function getHeaderMap(worksheet: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>()
  const headerRow = worksheet.getRow(1)
  headerRow.eachCell((cell, colNum) => {
    const val = String(cell.value ?? '').trim().toLowerCase()
    if (val) map.set(val, colNum)
  })
  return map
}

function getCellByCol(row: ExcelJS.Row, col: number): any {
  const cell = row.getCell(col)
  return cell.value
}

function getCellByHeader(row: ExcelJS.Row, headerMap: Map<string, number>, header: string): any {
  const col = headerMap.get(header.toLowerCase())
  if (!col) return null
  return row.getCell(col).value
}

/**
 * Normaliza o ID do aerogerador para o formato padrão do cliente, ex: VSR05-06 ou VSR-05-06
 */
function getNormalizedTurbineId(rawId: string): string {
  let clean = String(rawId || '').trim()
  if (clean.toUpperCase().startsWith('WTG-')) {
    clean = clean.substring(4)
  }
  // Ensure formatted nicely
  const match = clean.match(/^VSR-?(\d{2})-?(\d{2})$/i)
  if (match) {
    return `VSR-${match[1]}-${match[2]}`
  }
  return clean || 'UNKNOWN'
}

export async function processSnowExcel(
  excelPath: string,
  outputDir: string,
  sender?: Electron.WebContents
): Promise<SnowProcessResult> {
  const sendLog = (message: string, type = 'info') => {
    if (sender) sender.send('snow_progress', { message, type })
  }
  const sendProgress = (current: number, total: number) => {
    if (sender) sender.send('snow_progress', { current, total })
  }

  if (!fs.existsSync(excelPath)) {
    return { success: false, rowsProcessed: 0, rowsSkipped: 0, photosOk: 0, photosSkipped: 0, outputPath: '', photosFolder: '', error: `Arquivo não encontrado: ${excelPath}` }
  }

  // Load input workbook to inspect first
  sendLog(`Abrindo planilha: ${path.basename(excelPath)}...`)
  const inWb = new ExcelJS.Workbook()
  await inWb.xlsx.readFile(excelPath)
  const inWs = inWb.worksheets[0]
  if (!inWs) {
    return { success: false, rowsProcessed: 0, rowsSkipped: 0, photosOk: 0, photosSkipped: 0, outputPath: '', photosFolder: '', error: 'Planilha vazia.' }
  }

  const headerMap = getHeaderMap(inWs)

  // Detect Turbine ID from sheet rows
  let turbineId = 'UNKNOWN'
  for (let rowNum = 2; rowNum <= inWs.rowCount; rowNum++) {
    const row = inWs.getRow(rowNum)
    const val = getCellByCol(row, 8) // col H (turbine_sn)
    if (val && String(val).trim() !== '') {
      turbineId = getNormalizedTurbineId(String(val))
      break
    }
  }

  if (turbineId === 'UNKNOWN') {
    // Try to extract from filename
    const filenameMatch = path.basename(excelPath).match(/VSR[-_0-9]+/i)
    if (filenameMatch) {
      turbineId = getNormalizedTurbineId(filenameMatch[0])
    }
  }

  sendLog(`Turbina detectada para esta planilha: ${turbineId}`, 'success')

  // Resolve structured output paths
  const turbineOutputDir = path.join(outputDir, turbineId)
  const outExcelPath = path.join(turbineOutputDir, `${turbineId}_Novo_Excel.xlsx`)
  const photosFolder = path.join(turbineOutputDir, 'Fotos')
  
  fs.mkdirSync(turbineOutputDir, { recursive: true })
  fs.mkdirSync(photosFolder, { recursive: true })

  // Create output workbook
  const outWb = new ExcelJS.Workbook()
  const outWs = outWb.addWorksheet('Inspection')

  // Write header row
  const headerRow = outWs.addRow(OUTPUT_HEADERS)
  headerRow.eachCell((cell) => {
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } }
  })
  OUTPUT_HEADERS.forEach((_, idx) => {
    outWs.getColumn(idx + 1).width = COLUMN_WIDTHS[idx]
  })

  const photoProcessor = new SnowPhotoProcessor()
  let rowsProcessed = 0
  let rowsSkipped = 0
  let photosOk = 0
  let photosSkipped = 0

  const photoDownloadQueue: DownloadParams[] = []
  const nameCounts = new Map<string, number>()

  // Unique blades set for Video rows generation
  const uniqueBladesMap = new Map<string, { fullBladeSerial: string; shortSn: string; setNumber: string }>()

  for (let rowNum = 2; rowNum <= inWs.rowCount; rowNum++) {
    const row = inWs.getRow(rowNum)

    const turbineSn   = String(getCellByCol(row, 8) ?? '').trim()   // col H
    const bladeSn     = getCellByCol(row, 13)                         // col M
    const section     = String(getCellByCol(row, 17) ?? '').trim()   // col Q
    const side        = String(getCellByCol(row, 18) ?? '').trim()   // col R
    const component   = String(getCellByCol(row, 19) ?? '').trim()   // col S
    const photoLink   = String(getCellByCol(row, 20) ?? '').trim()   // col T
    const poi         = getCellByCol(row, 21)                         // col U
    const origFail    = String(getCellByCol(row, 22) ?? '').trim()   // col V
    const severityRaw = getCellByCol(row, 24)                        // col X
    const dfStartRaw  = getCellByCol(row, 25)                         // col Y
    const sizeMmRaw   = getCellByCol(row, 26)                         // col Z
    const polygonRaw  = getCellByHeader(row, headerMap, 'Polygon Data/Coordinates')
    const surface     = String(getCellByHeader(row, headerMap, 'Surface') ?? '').trim()

    // Filter: severity must be 1–5
    const severity = toFloat(severityRaw)
    if (severity === null || ![1, 2, 3, 4, 5].includes(Math.round(severity))) {
      rowsSkipped++
      continue
    }

    // Filter: blade_sn must exist
    if (bladeSn === null || bladeSn === undefined || String(bladeSn).trim() === '') {
      rowsSkipped++
      continue
    }

    const dfStart = round1(toFloat(dfStartRaw) ?? 0)
    const sizeMm  = toFloat(sizeMmRaw) ?? 0

    const subComponent  = SnowMappings.getSubComponent(component) // Dynamic component mapping!
    const failureType   = SnowMappings.getFailure(origFail, subComponent)
    const damageDesc    = SnowMappings.getDamageDescription(bladeSn, origFail, turbineSn)
    const dfEnd         = SnowMappings.getDfEnd(dfStart, sizeMm)
    const profileDepth  = SnowMappings.getProfileFromCoordinates(
      section, side, component, polygonRaw ? String(polygonRaw) : '', dfStart
    )
    const bladeSection  = SnowMappings.getBladeSection(section)
    const bladeSubsec   = SnowMappings.getBladeSubsection(component)
    const bladeArea     = SnowMappings.getBladeArea(component, side)

    const bladeInfo = getBladeInfo(bladeSn, turbineSn)
    const fullBladeSerial = bladeInfo.serial || String(bladeSn)
    const paddedBladeSn = String(bladeSn).replace(/^B/i, '').padStart(4, '0')
    const setNumberStr = bladeInfo.setNumber ? String(bladeInfo.setNumber).padStart(2, '0') : '00'

    if (!uniqueBladesMap.has(paddedBladeSn)) {
      uniqueBladesMap.set(paddedBladeSn, {
        fullBladeSerial,
        shortSn: paddedBladeSn,
        setNumber: setNumberStr
      })
    }

    const dfStartStr = dfStart.toFixed(1)
    const dfEndStr   = dfEnd.toFixed(1)

    // Add row to excel
    const newRow = outWs.addRow([
      fullBladeSerial,           // A — Blade serial number (13 dígitos se disponível)
      subComponent,              // B — Sub Component
      failureType,               // C — Failure Type
      damageDesc,                // D — Damage Description
      dfStartStr,                // E — DF distance Start (string formatada com ponto)
      dfEndStr,                  // F — DF distance End (string formatada com ponto)

      profileDepth,              // G — Profile Depth Start
      profileDepth,              // H — Profile Depth End (same value)
      'Inside',                  // I — Inside/Outside
      bladeSection,              // J — Blade section
      bladeSubsec,               // K — Blade sub-section
      bladeArea,                 // L — Blade area
      sizeMm,                    // M — Size mm
      photoLink || null,         // N — Link das fotos
      turbineSn,                 // O — Turbine SN
      poi ?? null,               // P — POI
    ])

    // Apply soft red highlight if it's Delamination >= 45m
    if (SnowMappings.shouldHighlight(failureType, dfStart)) {
      newRow.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7C7' } // Light soft red highlight
        }
      })
    }

    rowsProcessed++

    // Enqueue photo download parameters with unique sequential pic names
    if (photoLink) {
      const areaCode = SnowMappings.areaToFileCode(bladeArea)
      const bladeCode = `B${paddedBladeSn}`

      let secCode = 'S1'
      if (bladeSection === 'Section 2') secCode = 'S2'
      else if (bladeSection === 'Section 3') secCode = 'S3'
      else if (bladeSection.match(/^Section\s*(\d+)$/i)) {
        const match = bladeSection.match(/^Section\s*(\d+)$/i)
        if (match) secCode = `S${match[1]}`
      } else if (bladeSection.match(/^S\d+$/i)) {
        secCode = bladeSection.toUpperCase()
      }

      const baseName = `${bladeCode}_${secCode}_${areaCode}_DF${dfStart}-${dfEnd}`
      const folderKey = `${turbineSn}/${bladeSn}/${baseName}`
      const existingCount = nameCounts.get(folderKey) || 0
      nameCounts.set(folderKey, existingCount + 1)

      const pic1Index = existingCount * 2 + 1
      const pic2Index = existingCount * 2 + 2

      const pic1Name = `${baseName}_pic${pic1Index}.jpeg`
      const pic2Name = `${baseName}_pic${pic2Index}.jpeg`


      photoDownloadQueue.push({
        turbineSn,
        bladeSn: String(bladeSn),
        bladeSection,
        bladeArea,
        dfStart,
        dfEnd,
        photoUrl: photoLink,
        coordinatesJson: polygonRaw ? String(polygonRaw) : '',
        surface,
        photosFolder,
        baseName,
        pic1Name,
        pic2Name,
      })
    } else {
      photosSkipped++
    }
  }

  // Create empty Videos directory for turbine
  const videosFolder = path.join(path.dirname(photosFolder), 'Videos')
  fs.mkdirSync(videosFolder, { recursive: true })

  // Add 4 Video rows per unique blade (S1 PS, S1 SS, S2 PS, S2 SS) with strict DF45-50 nomenclature
  const videoVariants = [
    { sec: 'Section 1', area: 'PS', secCode: 'S1', areaCode: 'PS' },
    { sec: 'Section 1', area: 'SS', secCode: 'S1', areaCode: 'SS' },
    { sec: 'Section 2', area: 'PS', secCode: 'S2', areaCode: 'PS' },
    { sec: 'Section 2', area: 'SS', secCode: 'S2', areaCode: 'SS' }
  ]

  for (const [, bInfo] of uniqueBladesMap) {
    const videoDamageDesc = [
      'Inspection as per SN_241',
      `Blade: S/N${bInfo.shortSn} Set ${bInfo.setNumber}`,
      'Inspection number: 1',
      'Type of Failure is Missing'
    ].join('\n')

    for (const v of videoVariants) {
      const videoFileName = `B${bInfo.shortSn}_${v.secCode}_${v.areaCode}_DF45_DF50.mp4`


      outWs.addRow([
        bInfo.fullBladeSerial,         // A — Blade serial number
        'Blade Inside - Shell',        // B — Sub Component
        'Type of Failure is Missing',  // C — Failure Type
        videoDamageDesc,               // D — Damage Description
        45,                            // E — DF distance Start (STRICTLY 45)
        50,                            // F — DF distance End (STRICTLY 50)
        0,                             // G — Profile Depth Start
        0,                             // H — Profile Depth End
        'Inside',                      // I — Inside/Outside
        v.sec,                         // J — Blade section ("Section 1" / "Section 2")
        'Shell',                       // K — Blade sub-section
        v.area,                        // L — Blade area ("PS" / "SS")
        0,                             // M — Size mm
        videoFileName,                 // N — Video filename requirement
        null,                          // O — Turbine SN
        null                           // P — POI
      ])
    }
  }

  // Add 5 blank image rows
  for (let i = 0; i < 5; i++) {
    outWs.addRow([
      'Blank Image',                    // A
      'Blade Inside - Shell',           // B
      'Type of Failure is Missing',     // C
      'Empty entry',                    // D
      1,                                // E
      1,                                // F
      1,                                // G
      1,                                // H
      'Inside',                         // I
      'Section 1',                      // J
      'Shell',                          // K
      'SS',                             // L
      0,                                // M
      null,                             // N
      i === 0 ? BLANK_TURBINE_SN : null, // O
      null,                             // P
    ])
  }



  // Save the Excel file
  sendLog(`Gravando planilha em: ${path.basename(outExcelPath)}...`)
  await outWb.xlsx.writeFile(outExcelPath)

  // Copy blank image asset
  await photoProcessor.addBlankImage(photosFolder)

  // Download photos using parallel execution pool (limit = 10) first (purely I/O bound)
  const totalDownloads = photoDownloadQueue.length
  sendLog(`Iniciando downloads concorrentes: ${totalDownloads} fotos na fila.`)

  const buffers: (Buffer | null)[] = new Array(totalDownloads).fill(null)
  const CONCURRENCY_LIMIT = 10
  let downloadIndex = 0
  let downloadedCount = 0

  async function downloadWorker() {
    while (downloadIndex < totalDownloads) {
      const currentIdx = downloadIndex++
      const params = photoDownloadQueue[currentIdx]
      try {
        buffers[currentIdx] = await fetchImageBuffer(params.photoUrl)
        downloadedCount++
        sendProgress(downloadedCount, totalDownloads)
        sendLog(`  ✓ Baixado (${downloadedCount}/${totalDownloads}): ${params.photoUrl.substring(params.photoUrl.lastIndexOf('/') + 1)}`, 'success')
      } catch (err: any) {
        downloadedCount++
        sendProgress(downloadedCount, totalDownloads)
        sendLog(`  ⚠ Falha no download (${downloadedCount}/${totalDownloads}): ${params.photoUrl.substring(params.photoUrl.lastIndexOf('/') + 1)} - ${err.message}`, 'warning')
      }
    }
  }

  // Run download workers in parallel
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.min(CONCURRENCY_LIMIT, totalDownloads); w++) {
    workers.push(downloadWorker())
  }
  await Promise.all(workers)

  // Stage 2: Process images and apply coordinate drawing.
  // sharp/libvips runs decode, crop, resize and encode on its own native
  // thread pool (not the JS main thread), so dispatching several photos
  // concurrently here — same pool pattern as the download stage — actually
  // uses the machine's CPU cores instead of processing one photo at a time.
  sendLog(`Iniciando processamento de imagens e marcação de polígonos...`)
  const PROCESS_CONCURRENCY = Math.max(2, Math.min(os.cpus().length, 8))
  let processIndex = 0
  let processedCount = 0

  async function processWorker() {
    while (processIndex < totalDownloads) {
      const i = processIndex++
      const params = photoDownloadQueue[i]
      const buffer = buffers[i]
      if (!buffer) {
        photosSkipped++
        processedCount++
        continue
      }

      const folder = path.join(params.photosFolder, String(params.turbineSn), String(params.bladeSn))
      fs.mkdirSync(folder, { recursive: true })

      const baseName = params.baseName || `B${String(params.bladeSn).padStart(4, '0')}_DF${params.dfStart}-${params.dfEnd}`
      const pic1Name = params.pic1Name || `${baseName}_pic1.jpeg`
      const pic2Name = params.pic2Name || `${baseName}_pic2.jpeg`

      try {
        let pic1Buffer: Buffer | null = buffer
        let pic2Buffer: Buffer | null = null

        if (params.coordinatesJson) {
          try {
            const result = await createMarkedImages(buffer, params.coordinatesJson, params.surface, params.dfStart)
            pic1Buffer = result.pic1
            pic2Buffer = result.pic2
          } catch (err: any) {
            sendLog(`  ⚠ Erro ao marcar imagem (${baseName}): ${err.message}`, 'warning')
            pic1Buffer = buffer
          }
        }

        if (pic1Buffer) {
          fs.writeFileSync(path.join(folder, pic1Name), pic1Buffer)
        }
        if (pic2Buffer) {
          fs.writeFileSync(path.join(folder, pic2Name), pic2Buffer)
        }
        photosOk++
        processedCount++
        sendLog(`  ✓ Processado e salvo (${processedCount}/${totalDownloads}): ${pic1Name}`, 'success')
      } catch (err: any) {
        processedCount++
        sendLog(`  ✗ Erro no processamento (${baseName}): ${err.message}`, 'error')
        photosSkipped++
      }
    }
  }


  const processWorkers: Promise<void>[] = []
  for (let w = 0; w < Math.min(PROCESS_CONCURRENCY, totalDownloads); w++) {
    processWorkers.push(processWorker())
  }
  await Promise.all(processWorkers)

  sendLog(`Planilha ${turbineId} finalizada! Linhas: ${rowsProcessed} processadas, ${rowsSkipped} ignoradas. Fotos: ${photosOk} OK, ${photosSkipped} puladas.`, 'success')

  return {
    success: true,
    rowsProcessed,
    rowsSkipped,
    photosOk,
    photosSkipped,
    outputPath: outExcelPath,
    photosFolder,
  }
}

/**
 * Processamento assíncrono em lote (batch processing) de múltiplas planilhas
 */
export async function processSnowExcelBatch(
  excelPaths: string[],
  outputDir: string,
  sender?: Electron.WebContents
): Promise<{ success: boolean; results: SnowProcessResult[]; error?: string }> {
  const sendLog = (message: string, type = 'info') => {
    if (sender) sender.send('snow_progress', { message, type })
  }
  const sendBatchStatus = (current: number, total: number) => {
    if (sender) sender.send('snow_batch_status', { current, total })
  }

  sendLog(`Iniciando processamento em lote para ${excelPaths.length} planilhas...`, 'info')
  sendBatchStatus(0, excelPaths.length)
  
  const results: SnowProcessResult[] = []
  
  for (let i = 0; i < excelPaths.length; i++) {
    const excelPath = excelPaths[i]
    sendLog(`[Batch ${i+1}/${excelPaths.length}] Processando arquivo: ${path.basename(excelPath)}...`, 'info')
    
    try {
      const res = await processSnowExcel(excelPath, outputDir, sender)
      results.push(res)
    } catch (e: any) {
      sendLog(`[Batch ${i+1}/${excelPaths.length}] Falha no arquivo ${path.basename(excelPath)}: ${e.message}`, 'error')
      results.push({
        success: false,
        rowsProcessed: 0,
        rowsSkipped: 0,
        photosOk: 0,
        photosSkipped: 0,
        outputPath: '',
        photosFolder: '',
        error: e.message
      })
    }
    
    sendBatchStatus(i + 1, excelPaths.length)
  }
  
  sendLog(`Processamento em lote finalizado. Total planilhas: ${excelPaths.length}.`, 'success')
  return { success: true, results }
}
