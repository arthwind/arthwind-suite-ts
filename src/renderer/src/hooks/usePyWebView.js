// hooks/usePyWebView.js — Hook para comunicação com o backend Python via pywebview

import { useCallback, useEffect, useRef, useState } from 'react'

const MAX_LOGS = 500

const mockLog = [
  { type: 'info', text: 'Iniciando processamento...' },
  { type: 'success', text: 'Cache: 142 fotos indexadas' },
  { type: 'success', text: 'DJI_20240315_143201_001.JPG copiada' },
  { type: 'success', text: 'DJI_20240315_143205_002.JPG copiada' },
  {
    type: 'warning',
    text: 'DJI_20240315_143208_003.JPG nao encontrada na pasta',
  },
  { type: 'success', text: '2 imagens organizadas em OUTPUT/' },
]

export default function usePyWebView() {
  const [logs, setLogs] = useState([])
  const [running, setRunning] = useState(false)
  const [ran, setRan] = useState(false)
  const [progress, setProgress] = useState(0)
  const [lastOutput, setLastOutput] = useState('')
  const [gpsLoading, setGpsLoading] = useState(false)
  const [gpsFotos, setGpsFotos] = useState([])
  const [bladeSplitLoading, setBladeSplitLoading] = useState(false)
  const [bladeSplitSuspeitos, setBladeSplitSuspeitos] = useState([])
  const [fotosReconstruirLoading, setFotosReconstruirLoading] = useState(false)
  const [fotosReconstruir, setFotosReconstruir] = useState([])
  const [goproRawLoading, setGoproRawLoading] = useState(false)
  const [goproRawRegioes, setGoproRawRegioes] = useState([])
  const safetyTimerRef = useRef(null)
  const runGuardRef = useRef(false)

  const [isPyWebView, setIsPyWebView] = useState(
    typeof window.pywebview !== 'undefined'
  )

  useEffect(() => {
    if (typeof window.pywebview !== 'undefined') {
      setIsPyWebView(true)
    } else {
      window.addEventListener('pywebviewready', () => setIsPyWebView(true))
    }
  }, [])

  const clearLogs = useCallback(() => {
    setLogs([])
    setRan(false)
    setProgress(0)
    setLastOutput('')
  }, [])

  const addLog = useCallback(entry => {
    setLogs(prev => {
      const next = [...prev, entry]
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
    })
  }, [])

  const handleRun = useCallback(
    (active, filePaths, options, gpsRaiz) => {
      if (isPyWebView) {
        if (runGuardRef.current) return
        runGuardRef.current = true
        setRunning(true)
        setLogs([])
        setRan(false)
        setProgress(-1)

        // Watchdog de 5 minutos SEM atividade (não um prazo fixo pro processo inteiro) —
        // antes disparava mesmo com o processo vivo e progredindo normalmente, só que
        // demorando mais que 5 minutos no total (ex.: organizar 146 vídeos). Cada log ou
        // evento de progresso reseta o relógio; só dispara se realmente ficar 5 minutos
        // sem nenhum sinal de vida.
        const armSafetyTimer = () => {
          if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current)
          safetyTimerRef.current = setTimeout(() => {
            setRunning(false)
            setProgress(0)
            addLog({
              type: 'error',
              text: 'Timeout: processo sem responder há 5 minutos.',
            })
            cleanup()
          }, 300000)
        }

        const onLog = e => {
          addLog(e.detail)
          armSafetyTimer()
          // Detecta caminho de output nas mensagens "Output: C:\..."
          const outMatch = (e.detail.text || '').match(/^Output:\s*(.+)$/i)
          if (outMatch) setLastOutput(outMatch[1].trim())
        }

        const onProgress = e => {
          const { current, total } = e.detail
          if (total > 0) setProgress(Math.round((current / total) * 100))
          armSafetyTimer()
        }

        const cleanup = () => {
          if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current)
          window.removeEventListener('arthlog', onLog)
          window.removeEventListener('arthdone', onDone)
          window.removeEventListener('arthprogress', onProgress)
        }

        armSafetyTimer()

        const onDone = () => {
          cleanup()
          runGuardRef.current = false
          setRunning(false)
          setRan(true)
          setProgress(100)
        }

        window.addEventListener('arthlog', onLog)
        window.addEventListener('arthdone', onDone)
        window.addEventListener('arthprogress', onProgress)

        const api = window.pywebview.api
        const csvPath = filePaths['csv_file'] || ''
        const fotosDir = filePaths['photos_dir'] || ''
        const jsonPath = filePaths['json_file'] || ''
        const dataFile = filePaths['data_file'] || ''
        const bladeDir = filePaths['blade_dir'] || ''
        const instaOutputDir = filePaths['insta_output_dir'] || ''
        const turbinasDir = filePaths['turbinas_dir'] || ''
        const localTurbineDir = filePaths['local_turbine_dir'] || ''
        const driveTurbineDir = filePaths['drive_turbine_dir'] || ''
        const modo = 'P'
        const dryRun = ['Sim', 'Yes'].includes(options['dry_run'] || '')
        const xlsx = ['Sim', 'Yes'].includes(options['gen_xlsx'] || '')

        // Mapeamento de ids baseados em translations.js
        // 1: Organizar Imagens (CSV)
        // 2: Process JSON
        // 3: Organizar Fotos
        // 4: Converter CSV
        // 5: GPS + Relative Z
        // 6: Fix Blade Split
        // 7: Fix Z=0
        // 8: Recover Lost Photos
        // 12: Arthnex Packer (CSV upload externo)

        if (active === 1) api.organizar_imagens(csvPath, fotosDir, modo, dryRun)
        else if (active === 10) api.json_para_csv_organizar(jsonPath)
        else if (active === 2) api.processar_json(jsonPath)
        else if (active === 3) api.organizar_fotos(jsonPath, fotosDir)
        else if (active === 4) api.converter_csv(csvPath, xlsx)
        else if (active === 5) api.extrair_gps_z(fotosDir, gpsRaiz)
        else if (active === 6)
          api.corrigir_blade_split(dataFile, options.correcoes || [])
        else if (active === 7) api.corrigir_z_zero(csvPath, fotosDir, gpsRaiz)
        else if (active === 8) api.recuperar_fotos_perdidas(jsonPath, fotosDir)
        else if (active === 11)
          api.reconstruir_csv(
            fotosDir,
            options.blade_sn || '',
            options.sides || []
          )
        else if (active === 12) api.packer_plataforma(bladeDir)
        else if (active === 13) api.arthnex_organizar(fotosDir, dryRun)
        else if (active === 15)
          api.calibrar_z_gopro_raw(
            bladeDir,
            options.turbine || '',
            options.blade_sn || '',
            options.referencias || {}
          )
        else if (active === 14) api.vincular_arthnex_csv(csvPath, fotosDir)
        else if (active === 20)
          api.substituir_videos_360(instaOutputDir, turbinasDir, dryRun)
        else if (active === 21)
          api.enviar_videos_drive(localTurbineDir, driveTurbineDir, dryRun)
        return
      }

      // Modo demo (sem pywebview)
      setRunning(true)
      setLogs([])
      setRan(false)
      setProgress(0)
      let i = 0
      const iv = setInterval(() => {
        addLog(mockLog[i])
        setProgress(Math.round(((i + 1) / mockLog.length) * 100))
        i++
        if (i >= mockLog.length) {
          clearInterval(iv)
          setRunning(false)
          setRan(true)
        }
      }, 380)
    },
    [isPyWebView, addLog]
  )

  const pickInput = useCallback(async inp => {
    if (typeof window.pywebview === 'undefined') {
      return '' // Evita carregar dados de demo acidentalmente se a UI foi mais rapida q o webview backend
    }
    const path =
      inp.type === 'folder'
        ? await window.pywebview.api.pick_folder()
        : await window.pywebview.api.pick_file(inp.fileType || 'all')
    return path || ''
  }, [])

  const carregarFotosGps = useCallback(
    pasta => {
      if (!pasta) return
      setGpsLoading(true)
      setGpsFotos([])

      if (isPyWebView) {
        const onLoaded = e => {
          setGpsFotos(e.detail.fotos || [])
          setGpsLoading(false)
          window.removeEventListener('gps_fotos_loaded', onLoaded)
        }
        window.addEventListener('gps_fotos_loaded', onLoaded)
        window.pywebview.api.carregar_fotos_gps(pasta)
      } else {
        setTimeout(() => {
          setGpsFotos([
            { nome: 'DJI_20240315_143000_001.JPG', altitude: 12.45 },
            { nome: 'DJI_20240315_143010_002.JPG', altitude: 18.23 },
            { nome: 'DJI_20240315_143020_003.JPG', altitude: 24.81 },
            { nome: 'DJI_20240315_143030_004.JPG', altitude: 31.2 },
            { nome: 'DJI_20240315_143040_005.JPG', altitude: 38.65 },
          ])
          setGpsLoading(false)
        }, 800)
      }
    },
    [isPyWebView]
  )

  const carregarBladeSplit = useCallback(
    jsonPath => {
      if (!jsonPath) return
      setBladeSplitLoading(true)
      setBladeSplitSuspeitos([])
      clearLogs() // Clear output area
      addLog({ type: 'info', text: 'Iniciando análise de dados...' }) // initial message

      if (isPyWebView) {
        const onLog = e => addLog(e.detail)
        const onLoaded = e => {
          setBladeSplitSuspeitos(e.detail.suspeitos || [])
          setBladeSplitLoading(false)
          window.removeEventListener('blade_split_analise', onLoaded)
          window.removeEventListener('arthlog', onLog)
          addLog({ type: 'success', text: 'Análise concluída.' })
        }

        window.addEventListener('arthlog', onLog)
        window.addEventListener('blade_split_analise', onLoaded)
        window.pywebview.api.analisar_blade_split(jsonPath, 0)
      } else {
        setTimeout(() => {
          const isCsv = String(jsonPath).toLowerCase().endsWith('.csv')
          if (isCsv) {
            setBladeSplitSuspeitos([
              {
                blade_sn: 'BLD-001',
                total_fotos: 1400,
                sessoes: [
                  {
                    session_idx: 0,
                    ts_inicio: '2026-04-15 09:12:03',
                    ts_fim: '2026-04-15 09:45:22',
                    total_fotos: 700,
                    original_indices: [],
                    itens_com_tempo: [],
                  },
                  {
                    session_idx: 1,
                    ts_inicio: '2026-04-15 14:23:45',
                    ts_fim: '2026-04-15 14:58:01',
                    total_fotos: 700,
                    original_indices: [],
                    itens_com_tempo: [],
                  },
                ],
              },
            ])
          } else {
            setBladeSplitSuspeitos([
              {
                blade_position: 'A',
                total_fotos: 1400,
                sessoes: [
                  {
                    session_idx: 0,
                    ts_inicio: '2026-04-15 09:12:03',
                    ts_fim: '2026-04-15 09:45:22',
                    total_fotos: 700,
                    sides: ['LE'],
                    original_indices: [],
                    itens_com_tempo: [],
                  },
                  {
                    session_idx: 1,
                    ts_inicio: '2026-04-15 14:23:45',
                    ts_fim: '2026-04-15 14:58:01',
                    total_fotos: 700,
                    sides: ['TE'],
                    original_indices: [],
                    itens_com_tempo: [],
                  },
                ],
              },
            ])
          }
          setBladeSplitLoading(false)
          addLog({ type: 'success', text: 'Análise simulada concluída.' })
        }, 800)
      }
    },
    [isPyWebView, clearLogs, addLog]
  )

  const carregarFotosReconstruir = useCallback(
    pasta => {
      if (!pasta) return
      setFotosReconstruirLoading(true)
      setFotosReconstruir([])
      if (isPyWebView) {
        const onLoaded = e => {
          setFotosReconstruir(e.detail.fotos || [])
          setFotosReconstruirLoading(false)
          window.removeEventListener('fotos_reconstruir_loaded', onLoaded)
        }
        window.addEventListener('fotos_reconstruir_loaded', onLoaded)
        window.pywebview.api.carregar_fotos_reconstruir(pasta)
      } else {
        setTimeout(() => {
          setFotosReconstruir([
            { nome: 'DJI_20240315_143000_001.JPG', z_relativo_mm: 0 },
            { nome: 'DJI_20240315_143010_002.JPG', z_relativo_mm: 5780 },
            { nome: 'DJI_20240315_143020_003.JPG', z_relativo_mm: 11230 },
          ])
          setFotosReconstruirLoading(false)
        }, 600)
      }
    },
    [isPyWebView]
  )

  const carregarGoproRaw = useCallback(
    pasta => {
      if (!pasta) return
      setGoproRawLoading(true)
      setGoproRawRegioes([])
      clearLogs()
      addLog({ type: 'info', text: 'Analisando pasta da pá...' })

      if (isPyWebView) {
        const onLog = e => addLog(e.detail)
        const onLoaded = e => {
          setGoproRawRegioes(e.detail.regioes || [])
          setGoproRawLoading(false)
          window.removeEventListener('gopro_raw_analise', onLoaded)
          window.removeEventListener('arthlog', onLog)
          addLog({ type: 'success', text: 'Análise concluída.' })
        }
        window.addEventListener('arthlog', onLog)
        window.addEventListener('gopro_raw_analise', onLoaded)
        window.pywebview.api.analisar_gopro_raw(pasta)
      } else {
        setTimeout(() => {
          setGoproRawRegioes([
            { region: 'LE', num_min: 5993, num_max: 6156, total: 164 },
            { region: 'TE', num_min: 6200, num_max: 6310, total: 111 },
            { region: 'CE', num_min: 6400, num_max: 6490, total: 91 },
          ])
          setGoproRawLoading(false)
          addLog({ type: 'success', text: 'Análise simulada concluída.' })
        }, 600)
      }
    },
    [isPyWebView, clearLogs, addLog]
  )

  const openFolder = useCallback(
    path => {
      if (isPyWebView && path) {
        window.pywebview.api.open_folder(path)
      }
    },
    [isPyWebView]
  )

  // Limpar listeners ao desmontar
  useEffect(() => {
    return () => {
      if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current)
    }
  }, [])

  return {
    logs,
    running,
    ran,
    progress,
    lastOutput,
    gpsLoading,
    gpsFotos,
    setGpsFotos,
    bladeSplitLoading,
    bladeSplitSuspeitos,
    setBladeSplitSuspeitos,
    fotosReconstruirLoading,
    fotosReconstruir,
    setFotosReconstruir,
    clearLogs,
    handleRun,
    pickInput,
    carregarFotosGps,
    carregarBladeSplit,
    carregarFotosReconstruir,
    goproRawLoading,
    goproRawRegioes,
    setGoproRawRegioes,
    carregarGoproRaw,
    openFolder,
    isPyWebView,
  }
}
