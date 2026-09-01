/**
 * Polygon reprojection utilities — ported from the Arthnex platform class
 * (the exact reference implementation used by Arthnex to draw defect
 * polygons), backed by `sharp`/libvips instead of Jimp.
 *
 * Converts defect polygon coordinates from equirectangular (spherical) space
 * to flat pinhole image coordinates (5568×4176).
 *
 * Also provides `renderEquirectPinhole` which renders the perspective view
 * from an equirectangular panorama, matching exactly what the Arthnex
 * platform displays when the user navigates to a defect.
 */

import sharp from 'sharp'

export type PolygonPoint = { x: number; y: number }

export const PINHOLE_WIDTH = 5568
export const PINHOLE_HEIGHT = 4176

const ASPECT = PINHOLE_WIDTH / PINHOLE_HEIGHT
const MIN_HFOV_DEG = 90
const MAX_HFOV_DEG = 140
const FRAME_MARGIN = 1.1
const MIN_RAY_Z = Math.cos((80 * Math.PI) / 180)

type CameraRay = { x: number; y: number; z: number }

type PinholeCamera = {
  centerYaw: number
  centerPitch: number
  focalX: number
  focalY: number
}

export interface RawEquirectRender {
  data: Buffer
  info: { width: number; height: number; channels: 3 | 4 }
}

