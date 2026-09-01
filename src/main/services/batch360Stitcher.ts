import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface BatchStitchResult {
  success: boolean
  count: number
  files: string[]
  error?: string
}

/**
 * Localiza a instalação do Insta360 MediaSDK no Linux.
 */
function getMediaSDK(): { bin: string; lib: string; models: string } | null {
  const resPath = process.resourcesPath || ''
  const possibleRoots = [
    // 1. Unpacked asar in packaged electron (real filesystem path)
    path.join(resPath, 'app.asar.unpacked', 'resources', 'mediasdk_linux'),
    path.join(resPath, 'app.asar.unpacked', 'mediasdk_linux'),
    path.join(resPath, 'mediasdk_linux'),
    // 2. Dev mode relative paths
    path.join(__dirname, '..', '..', 'resources', 'mediasdk_linux'),
    path.join(__dirname, '..', 'resources', 'mediasdk_linux'),
    // 3. Fallbacks
    '/home/pedroo/Documentos/GitHub/arthwind-suite-ts/resources/mediasdk_linux',
    '/home/pedroo/Documentos/GitHub/Arthfilm360/backend/mediasdk_linux',
  ]

  for (const root of possibleRoots) {
    if (root.includes('app.asar/') || root.endsWith('app.asar')) continue
    const bin = path.join(root, 'bin', 'MediaSDKTest')
    const lib = path.join(root, 'lib')
    const models = path.join(root, 'models')
    if (fs.existsSync(bin)) {
      try {
        fs.chmodSync(bin, 0o755)
      } catch (_) {}
      return { bin, lib, models }
    }
  }
  return null
}

/**
 * Gera um arquivo .insprj pré-configurado com perfil de alta velocidade (modo Windows):
 * - ai_stitch="0"        → Costura por calibração de modelo (rápida), sem Optical Flow AI
 * - optical_flow_stitching="0" → Sem fluxo óptico (lento)
 * - projection="64"      → Equirretangular 2:1 (formato padrão 360 esférico)
 * - image_fusion="1"     → Fusão de imagem ativa
 */
export function generateInsprjPreset(
  videoPath: string,
  outputPath?: string
): string {
  const videoP = path.resolve(videoPath)
  const folderStr = path.dirname(videoP).replace(/\\/g, '/')
  const fileName = path.basename(videoP)
  const baseName = path.basename(videoP, path.extname(videoP)) // strip .mp4 / .insv
  const outPath =
    outputPath || path.join(path.dirname(videoP), `${baseName}.insprj`)

  const now = new Date()
  const creationStamp = Math.floor(now.getTime() / 1000)
  const dateFmt = now
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19)
    .replace(/-/g, '.')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<project version="2.0.0">
    <meta app="Insta360 Studio 5.9.10" creation_time="${creationStamp}" version="5.9.10"/>
    <file_group cloud_file_set_offset="1" cloud_media_id="${folderStr}/${fileName}" count="1" folder="${folderStr}" image_type="0" is_cloud_file="0" type="video_normal">
        <file name="${fileName}"/>
    </file_group>
    <schemes default="Clip1">
        <scheme app_data_id="" app_data_mode="" app_data_ratio="" app_data_source="" app_data_types="" creation="${dateFmt}" has_deeptrack_user_added="0" has_deeptrack_user_edited="0" has_headtrack_keyframe_user_added="0" has_headtrack_keyframe_user_edited="0" id="Clip1" last_edit_time="${dateFmt}" load_hight_data="0">
            <preference duration="0" favourite="0" last_trim_edit_time="${creationStamp}000" ratio_height="9" ratio_width="16" shell_corrected="0" trim_end="0" trim_start="0">
                <rendering accessory="0" ai_raw="0" alpha="0" blend_angle="0" camera_movement="0" fov="1.3089969158172607" projection="64" roll="0" stabilization="1" yaw="0">
                    <play_rate/>
                </rendering>
                <optimization>
                    <stitching ai_stitch="0" dynamic_stitching="0" image_fusion="1" optical_flow_stitching="0"/>
                </optimization>
            </preference>
        </scheme>
    </schemes>
