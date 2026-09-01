import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icons } from '../constants/icons.jsx'

const MAX_LOGS = 1000

function normalizeWtgMatch(s) {
  if (!s) return ''
  return String(s)
    .toUpperCase()
    .replace(/^B/i, '')
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^0+/, '')
    .replace(/0+([0-9])$/, '$1')
}

/**
 * Dropdown Pesquisável em Tempo Real (Combobox)
 */
function SearchableSelect({
  items,
  value,
  onChange,
  placeholder,
  disabled,
  labelKey = 'label',
  valueKey = 'value',
  sublabelKey = 'sublabel',
  theme,
  accent,
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef(null)

  const selectedItem = items.find(it => String(it[valueKey]) === String(value))

  useEffect(() => {
    if (selectedItem) {
      setSearch(selectedItem[labelKey])
    } else if (!value) {
      setSearch('')
    }
  }, [value, selectedItem, labelKey])

  useEffect(() => {
    const handleClickOutside = e => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false)
        if (selectedItem) {
          setSearch(selectedItem[labelKey])
        } else {
          setSearch('')
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [selectedItem, labelKey])

  const filtered = items.filter(it => {
    const text = `${it[labelKey] || ''} ${it[sublabelKey] || ''}`.toLowerCase()
    return text.includes((search || '').toLowerCase().trim())
  })

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <div
        style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
      >
        <input
          type="text"
          value={search}
          disabled={disabled}
          placeholder={placeholder}
          onFocus={() => {
            if (!disabled) setIsOpen(true)
          }}
          onChange={e => {
            setSearch(e.target.value)
            setIsOpen(true)
            const exact = items.find(
              it =>
                (it[labelKey] || '').toLowerCase() ===
                e.target.value.trim().toLowerCase()
            )
            if (exact) {
              onChange(exact[valueKey])
            }
          }}
          style={{
            width: '100%',
            padding: '8px 30px 8px 10px',
            background: theme.bgCard,
            color: theme.textPrimary,
            border: `1px solid ${isOpen || value ? accent : theme.borderLight}`,
            borderRadius: '6px',
            fontSize: '12px',
            outline: 'none',
          }}
        />
        {value && !disabled ? (
          <button
            onClick={e => {
              e.stopPropagation()
              onChange('')
              setSearch('')
              setIsOpen(false)
            }}
            title="Limpar seleção"
            style={{
              position: 'absolute',
              right: '8px',
              background: 'transparent',
              border: 0,
              color: theme.textMuted,
              cursor: 'pointer',
              fontSize: '11px',
              padding: '2px',
            }}
          >
            ✕
          </button>
        ) : (
          <span
            style={{
              position: 'absolute',
              right: '10px',
              color: theme.textMuted,
              fontSize: '10px',
              pointerEvents: 'none',
            }}
          >
            ▼
          </span>
        )}
      </div>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '4px',
            maxHeight: '220px',
            overflowY: 'auto',
            background: theme.bgCard,
            border: `1px solid ${theme.borderLight}`,
            borderRadius: '6px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            zIndex: 9999,
          }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                padding: '8px 10px',
                fontSize: '11.5px',
                color: theme.textMuted,
                fontStyle: 'italic',
              }}
            >
              Nenhum resultado encontrado
            </div>
          ) : (
            filtered.map(item => {
              const isSel = String(item[valueKey]) === String(value)
              return (
                <div
                  key={String(item[valueKey])}
                  onClick={() => {
                    onChange(item[valueKey])
                    setSearch(item[labelKey])
                    setIsOpen(false)
                  }}
                  style={{
                    padding: '7px 10px',
                    fontSize: '11.5px',
                    cursor: 'pointer',
                    background: isSel
                      ? theme.accentSofter || 'rgba(2,132,199,0.15)'
                      : 'transparent',
                    color: isSel ? accent : theme.textPrimary,
                    borderBottom: `1px solid ${theme.borderLight}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                  }}
                >
                  <div style={{ fontWeight: isSel ? 600 : 400 }}>
                    {item[labelKey]}
                  </div>
                  {item[sublabelKey] && (
                    <div style={{ fontSize: '10px', color: theme.textMuted }}>
                      {item[sublabelKey]}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

export default function SnowModule({ D }) {
  const theme = D || {
    bg: '#1a1d23',
    bgDeep: '#14161b',
    bgPanel: '#1e2128',
    bgCard: '#22252e',
    border: 'rgba(99,140,200,0.12)',
    borderLight: 'rgba(99,140,200,0.07)',
    accent: '#0284c7',
    accentSoft: 'rgba(2,132,199,0.15)',
    accentSofter: 'rgba(2,132,199,0.08)',
    textPrimary: '#e8ecf2',
    textSecond: '#8c98ac',
    textMuted: '#4a5568',
    logBg: '#161820',
    inputBg: '#12141a',
    success: '#34c77b',
    warning: '#f5a623',
    error: '#f0554a',
    info: '#0284c7',
  }

  const accent = '#0284c7'

  // 1. Dados de Entrada (Arthnex & Nordex Database)
  const [workorders, setWorkorders] = useState([])
  const [selectedWoId, setSelectedWoId] = useState('')
  const [turbinesList, setTurbinesList] = useState([])
  const [selectedTurbines, setSelectedTurbines] = useState([]) // Turbinas marcadas com checkbox
  const [loadingArthnex, setLoadingArthnex] = useState(false)
  const [loadingTurbines, setLoadingTurbines] = useState(false)

  // 2. Base de INCs da Nordex
  const [incExcelPath, setIncExcelPath] = useState(() => {
    try {
      return localStorage.getItem('snow_inc_excel_path') || ''
    } catch {
      return ''
    }
  })
  const [incMap, setIncMap] = useState({}) // normWtg -> { inc, wtg, turbineId, dataColeta }
  const [loadingIncMap, setLoadingIncMap] = useState(false)

  // 3. Pasta de Destino (Output)
  const [outputDir, setOutputDir] = useState(() => {
    try {
      return localStorage.getItem('snow_output_dir') || ''
    } catch {
      return ''
    }
  })

  // 4. Configurações da Automação ServiceNow
  const [autoSubmit, setAutoSubmit] = useState(true)
  const [headless, setHeadless] = useState(false)
  const [dryRun, setDryRun] = useState(false)
  const [includeVideos, setIncludeVideos] = useState(true)
  const [flawlessMode, setFlawlessMode] = useState(false)
  const [leaderName, setLeaderName] = useState('ALLAN THIAGO')

  // 5. Fila Overnight de Execução
  const [queue, setQueue] = useState([])
  const [queueRunning, setQueueRunning] = useState(false)
  const [queueIndex, setQueueIndex] = useState(-1)
  const [paused, setPaused] = useState(false)
  const [openTabs, setOpenTabs] = useState([])

  // 6. Logs e Monitoramento
  const [logs, setLogs] = useState([])
  const logsEndRef = useRef(null)

  // ─── Carregar Base de INCs ───────────────────────────────────────────────
  const carregarBaseIncs = useCallback(async filePath => {
    if (!filePath) return
    const invoker = window.pywebview?.api || window.api
    setLoadingIncMap(true)
    try {
      const res = await invoker.snow_read_turbine_inc_list?.(filePath)
      if (res && res.success && Array.isArray(res.entries)) {
        const map = {}
        for (const entry of res.entries) {
          const norm = normalizeWtgMatch(entry.wtg)
          if (norm) {
            map[norm] = entry
          }
        }
        setIncMap(map)
        setLogs(prev => [
          ...prev,
          {
            text: `✓ Base de INCs carregada: ${res.entries.length} turbinas mapeadas.`,
            type: 'success',
          },
        ])
      }
    } catch (err) {
      console.error('Erro ao ler base de INCs:', err)
    } finally {
      setLoadingIncMap(false)
    }
  }, [])

  useEffect(() => {
    if (incExcelPath) {
      carregarBaseIncs(incExcelPath)
    }
  }, [incExcelPath, carregarBaseIncs])

  // ─── Carregar Workorders do Arthnex ──────────────────────────────────────
  const carregarWorkorders = useCallback(async () => {
    const invoker = window.pywebview?.api || window.api
    if (!invoker) return
    setLoadingArthnex(true)
    try {
      let res = await invoker.arthnex_get_workorders?.('', 1, 500)
      let list = res?.workorders || res?.data || (Array.isArray(res) ? res : [])
      if (!list || list.length === 0) {
        res = await invoker.arthnex_listar_workorders?.(false)
        list = res?.data || res?.workorders || (Array.isArray(res) ? res : [])
      }
      if (Array.isArray(list) && list.length > 0) {
        const normalized = list.map(w => ({
          id: String(w.id || w.workorders_id),
          description: w.description || w.id || 'Sem descrição',
          client_name: w.client_name || '',
          windfarm_local: w.windfarm_local || '',
          windfarm_id: w.windfarm_id || 0,
        }))
        normalized.sort((a, b) => a.description.localeCompare(b.description))
        setWorkorders(normalized)
      }
    } catch (err) {
      console.error('Erro ao carregar workorders:', err)
    } finally {
      setLoadingArthnex(false)
    }
  }, [])

  useEffect(() => {
    carregarWorkorders()
  }, [carregarWorkorders])

  // ─── Carregar Turbinas da Workorder Selecionada ───────────────────────────
  const carregarTurbinas = useCallback(async (woId, windfarmId) => {
    if (!woId) {
      setTurbinesList([])
      setSelectedTurbines([])
      return
    }
    const invoker = window.pywebview?.api || window.api
    setLoadingTurbines(true)
    try {
      let res = await invoker.arthnex_get_turbines_blades?.(woId, windfarmId)
      let data = res?.data || (Array.isArray(res) ? res : [])
      if (!data || data.length === 0) {
        res = await invoker.uploader_get_hierarchy?.(woId, false)
        data = res?.data || (Array.isArray(res) ? res : [])
      }
      if (data && data.length > 0) {
        setTurbinesList(data)
        // Pré-seleciona turbinas que possuem match na base de INCs
        setSelectedTurbines(data.map(t => t.turbine_id))
      } else {
        setTurbinesList([])
        setSelectedTurbines([])
      }
    } catch (err) {
      console.error('Erro ao buscar turbinas:', err)
    } finally {
      setLoadingTurbines(false)
    }
  }, [])

  // ─── Escutadores de Eventos de Log e Abas ─────────────────────────────────
  useEffect(() => {
    const handleAutomationLog = e => {
      const { msg, type } = e.detail || {}
      if (!msg) return
      const t =
        type ||
        (msg.startsWith('✗')
          ? 'error'
          : msg.startsWith('✓')
            ? 'success'
            : 'info')
      setLogs(prev => {
        const next = [...prev, { text: msg, type: t }]
        return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
      })
    }

    const handleProgress = e => {
      const { message, type } = e.detail || {}
      if (message) {
        setLogs(prev => [...prev, { text: message, type: type || 'info' }])
      }
    }

    window.addEventListener('snow_automation_log', handleAutomationLog)
    window.addEventListener('snow_progress', handleProgress)
    return () => {
      window.removeEventListener('snow_automation_log', handleAutomationLog)
      window.removeEventListener('snow_progress', handleProgress)
    }
  }, [])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // Atualiza lista de abas abertas a cada 3s quando em execução
  useEffect(() => {
    const interval = setInterval(async () => {
      const invoker = window.pywebview?.api || window.api
      if (invoker?.snow_automation_list_open_tabs) {
        try {
          const tabs = await invoker.snow_automation_list_open_tabs()
          setOpenTabs(Array.isArray(tabs) ? tabs : [])
        } catch {}
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  // ─── Ordenação Priorizada: Turbinas com INC no Excel no topo ──────────────
  const sortedTurbines = useMemo(() => {
    return [...turbinesList].sort((a, b) => {
      const normA = normalizeWtgMatch(a.turbine)
      const normB = normalizeWtgMatch(b.turbine)
      const hasIncA = Boolean(incMap[normA]?.inc)
      const hasIncB = Boolean(incMap[normB]?.inc)

      // Prioridade 1: Turbinas que estão no Excel de INCs
      if (hasIncA && !hasIncB) return -1
      if (!hasIncA && hasIncB) return 1

      // Prioridade 2: Ordem alfanumérica natural (ex: B11-01, B11-02, B13-01...)
      return (a.turbine || '').localeCompare(b.turbine || '', undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    })
  }, [turbinesList, incMap])

  // Contagem de turbinas com INC vinculado
  const matchedTurbinesCount = useMemo(() => {
    return sortedTurbines.filter(t =>
      Boolean(incMap[normalizeWtgMatch(t.turbine)]?.inc)
    ).length
  }, [sortedTurbines, incMap])

  // ─── Ações de Seleção e Shift+Click ───────────────────────────────────────
  const [lastClickedIndex, setLastClickedIndex] = useState(null)

  const handleTurbineClick = (tId, index, event) => {
    if (queueRunning) return

    if (
      event &&
      event.shiftKey &&
      lastClickedIndex !== null &&
      lastClickedIndex !== index
    ) {
      // Seleção por intervalo com Shift+Click
      const start = Math.min(lastClickedIndex, index)
      const end = Math.max(lastClickedIndex, index)
      const rangeIds = sortedTurbines
        .slice(start, end + 1)
        .map(t => t.turbine_id)

      setSelectedTurbines(prev => {
        const newSet = new Set(prev)
        rangeIds.forEach(id => newSet.add(id))
        return Array.from(newSet)
      })
    } else {
      // Seleção individual (toggle)
      setSelectedTurbines(prev =>
        prev.includes(tId) ? prev.filter(id => id !== tId) : [...prev, tId]
      )
      setLastClickedIndex(index)
    }
  }

  const selectMatchedTurbines = () => {
    const matched = sortedTurbines
      .filter(t => Boolean(incMap[normalizeWtgMatch(t.turbine)]?.inc))
      .map(t => t.turbine_id)
    setSelectedTurbines(matched)
  }

  const selectAllTurbines = () => {
    setSelectedTurbines(sortedTurbines.map(t => t.turbine_id))
  }

  const deselectAllTurbines = () => {
    setSelectedTurbines([])
  }

  const pickIncFile = async () => {
    const invoker = window.pywebview?.api || window.api
    const picked = await invoker.pick_file('xlsx')
    if (picked) {
      setIncExcelPath(picked)
      try {
        localStorage.setItem('snow_inc_excel_path', picked)
      } catch {}
      carregarBaseIncs(picked)
    }
  }

  const pickOutputFolder = async () => {
    const invoker = window.pywebview?.api || window.api
    const picked = await invoker.pick_folder()
    if (picked) {
      setOutputDir(picked)
      try {
        localStorage.setItem('snow_output_dir', picked)
      } catch {}
    }
  }

  // Adiciona turbinas selecionadas à Fila Overnight
  const handleAddToQueue = () => {
    if (selectedTurbines.length === 0) return
    const selectedWo = workorders.find(
      w => String(w.id) === String(selectedWoId)
    )

    // Mantém a ordem priorizada na fila
    const orderedSelectedTurbines = sortedTurbines.filter(t =>
      selectedTurbines.includes(t.turbine_id)
    )

    const newItems = orderedSelectedTurbines.map(tObj => {
      const norm = normalizeWtgMatch(tObj?.turbine || '')
      const incInfo = incMap[norm]

      return {
        id: `${selectedWoId}_${tObj.turbine_id}_${Date.now()}_${Math.random()}`,
        woId: selectedWoId,
        woDesc: selectedWo?.description || selectedWoId,
        windfarmId: selectedWo?.windfarm_id || tObj?.windfarm_id || 0,
        turbineId: tObj.turbine_id,
        turbineName: tObj?.turbine || `WTG_${tObj.turbine_id}`,
        blades: tObj?.windblades || [],
        incNumber: incInfo?.inc || '',
        dataColeta: incInfo?.dataColeta || '',
        status: 'pending', // pending, processing_cloud, processing_snow, done, error
        error: null,
      }
    })

    setQueue(prev => [...prev, ...newItems])
    setLogs(prev => [
      ...prev,
      {
        text: `+ Adicionadas ${newItems.length} turbinas à Fila de Automação.`,
        type: 'info',
      },
    ])
  }

  const handleClearQueue = () => {
    if (queueRunning) return
    setQueue([])
    setQueueIndex(-1)
  }

  // ─── Execução da Fila Overnight ──────────────────────────────────────────
  const handleRunQueue = async () => {
    if (queue.length === 0 || queueRunning) return
    if (!outputDir) {
      setLogs(prev => [
        ...prev,
        {
          text: 'Selecione uma pasta de destino (Output) primeiro.',
          type: 'warning',
        },
      ])
      return
    }

    const invoker = window.pywebview?.api || window.api
    setQueueRunning(true)
    setPaused(false)
    await invoker.snow_automation_reset_control?.()

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]
      if (item.status === 'done') continue // Pula as já concluídas

      setQueueIndex(i)
      setQueue(prev =>
        prev.map((it, idx) =>
          idx === i ? { ...it, status: 'processing_cloud', error: null } : it
        )
      )

      setLogs(prev => [
        ...prev,
        {
          text: `──────────────────────────────────────────────────`,
          type: 'info',
        },
        {
          text: `🚀 Iniciando Turbina [${item.turbineName}] (${i + 1}/${queue.length})...`,
          type: 'info',
        },
      ])

      try {
        // 1. Consulta Técnico da Operação no Arthnex
        let techName = ''
        let flightDate = item.dataColeta || ''
        try {
          const techRes = await invoker.arthnex_get_technician_by_turbine?.(
            item.turbineName,
            item.woId
          )
          if (techRes && techRes.success) {
            techName = techRes.technician || ''
            if (techRes.date) flightDate = techRes.date
            setLogs(prev => [
              ...prev,
              {
                text: `  👤 Técnico identificado: ${techName || 'Padrão'} | Data: ${flightDate || 'Atual'}`,
                type: 'info',
              },
            ])
          }
        } catch {}

        // 2. Download de dados e marcação de polígonos
        const bladesToProcess = (item.blades || []).map(b => ({
          windbladeId: b.windblade_id,
          bladeSn: b.blade,
          bladeLetter: b.blade_letter,
        }))

        setLogs(prev => [
          ...prev,
          {
            text: `  ☁ Baixando e processando fotos do Arthnex...`,
            type: 'info',
          },
        ])
        const cloudRes = await invoker.snow_process_arthnex?.({
          workorderId: item.woId,
          windfarmId: item.windfarmId,
          turbineId: Number(item.turbineId),
          turbineSn: item.turbineName,
          blades: bladesToProcess,
          outputDir,
        })

        if (!cloudRes || !cloudRes.success) {
          throw new Error(cloudRes?.error || 'Falha no processamento das fotos')
        }

        setQueue(prev =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: 'processing_snow' } : it
          )
        )

        // 3. Monta URL do Incidente do ServiceNow
        const incUrl = item.incNumber
          ? `https://nordexprod.service-now.com/bam?id=create_damage_report_entry&sysparm_query=number=${item.incNumber}`
          : 'https://nordexprod.service-now.com/bam?id=create_damage_report_entry'

        setLogs(prev => [
          ...prev,
          {
            text: `  🤖 Preenchendo ServiceNow (${item.incNumber || 'Sem INC'})...`,
            type: 'info',
          },
        ])

        const autoRes = await invoker.snow_automation_run?.(
          cloudRes.outputPath,
          incUrl,
          {
            headless,
            autoSubmit,
            dryRun,
            includeDefects: true,
            includeBlanks: true,
            includeVideos,
            flawlessMode,
            localPhotosDir: cloudRes.photosFolder,
            leader: leaderName,
            technician: techName,
          }
        )

        if (autoRes && autoRes.success) {
          setQueue(prev =>
            prev.map((it, idx) => (idx === i ? { ...it, status: 'done' } : it))
          )
          setLogs(prev => [
            ...prev,
            {
              text: `✓ Turbina [${item.turbineName}] finalizada com sucesso no ServiceNow!`,
              type: 'success',
            },
          ])
        } else {
          throw new Error(autoRes?.error || 'Avisos durante a automação')
        }
      } catch (err) {
        setQueue(prev =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: 'error', error: err.message } : it
          )
        )
        setLogs(prev => [
          ...prev,
          {
            text: `✗ Falha na turbina [${item.turbineName}]: ${err.message}`,
            type: 'error',
          },
        ])
      }
    }

    setQueueRunning(false)
    setQueueIndex(-1)
    setLogs(prev => [
      ...prev,
      {
        text: `──────────────────────────────────────────────────`,
        type: 'info',
      },
      { text: `🏁 Fila Overnight finalizada!`, type: 'success' },
    ])
  }

  const handlePauseQueue = async () => {
    const invoker = window.pywebview?.api || window.api
    if (paused) {
      await invoker.snow_automation_resume?.()
      setPaused(false)
    } else {
      await invoker.snow_automation_pause?.()
      setPaused(true)
    }
  }

  const handleStopQueue = async () => {
    const invoker = window.pywebview?.api || window.api
    await invoker.snow_automation_stop?.()
    setQueueRunning(false)
    setPaused(false)
  }

  const handleCloseAllReviewTabs = async () => {
    const invoker = window.pywebview?.api || window.api
    const res = await invoker.snow_automation_close_all_review_tabs?.()
    setLogs(prev => [
      ...prev,
      { text: `Fechadas ${res?.closed || 0} abas de revisão.`, type: 'info' },
    ])
    setOpenTabs([])
  }

  const logColor = type => {
    if (type === 'success') return theme.success
    if (type === 'error') return theme.error
    if (type === 'warning') return theme.warning
    return theme.textSecond
  }

  return (
    <div style={{ display: 'flex', gap: '16px', height: '100%', minHeight: 0 }}>
      {/* ─── PAINEL ESQUERDO: SELEÇÃO & BASES DE DADOS ─── */}
      <div
        style={{
          flex: '0 0 460px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          overflowY: 'auto',
          paddingRight: '6px',
        }}
      >
        {/* 1. SELEÇÃO DE WORKORDER NO ARTHNEX */}
        <div
          style={{
            background: theme.bgCard,
            borderRadius: '8px',
            padding: '12px',
            border: `1px solid ${theme.borderLight}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: theme.textPrimary,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>☁ 1. Ordem de Serviço (Arthnex)</span>
            </div>
            <span
              style={{
                fontSize: '11px',
                color: workorders.length > 0 ? theme.success : theme.textMuted,
              }}
            >
              {loadingArthnex
                ? 'Buscando...'
                : `${workorders.length} disponíveis`}
            </span>
          </div>

          <SearchableSelect
            items={workorders}
            value={selectedWoId}
            onChange={woId => {
              setSelectedWoId(woId)
              const selectedWo = workorders.find(
                w => String(w.id) === String(woId)
              )
              carregarTurbinas(woId, selectedWo?.windfarm_id)
            }}
            placeholder="Digite para buscar a Workorder..."
            disabled={loadingArthnex || queueRunning}
            labelKey="description"
            valueKey="id"
            sublabelKey="client_name"
            theme={theme}
            accent={accent}
          />
        </div>

        {/* 2. BASE DE INCS DA NORDEX */}
        <div
          style={{
            background: theme.bgCard,
            borderRadius: '8px',
            padding: '12px',
            border: `1px solid ${theme.borderLight}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: theme.textPrimary,
              }}
            >
              📋 2. Base de INCs (Nordex Acciona)
            </div>
            {Object.keys(incMap).length > 0 && (
              <span
                style={{
                  fontSize: '10.5px',
                  color: theme.success,
                  fontWeight: 500,
                }}
              >
                ✓ {Object.keys(incMap).length} INCs carregados
              </span>
            )}
          </div>

          <div
            className={`input-field${incExcelPath ? ' filled' : ''}`}
            onClick={!queueRunning ? pickIncFile : undefined}
            style={{ cursor: queueRunning ? 'not-allowed' : 'pointer' }}
          >
            <span
              style={{
                color: incExcelPath ? accent : theme.textMuted,
                flexShrink: 0,
              }}
            >
              📊
            </span>
            <span
              className="input-field-text"
              title={
                incExcelPath ||
                'Selecione a planilha de controle com a coluna INC...'
              }
            >
              {incExcelPath
                ? incExcelPath.split(/[/\\]/).pop()
                : 'Selecione a planilha de INCs (.xlsx)...'}
            </span>
          </div>
        </div>

        {/* 3. GRID DE TURBINAS DA O.S. (COM MATCH DE INCS EM TEMPO REAL) */}
        {selectedWoId && (
          <div
            style={{
              background: theme.bgCard,
              borderRadius: '8px',
              padding: '12px',
              border: `1px solid ${theme.borderLight}`,
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '4px',
              }}
            >
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: theme.textPrimary,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <span>🌪 3. Turbinas do Parque ({sortedTurbines.length})</span>
                {matchedTurbinesCount > 0 && (
                  <span
                    style={{
                      fontSize: '10px',
                      background: 'rgba(52, 199, 123, 0.15)',
                      color: theme.success,
                      padding: '1px 6px',
                      borderRadius: '8px',
                      fontWeight: 600,
                    }}
                  >
                    {matchedTurbinesCount} com INC
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                {matchedTurbinesCount > 0 && (
                  <button
                    onClick={selectMatchedTurbines}
                    disabled={queueRunning}
                    style={{
                      background: 'transparent',
                      border: 0,
                      color: theme.success,
                      fontSize: '10.5px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                    title="Selecionar apenas turbinas que possuem INC no Excel"
                  >
                    Com INC
                  </button>
                )}
                <button
                  onClick={selectAllTurbines}
                  disabled={queueRunning}
                  style={{
                    background: 'transparent',
                    border: 0,
                    color: accent,
                    fontSize: '10.5px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  Todas
                </button>
                <button
                  onClick={deselectAllTurbines}
                  disabled={queueRunning}
                  style={{
                    background: 'transparent',
                    border: 0,
                    color: theme.textMuted,
                    fontSize: '10.5px',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  Nenhuma
                </button>
              </div>
            </div>

            <div
              style={{
                fontSize: '10px',
                color: theme.textMuted,
                fontStyle: 'italic',
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span>Prioridade: Turbinas do Excel no topo</span>
              <span>Dica: Segure Shift para selecionar intervalo</span>
            </div>

            {loadingTurbines ? (
              <div
                style={{
                  fontSize: '11.5px',
                  color: accent,
                  padding: '8px 0',
                  fontStyle: 'italic',
                }}
              >
                Buscando turbinas e defeitos no Arthnex...
              </div>
            ) : sortedTurbines.length === 0 ? (
              <div
                style={{
                  fontSize: '11.5px',
                  color: theme.textMuted,
                  fontStyle: 'italic',
                }}
              >
                Nenhuma turbina encontrada para esta Workorder.
              </div>
            ) : (
              <div
                style={{
                  maxHeight: '260px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  paddingRight: '4px',
                  userSelect: 'none',
                }}
              >
                {sortedTurbines.map((t, idx) => {
                  const isChecked = selectedTurbines.includes(t.turbine_id)
                  const norm = normalizeWtgMatch(t.turbine)
                  const incInfo = incMap[norm]

                  return (
                    <div
                      key={t.turbine_id}
                      onClick={e => handleTurbineClick(t.turbine_id, idx, e)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 10px',
                        borderRadius: '6px',
                        background: isChecked
                          ? theme.accentSofter || 'rgba(2,132,199,0.12)'
                          : theme.bgPanel,
                        border: `1px solid ${isChecked ? accent : incInfo?.inc ? 'rgba(52, 199, 123, 0.25)' : theme.borderLight}`,
                        cursor: queueRunning ? 'not-allowed' : 'pointer',
                        transition: 'all 0.15s',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}}
                          disabled={queueRunning}
                          style={{ cursor: 'pointer' }}
                        />
                        <span
                          style={{
                            fontSize: '12px',
                            fontWeight: isChecked ? 600 : 400,
                            color: theme.textPrimary,
                          }}
                        >
                          {t.turbine}
                        </span>
                        <span
                          style={{ fontSize: '10px', color: theme.textMuted }}
                        >
                          ({t.windblades?.length || 3} pás)
                        </span>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                      >
                        {incInfo?.inc ? (
                          <span
                            style={{
                              fontSize: '10.5px',
                              background: 'rgba(52, 199, 123, 0.15)',
                              color: theme.success,
                              padding: '2px 6px',
                              borderRadius: '4px',
                              fontWeight: 600,
                            }}
                          >
                            {incInfo.inc}
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: '10px',
                              color: theme.textMuted,
                              background: 'rgba(255, 255, 255, 0.04)',
                              padding: '2px 5px',
                              borderRadius: '4px',
                            }}
                          >
                            Sem INC
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Pasta de Destino & Ações */}
            <div
              style={{
                marginTop: '6px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div
                className={`input-field${outputDir ? ' filled' : ''}`}
                onClick={!queueRunning ? pickOutputFolder : undefined}
                style={{ cursor: queueRunning ? 'not-allowed' : 'pointer' }}
              >
                <span
                  style={{
                    color: outputDir ? accent : theme.textMuted,
                    flexShrink: 0,
                  }}
                >
                  📂
                </span>
                <span
                  className="input-field-text"
                  title={
                    outputDir || 'Pasta onde as fotos e planilhas serão salvas'
                  }
                >
                  {outputDir
                    ? outputDir.split(/[/\\]/).pop() || outputDir
                    : 'Pasta de Destino (Output)...'}
                </span>
              </div>

              <button
                onClick={handleAddToQueue}
                disabled={queueRunning || selectedTurbines.length === 0}
                style={{
                  background:
                    selectedTurbines.length > 0 ? accent : theme.bgCard,
                  color: selectedTurbines.length > 0 ? '#fff' : theme.textMuted,
                  border: `1px solid ${selectedTurbines.length > 0 ? accent : theme.borderLight}`,
                  borderRadius: '6px',
                  padding: '10px',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor:
                    queueRunning || selectedTurbines.length === 0
                      ? 'not-allowed'
                      : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                }}
              >
                <span>➕</span>
                <span>Adicionar {selectedTurbines.length} Turbinas à Fila</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─── PAINEL DIREITO: FILA OVERNIGHT & ROBÔ SERVICENOW ─── */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          minWidth: 0,
        }}
      >
        {/* CABEÇALHO DA FILA OVERNIGHT */}
        <div
          style={{
            background: theme.bgCard,
            border: `1px solid ${theme.borderLight}`,
            borderRadius: '8px',
            padding: '12px 14px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '10px',
          }}
        >
          <div>
            <div
              style={{
                fontSize: '13px',
                fontWeight: 700,
                color: theme.textPrimary,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span>🚀 Fila de Automação SNOW</span>
              <span
                style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  background: queueRunning
                    ? 'rgba(2, 132, 199, 0.2)'
                    : 'rgba(255,255,255,0.06)',
                  color: queueRunning ? accent : theme.textMuted,
                }}
              >
                {queueRunning
                  ? `Executando ${queueIndex + 1}/${queue.length}`
                  : `${queue.length} Turbinas na Fila`}
              </span>
            </div>
            <div
              style={{
                fontSize: '11px',
                color: theme.textSecond,
                marginTop: '2px',
              }}
            >
              Líder:{' '}
              <strong style={{ color: theme.textPrimary }}>{leaderName}</strong>{' '}
              • Técnicos vinculados por turbina via Arthnex
            </div>
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={handleRunQueue}
              disabled={queueRunning || queue.length === 0}
              style={{
                background: theme.success,
                color: '#fff',
                border: 0,
                borderRadius: '6px',
                padding: '8px 14px',
                fontSize: '12px',
                fontWeight: 600,
                cursor:
                  queueRunning || queue.length === 0
                    ? 'not-allowed'
                    : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>▶</span>
              <span>Iniciar Fila</span>
            </button>

            {queueRunning && (
              <button
                onClick={handlePauseQueue}
                style={{
                  background: theme.warning,
                  color: '#fff',
                  border: 0,
                  borderRadius: '6px',
                  padding: '8px 12px',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {paused ? '▶ Retomar' : '⏸ Pausar'}
              </button>
            )}

            {queueRunning && (
              <button
                onClick={handleStopQueue}
                style={{
                  background: theme.error,
                  color: '#fff',
                  border: 0,
                  borderRadius: '6px',
                  padding: '8px 12px',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                ⏹ Parar
              </button>
            )}

            <button
              onClick={handleClearQueue}
              disabled={queueRunning || queue.length === 0}
              style={{
                background: 'transparent',
                border: `1px solid ${theme.borderLight}`,
                color: theme.textMuted,
                borderRadius: '6px',
                padding: '8px 10px',
                fontSize: '11.5px',
                cursor:
                  queueRunning || queue.length === 0
                    ? 'not-allowed'
                    : 'pointer',
              }}
            >
              Limpar
            </button>
          </div>
        </div>

        {/* OPÇÕES RÁPIDAS DO ROBÔ */}
        <div
          style={{
            background: theme.bgCard,
            border: `1px solid ${theme.borderLight}`,
            borderRadius: '8px',
            padding: '8px 12px',
            display: 'flex',
            gap: '16px',
            flexWrap: 'wrap',
            fontSize: '11.5px',
            color: theme.textSecond,
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
              color: autoSubmit ? theme.success : theme.textMuted,
            }}
          >
            <input
              type="checkbox"
              checked={autoSubmit}
              onChange={e => setAutoSubmit(e.target.checked)}
              disabled={queueRunning}
            />
            <span style={{ fontWeight: autoSubmit ? 600 : 400 }}>
              Auto-submissão SNOW
            </span>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={includeVideos}
              onChange={e => setIncludeVideos(e.target.checked)}
              disabled={queueRunning}
            />
            <span>Vídeos DF45–50</span>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={flawlessMode}
              onChange={e => setFlawlessMode(e.target.checked)}
              disabled={queueRunning}
            />
            <span>Modo Flawless (Overnight)</span>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={headless}
              onChange={e => setHeadless(e.target.checked)}
              disabled={queueRunning}
            />
            <span>Modo Oculto (Headless)</span>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={dryRun}
              onChange={e => setDryRun(e.target.checked)}
              disabled={queueRunning}
            />
            <span>Dry-run</span>
          </label>
        </div>

        {/* LISTA DE ITENS DA FILA */}
        {queue.length > 0 && (
          <div
            style={{
              background: theme.bgCard,
              border: `1px solid ${theme.borderLight}`,
              borderRadius: '8px',
              padding: '8px 12px',
              maxHeight: '140px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            {queue.map((item, idx) => {
              const isCurrent = queueIndex === idx
              return (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '5px 8px',
                    borderRadius: '4px',
                    background: isCurrent
                      ? theme.accentSofter || 'rgba(2,132,199,0.15)'
                      : theme.bgPanel,
                    border: `1px solid ${isCurrent ? accent : theme.borderLight}`,
                    fontSize: '11.5px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span style={{ fontWeight: 600, color: theme.textPrimary }}>
                      {item.turbineName}
                    </span>
                    <span style={{ color: theme.textMuted }}>•</span>
                    <span
                      style={{
                        color: item.incNumber ? theme.success : theme.warning,
                        fontWeight: 500,
                      }}
                    >
                      {item.incNumber || 'Sem INC'}
                    </span>
                  </div>

                  <div>
                    {item.status === 'pending' && (
                      <span style={{ color: theme.textMuted }}>⏱ Na Fila</span>
                    )}
                    {item.status === 'processing_cloud' && (
                      <span style={{ color: accent }}>☁ Baixando Fotos...</span>
                    )}
                    {item.status === 'processing_snow' && (
                      <span style={{ color: theme.warning }}>
                        🤖 Preenchendo SNOW...
                      </span>
                    )}
                    {item.status === 'done' && (
                      <span style={{ color: theme.success, fontWeight: 600 }}>
                        ✓ Concluído
                      </span>
                    )}
                    {item.status === 'error' && (
                      <span style={{ color: theme.error }}>
                        ✗ {item.error || 'Erro'}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* TERMINAL DE LOGS EM TEMPO REAL & GESTÃO DE ABAS */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            background: theme.bgCard,
            border: `1px solid ${theme.borderLight}`,
            borderRadius: '8px',
            overflow: 'hidden',
            minHeight: '220px',
          }}
        >
          {/* Header do Terminal com Abas de Revisão */}
          <div
            style={{
              padding: '8px 12px',
              borderBottom: `1px solid ${theme.borderLight}`,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'rgba(255,255,255,0.02)',
            }}
          >
            <div
              style={{
                fontSize: '11.5px',
                fontWeight: 600,
                color: theme.textPrimary,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span>Monitoramento SNOW Hub</span>
              {queueRunning && (
                <span style={{ color: accent, fontSize: '11px' }}>
                  ● Em Execução
                </span>
              )}
            </div>

            {openTabs.length > 0 && (
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                <span style={{ fontSize: '10.5px', color: theme.warning }}>
                  {openTabs.length} aba(s) de revisão aberta(s)
                </span>
                <button
                  onClick={handleCloseAllReviewTabs}
                  style={{
                    background: 'transparent',
                    border: `1px solid ${theme.borderLight}`,
                    color: theme.error,
                    borderRadius: '4px',
                    padding: '2px 6px',
                    fontSize: '10px',
                    cursor: 'pointer',
                  }}
                >
                  Fechar Todas ✕
                </button>
              </div>
            )}
          </div>

          {/* Área de Texto do Terminal */}
          <div
            style={{
              flex: 1,
              padding: '10px 12px',
              overflowY: 'auto',
              fontFamily: 'monospace',
              fontSize: '11.5px',
              lineHeight: '1.5',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              background: '#090d16',
            }}
          >
            {logs.length === 0 ? (
              <div style={{ color: theme.textMuted, fontStyle: 'italic' }}>
                Aguardando início do processamento ou fila...
              </div>
            ) : (
              logs.map((log, i) => (
                <div
                  key={i}
                  style={{ color: logColor(log.type), wordBreak: 'break-all' }}
                >
                  {log.text}
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </div>
  )
}