/** Safely parses a JSON polygon string into an array of points. */
export function parsePolygon(polygon: string | null): PolygonPoint[] {
  if (!polygon) return []
  try {
    const parsed = JSON.parse(polygon)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Computes the centroid of a polygon in equirectangular space, correcting for
 * horizontal wrap-around at the panorama seam.
 */
export function equirectPolygonCenter(
  points: PolygonPoint[],
  panoWidth: number
): PolygonPoint {
  const y = points.reduce((sum, point) => sum + point.y, 0) / points.length
  const reference = points[0].x
  const half = panoWidth / 2

  const offset =
    points.reduce((sum, point) => {
      const dx = point.x - reference
      if (dx > half) return sum + dx - panoWidth
      if (dx < -half) return sum + dx + panoWidth
      return sum + dx
    }, 0) / points.length

  return {
    x: (((reference + offset) % panoWidth) + panoWidth) % panoWidth,
    y,
  }
}

/**
 * Projects a polygon from equirectangular pixel coordinates onto the virtual
 * pinhole image plane (PINHOLE_WIDTH × PINHOLE_HEIGHT).
 * This is the main entry point for coordinate correction.
 */
export function equirectPolygonToPinhole(
  points: PolygonPoint[],
  srcWidth: number,
  srcHeight: number
): PolygonPoint[] {
  if (points.length < 3) return points

  const camera = resolveCamera(points, srcWidth, srcHeight)
  const rays = points.map(point =>
    toCameraRay(point, srcWidth, srcHeight, camera)
  )

  const projected = clipToCameraFront(rays).map(ray => ({
    x: (ray.x / ray.z) * camera.focalX + PINHOLE_WIDTH / 2,
    y: PINHOLE_HEIGHT / 2 - (ray.y / ray.z) * camera.focalY,
  }))

  const clipped = clipToFrame(projected)

  return clipped.map(point => ({
    x: Math.round(point.x),
    y: Math.round(point.y),
  }))
}

/**
 * Renders a perspective view from an equirectangular panorama buffer, centered
 * on the given polygon. Matches the Arthnex platform rendering exactly.
 *
 * Returns the raw (undecoded) pixel buffer instead of an already-encoded
 * image so the caller can composite the defect outline (e.g. via an SVG
 * overlay) before a single final encode — avoids an extra decode/encode
 * round-trip per photo.
 *
 * @param srcBuffer  Raw JPEG/PNG buffer of the equirectangular panorama
 * @param points     Defect polygon in equirectangular pixel space
 */
export async function renderEquirectPinhole(
  srcBuffer: Buffer,
  points: PolygonPoint[]
): Promise<RawEquirectRender> {
  const src = sharp(srcBuffer)
  const metadata = await src.metadata()
  if (!metadata.width || !metadata.height) {
    throw new Error('Unable to read image dimensions')
  }

  const srcW: number = metadata.width
  const srcH: number = metadata.height
  const channels = (metadata.channels === 4 ? 4 : 3) as 3 | 4

  const camera = resolveCamera(points, srcW, srcH)
  const outW = PINHOLE_WIDTH
  const outH = PINHOLE_HEIGHT

  const cosYaw = Math.cos(camera.centerYaw)
  const sinYaw = Math.sin(camera.centerYaw)
  const cosPitch = Math.cos(camera.centerPitch)
  const sinPitch = Math.sin(camera.centerPitch)

  const { data: srcData } = await src
    .raw()
    .toBuffer({ resolveWithObject: true })
  const srcStride = srcW * channels

  const dstData = Buffer.alloc(outW * outH * channels)

  for (let py = 0; py < outH; py++) {
    const rayYNorm = (outH / 2 - py) / camera.focalY

    for (let px = 0; px < outW; px++) {
      const rayX = (px - outW / 2) / camera.focalX
      const rayY = rayYNorm
      const len = Math.sqrt(rayX * rayX + rayY * rayY + 1)
      const nx = rayX / len
      const ny = rayY / len
      const nz = 1 / len

      // Undo pitch rotation (inverse of forward pitch in toCameraRay)
      const y2 = ny * cosPitch - nz * sinPitch
      const z2 = ny * sinPitch + nz * cosPitch

      // Undo yaw rotation (inverse of forward yaw in toCameraRay)
      const x3 = nx * cosYaw + z2 * sinYaw
      const z3 = -nx * sinYaw + z2 * cosYaw

      // World → equirectangular UV
      const theta = Math.atan2(x3, z3)
      const phi = Math.asin(y2 < -1 ? -1 : y2 > 1 ? 1 : y2)

      const u = (theta / Math.PI + 1) * 0.5
      const v = 0.5 - phi / Math.PI

      const sx = u * (srcW - 1)
      const sy = v * (srcH - 1)

      const x0 = sx | 0
      const y0 = sy | 0
      const x1 = x0 < srcW - 1 ? x0 + 1 : srcW - 1
      const y1 = y0 < srcH - 1 ? y0 + 1 : srcH - 1
      const dx = sx - x0
      const dy = sy - y0
      const dx1 = 1 - dx
      const dy1 = 1 - dy

      const off00 = y0 * srcStride + x0 * channels
      const off10 = y0 * srcStride + x1 * channels
      const off01 = y1 * srcStride + x0 * channels
      const off11 = y1 * srcStride + x1 * channels

      const w00 = dx1 * dy1
      const w10 = dx * dy1
      const w01 = dx1 * dy
      const w11 = dx * dy

      const idx = (py * outW + px) * channels
      for (let c = 0; c < channels; c++) {
        dstData[idx + c] = Math.round(
          srcData[off00 + c] * w00 +
            srcData[off10 + c] * w10 +
            srcData[off01 + c] * w01 +
            srcData[off11 + c] * w11
        )
      }
    }
  }

  return { data: dstData, info: { width: outW, height: outH, channels } }
}

// ─── Private helpers ────────────────────────────────────────────────────────

function resolveCamera(
  points: PolygonPoint[],
  srcWidth: number,
  srcHeight: number
): PinholeCamera {
  const center = equirectPolygonCenter(points, srcWidth)
  const orientation = {
    centerYaw: ((center.x / srcWidth) * 2 - 1) * Math.PI,
    centerPitch: (center.y / srcHeight - 0.5) * Math.PI,
  }

  let hfovDeg = MIN_HFOV_DEG
  for (const point of points) {
    const ray = toCameraRay(point, srcWidth, srcHeight, orientation)
    if (ray.z <= MIN_RAY_Z) {
      hfovDeg = MAX_HFOV_DEG
      break
    }
    hfovDeg = Math.max(
      hfovDeg,
      toDegrees(2 * Math.atan((Math.abs(ray.x) / ray.z) * FRAME_MARGIN)),
      toDegrees(2 * Math.atan((Math.abs(ray.y) / ray.z) * FRAME_MARGIN)) *
        ASPECT
    )
  }
  hfovDeg = Math.min(hfovDeg, MAX_HFOV_DEG)

  return {
    ...orientation,
    focalX: PINHOLE_WIDTH / (2 * Math.tan(toRadians(hfovDeg) / 2)),
    focalY: PINHOLE_HEIGHT / (2 * Math.tan(toRadians(hfovDeg / ASPECT) / 2)),
  }
}

function toCameraRay(
  point: PolygonPoint,
  srcWidth: number,
  srcHeight: number,
  orientation: Pick<PinholeCamera, 'centerYaw' | 'centerPitch'>
): CameraRay {
  const theta = ((point.x / srcWidth) * 2 - 1) * Math.PI
  const phi = (0.5 - point.y / srcHeight) * Math.PI

  const worldX = Math.cos(phi) * Math.sin(theta)
  const worldY = Math.sin(phi)
  const worldZ = Math.cos(phi) * Math.cos(theta)

  const cosYaw = Math.cos(orientation.centerYaw)
  const sinYaw = Math.sin(orientation.centerYaw)
  const cosPitch = Math.cos(orientation.centerPitch)
  const sinPitch = Math.sin(orientation.centerPitch)

  const x = worldX * cosYaw - worldZ * sinYaw
  const z = worldX * sinYaw + worldZ * cosYaw

  return {
    x,
    y: worldY * cosPitch + z * sinPitch,
    z: -worldY * sinPitch + z * cosPitch,
  }
}

function clipToCameraFront(rays: CameraRay[]): CameraRay[] {
  if (rays.length < 3) return rays.filter(ray => ray.z > MIN_RAY_Z)

  const clipped: CameraRay[] = []
  for (let i = 0; i < rays.length; i++) {
    const current = rays[i]
    const next = rays[(i + 1) % rays.length]
    const currentInside = current.z > MIN_RAY_Z
    const nextInside = next.z > MIN_RAY_Z

    if (currentInside) clipped.push(current)
    if (currentInside !== nextInside) {
      const t = (MIN_RAY_Z - current.z) / (next.z - current.z)
      clipped.push({
        x: current.x + (next.x - current.x) * t,
        y: current.y + (next.y - current.y) * t,
        z: MIN_RAY_Z,
      })
    }
  }
  return clipped
}

const FRAME_EDGES = [
  { inside: (p: PolygonPoint) => p.x >= 0, axis: 'x' as const, limit: 0 },
  {
    inside: (p: PolygonPoint) => p.x <= PINHOLE_WIDTH,
    axis: 'x' as const,
    limit: PINHOLE_WIDTH,
  },
  { inside: (p: PolygonPoint) => p.y >= 0, axis: 'y' as const, limit: 0 },
  {
    inside: (p: PolygonPoint) => p.y <= PINHOLE_HEIGHT,
    axis: 'y' as const,
    limit: PINHOLE_HEIGHT,
  },
]

function clipToFrame(polygon: PolygonPoint[]): PolygonPoint[] {
  if (polygon.length < 3) return polygon
  return FRAME_EDGES.reduce((current, edge) => {
    if (!current.length) return current
    const output: PolygonPoint[] = []
    for (let i = 0; i < current.length; i++) {
      const a = current[i]
      const b = current[(i + 1) % current.length]
      const aInside = edge.inside(a)
      if (aInside) output.push(a)
      if (aInside !== edge.inside(b)) {
        const t = (edge.limit - a[edge.axis]) / (b[edge.axis] - a[edge.axis])
        output.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
      }
    }
    return output
  }, polygon)
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI
}
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}