</project>
`

  fs.writeFileSync(outPath, xml, 'utf-8')
  return outPath
}

/**
 * Escaneia recursivamente um diretório raiz ou processa um arquivo único em busca de
 * vídeos brutos (.insv e .mp4 unstitched) e realiza a costura direta no Linux via MediaSDK
 * ou gera arquivos .insprj.
 */
export async function batchStitchDirectory(
  targetPath: string,
  mode: 'insprj' | 'mediasdk' | 'ffmpeg' | 'auto' = 'auto',
  sender?: Electron.WebContents
): Promise<BatchStitchResult> {
  const sendLog = (message: string, type = 'info') => {
    if (sender) {
      sender.send('batch_stitch_log', { message, type })
    }
  }

  if (!fs.existsSync(targetPath)) {
    return {
      success: false,
      count: 0,
      files: [],
      error: `Arquivo ou pasta não encontrado: ${targetPath}`,
    }
  }

  const rawFiles: string[] = []
  const stat = fs.statSync(targetPath)

  if (stat.isFile()) {
    rawFiles.push(targetPath)
    sendLog(`Arquivo individual selecionado: ${path.basename(targetPath)}`)
  } else if (stat.isDirectory()) {
    sendLog(`Escaneando vídeos 360 brutos na pasta: ${targetPath}`)

    const walk = (dir: string) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.isFile()) {
          const lower = entry.name.toLowerCase()
          if (lower.endsWith('.insv')) {
            rawFiles.push(fullPath)
          } else if (
            lower.endsWith('.mp4') &&
            !lower.includes('_stitched') &&
            !lower.includes('_watermarked') &&
            !lower.includes('_stabilized')
          ) {
            rawFiles.push(fullPath)
          }
        }
      }
    }

    walk(targetPath)
    sendLog(`Encontrados ${rawFiles.length} arquivos brutos 360 na pasta.`)
  }

  if (rawFiles.length === 0) {
    sendLog(`Nenhum vídeo bruto 360 encontrado.`, 'warning')
    return { success: true, count: 0, files: [] }
  }

  const processed: string[] = []
  const mediaSdk = getMediaSDK()
  const useMediaSdk =
    (mode === 'mediasdk' || mode === 'auto') &&
    process.platform === 'linux' &&
    mediaSdk !== null

  if (useMediaSdk && mediaSdk) {
    sendLog(
      `[MediaSDK] Iniciando costura de ${rawFiles.length} vídeo(s)...`,
      'info'
    )

    for (let i = 0; i < rawFiles.length; i++) {
      const videoPath = rawFiles[i]
      const dir = path.dirname(videoPath)
      const baseName = path.basename(videoPath, path.extname(videoPath))
      const outPath = path.join(dir, `${baseName}_stitched.mp4`)

      sendLog(
        `[${i + 1}/${rawFiles.length}] Costurando: ${path.basename(videoPath)} -> ${path.basename(outPath)}...`
      )

      let preload = process.env.LD_PRELOAD || ''
      for (const vk of [
        '/usr/lib/libvulkan.so.1',
        '/usr/lib64/libvulkan.so.1',
        '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
      ]) {
        if (fs.existsSync(vk)) {
          preload = `${vk}:${preload}`.replace(/:+$/, '')
          break
        }
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LD_LIBRARY_PATH: `${mediaSdk.lib}:${process.env.LD_LIBRARY_PATH || ''}`,
      }
      if (preload) {
        env.LD_PRELOAD = preload
      }

      const args = [
        '-inputs',
        videoPath,
        '-output',
        outPath,
        '-model_root_dir',
        `${mediaSdk.models}/`,
        '-stitch_type',
        'template',
        '-enable_flowstate',
        '-enable_directionlock',
        '-output_size',
        '5760x2880',
        '-disable_cuda',
        '-enable_soft_encode',
        '-enable_soft_decode',
      ]

      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(mediaSdk.bin, args, {
            env,
            cwd: path.dirname(mediaSdk.bin),
          })

          proc.stdout.on('data', data => {
            const lines = data.toString().split('\n')
            for (const line of lines) {
              const trimmed = line.trim()
              if (
                trimmed &&
                (trimmed.includes('progress') ||
                  trimmed.includes('%') ||
                  trimmed.includes('frame'))
              ) {
                sendLog(`   [MediaSDK] ${trimmed}`, 'info')
              }
            }
          })

          proc.stderr.on('data', data => {
            const errStr = data.toString().trim()
            if (errStr) sendLog(`   [MediaSDK aviso] ${errStr}`, 'warning')
          })

          proc.on('close', code => {
            if (code === 0 && fs.existsSync(outPath)) {
              sendLog(
                `  ✓ [${i + 1}/${rawFiles.length}] Concluído: ${path.basename(outPath)}`,
                'success'
              )
              processed.push(outPath)
              resolve()
            } else {
              reject(new Error(`Processo finalizou com código ${code}`))
            }
          })

          proc.on('error', err => reject(err))
        })
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        sendLog(
          `  ✗ [${i + 1}/${rawFiles.length}] Falha na costura de ${path.basename(videoPath)}: ${errorMessage}`,
          'error'
        )
      }
    }

    sendLog(
      `Processamento concluído: ${processed.length}/${rawFiles.length} vídeos costurados com sucesso.`,
      'success'
    )
  } else {
    sendLog(`Gerando projetos Insta360 (.insprj)...`)
    for (let i = 0; i < rawFiles.length; i++) {
      const videoPath = rawFiles[i]
      try {
        const insprjPath = generateInsprjPreset(videoPath)
        processed.push(insprjPath)
        sendLog(
          `  ✓ [${i + 1}/${rawFiles.length}] Gerado: ${path.basename(insprjPath)}`,
          'success'
        )
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        sendLog(
          `  ✗ [${i + 1}/${rawFiles.length}] Falha em ${path.basename(videoPath)}: ${errorMessage}`,
          'error'
        )
      }
    }

    sendLog(
      `Concluído! ${processed.length}/${rawFiles.length} projetos .insprj gerados com sucesso.`,
      'success'
    )
  }

  return {
    success: processed.length > 0,
    count: processed.length,
    files: processed,
  }
}
