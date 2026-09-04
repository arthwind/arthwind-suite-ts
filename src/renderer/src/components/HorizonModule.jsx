import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Icons } from '../constants/icons.jsx'

/**
 * Módulo 16 — Horizon Processor
 * Modos:
 * 1. ☁️ Nuvem Arthnex (Direto da API + Planilha de Task IDs com suporte a XLSX multi-abas)
 * 2. 📁 Arquivos Locais (Fluxo Legado de CSVs manuais)
 */

const basename = p => (p ? p.split(/[\\/]/).pop() : '')
const normalizar = s =>
  s
    ? String(s)
        .toLowerCase()
        .replace(/[-_\s]/g, '')
    : ''

// ── Demo data ──────────────────────────────────────────────────────────────
const DEMO_VALIDATION = {
  success: true,
  turbinas_horizon: 5,
  turbinas_atw: 6,
  n_duplicatas: 1,
  turbinas_hor_list: ['WTG-01', 'WTG-02', 'WTG-03', 'WTG-04', 'WTG-05'],
  turbinas_atw_list: [
    'WTG-01',
    'WTG-02',
    'WTG-03',
    'WTG-04',
    'WTG-99',
    'WTG 05',
  ],
  extras: ['WTG-99'],
  faltantes: [],
  auto_matches: { 'WTG-05': 'WTG 05' },
  suggestions: {},
  is_valid: false,
}
const DEMO_REQS = {
  success: true,
  is_valid: false,
  errors: [],
  warnings: [
    'Nenhum arquivo de Damages carregado — confirme se não há registros de danos nesta inspeção.',
    'Summary: datas em formato BR (dd/mm/yyyy) — serão convertidas automaticamente para mm/dd/yyyy',
  ],
}

// ── Secção com cabeçalho numerado ──────────────────────────────────────────
function Section({ num, title, badge, badgeColor, children, D }) {
  return (
    <div
      style={{
        background: D.bgCard,
        border: `1px solid ${D.borderLight}`,
        borderRadius: '8px',
        marginBottom: '10px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '10px 14px',
          background: D.bgDeep,
          borderBottom: `1px solid ${D.borderLight}`,
        }}
      >
        <span
          style={{
            background: D.accentSoft,
            color: D.accent,
            borderRadius: '50%',
            width: '20px',
            height: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '11px',
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {num}
        </span>
        <span
          style={{ color: D.textPrimary, fontSize: '12.5px', fontWeight: 600 }}
        >
          {title}
        </span>
        {badge && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '11px',
              color: badgeColor,
              fontWeight: 500,
            }}
          >
            {badge}
          </span>
        )}
      </div>
      <div style={{ padding: '12px 14px' }}>{children}</div>
    </div>
  )
}

// ── Lista de ficheiros com tags ────────────────────────────────────────────
function FileList({ files, onRemove, D }) {
  if (!files.length) return null
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px',
        marginTop: '6px',
      }}
    >
      {files.map((p, i) => (
        <span
          key={i}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            background: D.accentSoft,
            border: `1px solid ${D.accent}44`,
            color: D.accent,
            borderRadius: '4px',
            padding: '2px 6px',
            fontSize: '11px',
          }}
        >
          {basename(p)}
          <span
            style={{ cursor: 'pointer', opacity: 0.7, lineHeight: 1 }}
            onClick={() => onRemove(i)}
          >
            ×
          </span>
        </span>
      ))}
    </div>
  )
}

// ── Linha de input de ficheiros ────────────────────────────────────────────
function FileInputRow({
  label,
  required,
  files,
  single,
  value,
  onPick,
  onRemove,
  D,
}) {
  const filled = single ? !!value : files?.length > 0
  return (
    <div style={{ marginBottom: '10px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '4px',
        }}
      >
        <span
          style={{ fontSize: '12px', color: D.textSecond, minWidth: '130px' }}
        >
          {label}
          {required && <span style={{ color: D.accent }}> *</span>}
        </span>
        <button
          onClick={onPick}
          style={{
            background: filled ? D.accentSoft : D.inputBg,
            border: `1px solid ${filled ? D.accent : D.border}`,
            color: filled ? D.accent : D.textMuted,
            borderRadius: '4px',
            padding: '4px 12px',
            fontSize: '11px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
          }}
        >
          {Icons.file(filled ? D.accent : D.textMuted)}
          {single
            ? value
              ? basename(value)
              : 'Selecionar CSV...'
            : files?.length > 0
              ? `+ Adicionar (${files.length} carregado${files.length > 1 ? 's' : ''})`
              : 'Selecionar CSV(s)...'}
        </button>
        {single && value && (
          <span
            style={{ cursor: 'pointer', color: D.textMuted }}
            onClick={onRemove}
          >
            {Icons.close(D.textMuted)}
          </span>
        )}
      </div>
      {!single && <FileList files={files || []} onRemove={onRemove} D={D} />}
    </div>
  )
}

// ── Componente principal ───────────────────────────────────────────────────
export default function HorizonModule({ D, isPyWebView, onOpenFolder }) {
  const invoker = window.pywebview?.api || window.api

  // Modo: 'cloud' (Nuvem Arthnex) | 'local' (Legado CSVs)
  const [activeTab, setActiveTab] = useState('cloud')

  // ─── Estado do Modo Nuvem ─────────────────────────────────────────────────
  const [workorders, setWorkorders] = useState([])
  const [loadingWos, setLoadingWos] = useState(false)
  const [selectedWo, setSelectedWo] = useState('')
  const [woSearch, setWoSearch] = useState('')
  const [woTurbines, setWoTurbines] = useState([])
  const [loadingTurbines, setLoadingTurbines] = useState(false)

  // Planilha de Task IDs
  const [taskFile, setTaskFile] = useState('')
  const [taskSheets, setTaskSheets] = useState([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [taskMap, setTaskMap] = useState({})
  const [loadingTaskMap, setLoadingTaskMap] = useState(false)

  // Seleção de Turbinas e Shift+Click
  const [selectedTurbines, setSelectedTurbines] = useState([])
  const [lastClickedIndex, setLastClickedIndex] = useState(null)
  const [turbineSearch, setTurbineSearch] = useState('')
  const [manualTaskOverrides, setManualTaskOverrides] = useState({})

  // Configurações do Pacote
  const [siteName, setSiteName] = useState('')
  const [inspectionType, setInspectionType] = useState('Blade Internal')
  const [cloudLoading, setCloudLoading] = useState(false)
  const [cloudResult, setCloudResult] = useState(null)
  const [cloudLogs, setCloudLogs] = useState([])

  // ─── Estado do Modo Local (Legado) ────────────────────────────────────────
  const [files, setFiles] = useState({
    horizons: [],
    summaries: [],
    details: '',
    damages: [],
  })
  const [loading, setLoading] = useState('')
  const [step, setStep] = useState(0)
  const [validation, setValidation] = useState(null)
  const [removals, setRemovals] = useState({
    turbinas_removidas: [],
    turbinas_horizon_removidas: [],
  })
  const [vinculos, setVinculos] = useState({})
  const [autoAccepted, setAutoAccepted] = useState({})
  const [autoRejected, setAutoRejected] = useState(new Set())
  const [requirements, setRequirements] = useState(null)
  const [reqsLoading, setReqsLoading] = useState(false)
  const reqsTimerRef = useRef(null)
  const [pkg, setPkg] = useState(null)
  const [standaloneSiteName, setStandaloneSiteName] = useState('')

  // ─── Carregar Workorders do Arthnex ───────────────────────────────────────
  const loadWorkorders = useCallback(async () => {
    if (!invoker) return
    setLoadingWos(true)
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
          workorders_id: String(w.workorders_id || w.id),
          description:
            w.description || w.workorder_description || w.id || 'Sem descrição',
          client_name: w.client_name || '',
          windfarm_local: w.windfarm_local || '',
          windfarm_id: w.windfarm_id || 0,
        }))
        normalized.sort((a, b) => a.description.localeCompare(b.description))
        setWorkorders(normalized)
      }
    } catch (e) {
      console.error('Falha ao carregar workorders do Arthnex:', e)
    } finally {
      setLoadingWos(false)
    }
  }, [invoker])

  useEffect(() => {
    loadWorkorders()
  }, [loadWorkorders])

  // ─── Carregar Turbinas da Workorder Selecionada ────────────────────────────
  const handleSelectWorkorder = useCallback(
    async woId => {
      setSelectedWo(woId)
      setWoTurbines([])
      setSelectedTurbines([])
      setCloudResult(null)
      if (!woId || !invoker) return

      const woObj = workorders.find(
        w => w.workorders_id === woId || w.id === woId
      )
      if (woObj) {
        setSiteName(woObj.windfarm_local || woObj.description || 'Wind Farm')
        const desc =
          woObj.description || woObj.workorder_description || woObj.id
        const local = woObj.windfarm_local || woObj.client_name || ''
        setWoSearch(
          `${desc}${local ? ` — ${local}` : ''} (${woObj.workorders_id || woObj.id})`
        )
      }

      setLoadingTurbines(true)
      try {
        const res = await invoker.arthnex_get_turbines_blades?.(woId)
        const list =
          res?.data || res?.turbines || (Array.isArray(res) ? res : [])
        if (Array.isArray(list) && list.length > 0) {
          setWoTurbines(list)
          // Seleciona todas por padrão
          const allNames = list.map(t => t.turbine)
          setSelectedTurbines(allNames)
        }
      } catch (e) {
        console.error('Falha ao carregar turbinas da workorder:', e)
      } finally {
        setLoadingTurbines(false)
      }
    },
    [invoker, workorders]
  )

  const onTypeWorkorder = useCallback(
    text => {
      setWoSearch(text)
      const match = workorders.find(w => {
        const id = String(w.workorders_id || w.id || '')
        const desc = String(w.description || w.workorder_description || id)
        const local = String(w.windfarm_local || w.client_name || '')
        const fullLabel = `${desc}${local ? ` — ${local}` : ''} (${id})`
        return (
          fullLabel.toLowerCase() === text.toLowerCase() ||
          desc.toLowerCase() === text.toLowerCase() ||
          id.toLowerCase() === text.toLowerCase() ||
          (w.description && w.description.toLowerCase() === text.toLowerCase())
        )
      })

      if (match) {
        handleSelectWorkorder(match.workorders_id || match.id)
      } else if (!text) {
        setSelectedWo('')
        setWoTurbines([])
        setSelectedTurbines([])
      }
    },
    [workorders, handleSelectWorkorder]
  )

  // ─── Carregar Planilha de Task IDs (.xlsx ou .csv) ─────────────────────────
  const handlePickTaskFile = async () => {
    if (!invoker) return
    const picked = await invoker.pick_file('xlsx')
    if (!picked) return

    setTaskFile(picked)
    setTaskSheets([])
    setSelectedSheet('')
    setTaskMap({})
    setLoadingTaskMap(true)

    try {
      const ext = picked.split('.').pop()?.toLowerCase()
      if (ext === 'xlsx' || ext === 'xls') {
        const sheetRes = await invoker.horizon_list_xlsx_sheets?.(picked)
        if (sheetRes && sheetRes.success && sheetRes.sheets.length > 0) {
          setTaskSheets(sheetRes.sheets)

          // Tenta encontrar a aba que mais combina com o parque da WO
          const currentParkNorm = normalizar(siteName)
          const matchedSheet =
            sheetRes.sheets.find(s =>
              currentParkNorm
                ? normalizar(s.name).includes(currentParkNorm) ||
                  currentParkNorm.includes(normalizar(s.name))
                : false
            ) || sheetRes.sheets[0]

          const targetSheetName = matchedSheet.name
          setSelectedSheet(targetSheetName)
          if (
            !siteName ||
            siteName === 'Wind Farm' ||
            siteName.startsWith('BOT-')
          ) {
            setSiteName(targetSheetName)
          }

          // Extrai os Task IDs da aba
          const extRes = await invoker.horizon_extract_task_ids?.(
            picked,
            targetSheetName
          )
          if (extRes && extRes.success) {
            setTaskMap(extRes.taskMap || {})
          }
        }
      } else {
        // Arquivo CSV simples
        const extRes = await invoker.horizon_extract_task_ids?.(picked)
        if (extRes && extRes.success) {
          setTaskMap(extRes.taskMap || {})
        }
      }
    } catch (e) {
      console.error('Erro ao processar planilha Horizon:', e)
    } finally {
      setLoadingTaskMap(false)
    }
  }

  const handleChangeSheet = async sheetName => {
    setSelectedSheet(sheetName)
    setSiteName(sheetName)
    if (!taskFile || !invoker) return
    setLoadingTaskMap(true)
    try {
      const extRes = await invoker.horizon_extract_task_ids?.(
        taskFile,
        sheetName
      )
      if (extRes && extRes.success) {
        setTaskMap(extRes.taskMap || {})
      }
    } catch (e) {
      console.error('Erro ao extrair da aba selecionada:', e)
    } finally {
      setLoadingTaskMap(false)
    }
  }

  // ─── Seleção Específica de Turbinas e Shift + Click ───────────────────────
  const handleTurbineCheck = (turbName, index, event) => {
    if (
      event &&
      event.shiftKey &&
      lastClickedIndex !== null &&
      lastClickedIndex !== index
    ) {
      const start = Math.min(lastClickedIndex, index)
      const end = Math.max(lastClickedIndex, index)
      const rangeNames = woTurbines.slice(start, end + 1).map(t => t.turbine)

      setSelectedTurbines(prev => {
        const newSet = new Set(prev)
        rangeNames.forEach(name => newSet.add(name))
        return Array.from(newSet)
      })
    } else {
      setSelectedTurbines(prev =>
        prev.includes(turbName)
          ? prev.filter(n => n !== turbName)
          : [...prev, turbName]
      )
      setLastClickedIndex(index)
    }
  }

  // ─── Resolução Inteligente de Match (Direto, Fuzzy, Numérico e Manual) ────
  const getTurbineMatch = useCallback(
    turbName => {
      // 1. Override manual do usuário
      if (manualTaskOverrides[turbName] !== undefined) {
        const sheetKey = manualTaskOverrides[turbName]
        if (!sheetKey || sheetKey === '__NONE__') {
          return {
            matchedSheetTurbine: '',
            taskId: '',
            matchType: 'manual_none',
          }
        }
        return {
          matchedSheetTurbine: sheetKey,
          taskId: taskMap[sheetKey] || '',
          matchType: 'manual',
        }
      }

      // 2. Match Direto Exato
      if (taskMap[turbName]) {
        return {
          matchedSheetTurbine: turbName,
          taskId: taskMap[turbName],
          matchType: 'direct',
        }
      }

      // 3. Match Fuzzy por normalização (remove -, _, espaços, minúsculas)
      const normT = normalizar(turbName)
      const sheetKeys = Object.keys(taskMap)
      const fuzzyKey = sheetKeys.find(k => normalizar(k) === normT)
      if (fuzzyKey) {
        return {
          matchedSheetTurbine: fuzzyKey,
          taskId: taskMap[fuzzyKey],
          matchType: 'fuzzy',
        }
      }

      // 4. Match Numérico / Dígitos (ex: "HIW_008" vs "WTG-08" ou "8")
      const digitsT = turbName.replace(/\D/g, '').replace(/^0+/, '')
      if (digitsT) {
        const digitKey = sheetKeys.find(k => {
          const d = k.replace(/\D/g, '').replace(/^0+/, '')
          return d && d === digitsT
        })
        if (digitKey) {
          return {
            matchedSheetTurbine: digitKey,
            taskId: taskMap[digitKey],
            matchType: 'fuzzy',
          }
        }
      }

      return {
        matchedSheetTurbine: '',
        taskId: '',
        matchType: 'none',
      }
    },
    [taskMap, manualTaskOverrides]
  )

  const selectMatchedOnly = () => {
    const matched = woTurbines
      .filter(t => Boolean(getTurbineMatch(t.turbine).taskId))
      .map(t => t.turbine)
    setSelectedTurbines(matched)
  }

  const selectAll = () => {
    setSelectedTurbines(woTurbines.map(t => t.turbine))
  }

  const deselectAll = () => {
    setSelectedTurbines([])
  }

  const resetAllManualMatches = () => {
    setManualTaskOverrides({})
  }

  // ─── Processamento Direto via Nuvem ───────────────────────────────────────
  const handleGenerateFromCloud = async () => {
    if (!selectedWo || !invoker) return
    if (selectedTurbines.length === 0) {
      alert('Selecione pelo menos 1 turbina para incluir no pacote.')
      return
    }

    setCloudLoading(true)
    setCloudResult(null)
    setCloudLogs([])

    // Compila o taskMap efetivo considerando os matches automáticos e manuais
    const effectiveTaskMap = {}
    woTurbines.forEach(t => {
      const match = getTurbineMatch(t.turbine)
      if (match.taskId) {
        effectiveTaskMap[t.turbine] = match.taskId
      }
    })

    const woObj = workorders.find(
      w => w.workorders_id === selectedWo || w.id === selectedWo
    )
    const workorderNumber =
      woObj?.description || woObj?.workorder_description || ''

    try {
      const res = await invoker.horizon_process_from_arthnex?.({
        workorderId: selectedWo,
        workorderNumber,
        taskFilePath: taskFile,
        taskMap: effectiveTaskMap,
        selectedTurbines,
        siteName,
        inspectionType,
      })

      if (res && res.success) {
        setCloudResult(res)
      } else {
        alert(`Erro ao gerar pacote Horizon: ${res?.error || 'Desconhecido'}`)
      }
    } catch (e) {
      alert(`Erro inesperado: ${e}`)
    } finally {
      setCloudLoading(false)
    }
  }

  // ─── Normalização do Modo Local ───────────────────────────────────────────
  const computedState = validation
    ? (() => {
        const setAtw = new Set(validation.turbinas_atw_list)
        const setHor = new Set(validation.turbinas_hor_list)
        const allVinculos = { ...vinculos, ...autoAccepted }
        const setMapped = new Set(Object.values(allVinculos))
        const setVincKey = new Set(Object.keys(allVinculos))
        const removidasSet = new Set(removals.turbinas_removidas)
        const horRemovidasSet = new Set(removals.turbinas_horizon_removidas)

        const autoMatchesPendentes = Object.fromEntries(
          Object.entries(validation.auto_matches || {}).filter(
            ([th]) => !autoAccepted[th] && !autoRejected.has(th)
          )
        )
        const setAutoHor = new Set(Object.keys(autoMatchesPendentes))
        const setAutoAtw = new Set(Object.values(autoMatchesPendentes))

        const setHorResolvido = new Set([
          ...setVincKey,
          ...Object.keys(autoAccepted),
        ])
        const setAtwResolvido = new Set([...setMapped])
        const setHorSemVinculo = new Set(
          [...setHor].filter(t => !setHorResolvido.has(t) && !setAutoHor.has(t))
        )

        const extras = [...setAtw]
          .filter(
            t =>
              !setHor.has(t) &&
              !setAtwResolvido.has(t) &&
              !setAutoAtw.has(t) &&
              !removidasSet.has(t)
          )
          .sort()
        const faltantes = [...setHorSemVinculo]
          .filter(t => !setAtw.has(t) && !horRemovidasSet.has(t))
          .sort()
        const opcAtw = [...setAtw]
          .filter(
            t =>
              !removidasSet.has(t) &&
              !setAtwResolvido.has(t) &&
              !setAutoAtw.has(t)
          )
          .sort()
        const pendentesOk = Object.keys(autoMatchesPendentes).length === 0

        return {
          extras,
          faltantes,
          opcAtw,
          autoMatchesPendentes,
          pendentesOk,
          isValid: extras.length === 0 && faltantes.length === 0 && pendentesOk,
        }
      })()
    : null

  const pickMulti = useCallback(
    async key => {
      if (!invoker) return
      const paths = await invoker.pick_files('csv')
      if (paths?.length) setFiles(f => ({ ...f, [key]: [...f[key], ...paths] }))
    },
    [invoker]
  )

  const pickSingle = useCallback(
    async key => {
      if (!invoker) return
      const path = await invoker.pick_file('csv')
      if (path) setFiles(f => ({ ...f, [key]: path }))
    },
    [invoker]
  )

  const removeFromArray = (key, idx) =>
    setFiles(f => ({ ...f, [key]: f[key].filter((_, i) => i !== idx) }))

  const handleFixDamagesStandalone = async () => {
    if (!invoker) return
    const paths = await invoker.pick_files('csv')
    if (!paths || paths.length === 0) return

    setLoading('fix_damages')
    try {
      const res = await invoker.horizon_corrigir_damages_direto(
        paths,
        standaloneSiteName
      )
      if (res.success) {
        alert(
          `Sucesso! ${res.corrected_files.length} arquivo(s) de Damages corrigidos.`
        )
        if (res.corrected_files.length > 0 && onOpenFolder) {
          onOpenFolder(res.corrected_files[0])
        }
      } else {
        alert(`Erro: ${res.error}`)
      }
    } catch (e) {
      alert(`Erro inesperado: ${e}`)
    } finally {
      setLoading('')
    }
  }

  const handleAnalyze = async () => {
    setLoading('analyze')
    try {
      const result = invoker
        ? await invoker.horizon_analisar(files.horizons, files.summaries)
        : DEMO_VALIDATION
      if (result.success) {
        setValidation(result)
        setRemovals({ turbinas_removidas: [], turbinas_horizon_removidas: [] })
        setVinculos({})
        setAutoAccepted({})
        setAutoRejected(new Set())
        setRequirements(null)
        setPkg(null)
        setStep(1)
      } else {
        alert(`Erro: ${result.error}`)
      }
    } finally {
      setLoading('')
    }
  }

  const doCheckReqs = useCallback(
    async (f, r, v, aa) => {
      if (!f.details) return
      setReqsLoading(true)
      try {
        const allV = { ...v, ...aa }
        const result = invoker
          ? await invoker.horizon_validar_requisitos(
              f.horizons,
              f.summaries,
              f.details,
              f.damages,
              r.turbinas_removidas,
              allV
            )
          : DEMO_REQS
        if (result.success) {
          setRequirements(result)
        } else {
          setRequirements({
            success: false,
            is_valid: false,
            errors: [`Erro: ${result.error || 'desconhecido'}`],
            warnings: [],
          })
        }
      } catch (e) {
        setRequirements({
          success: false,
          is_valid: false,
          errors: [String(e)],
          warnings: [],
        })
      } finally {
        setReqsLoading(false)
      }
    },
    [invoker]
  )

  const scheduleReqsCheck = useCallback(
    (f, r, v, aa) => {
      if (reqsTimerRef.current) clearTimeout(reqsTimerRef.current)
      reqsTimerRef.current = setTimeout(() => doCheckReqs(f, r, v, aa), 600)
    },
    [doCheckReqs]
  )

  useEffect(() => {
    if (!files.details) {
      setRequirements(null)
      return
    }
    scheduleReqsCheck(files, removals, vinculos, autoAccepted)
    return () => {
      if (reqsTimerRef.current) clearTimeout(reqsTimerRef.current)
    }
  }, [files.details, files.damages, files.summaries, files.horizons]) // eslint-disable-line

  const handleGenerateLocal = async () => {
    setLoading('generate')
    try {
      const allV = { ...vinculos, ...autoAccepted }
      const result = invoker
        ? await invoker.horizon_gerar_pacote(
            files.horizons,
            files.summaries,
            files.details,
            files.damages,
            allV,
            removals.turbinas_removidas,
            removals.turbinas_horizon_removidas
          )
        : { success: true, zip_path: '/tmp/Horizon_Package.zip' }

      if (result.success) {
        setPkg(result)
        setStep(3)
      } else {
        alert(`Erro ao gerar pacote: ${result.error}`)
      }
    } finally {
      setLoading('')
    }
  }

  const btn = (color, bg) => ({
    background: bg || color,
    color: bg ? color : '#fff',
    border: `1px solid ${color}`,
    borderRadius: '4px',
    padding: '6px 14px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
  })

  // ─── Estilos e Renderização ───────────────────────────────────────────────
  const taskMapNorm = {}
  Object.entries(taskMap).forEach(([k, v]) => {
    taskMapNorm[normalizar(k)] = v
  })

  return (
    <div
      style={{ maxWidth: '1000px', margin: '0 auto', paddingBottom: '30px' }}
    >
      {/* ── Comutador de Abas: Nuvem vs Local ── */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '16px',
          borderBottom: `1px solid ${D.borderLight}`,
          paddingBottom: '8px',
        }}
      >
        <button
          onClick={() => setActiveTab('cloud')}
          style={{
            background: activeTab === 'cloud' ? D.accentSoft : 'transparent',
            border: `1px solid ${activeTab === 'cloud' ? D.accent : D.borderLight}`,
            color: activeTab === 'cloud' ? D.accent : D.textSecond,
            borderRadius: '6px',
            padding: '8px 16px',
            fontSize: '12.5px',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>☁️</span> Nuvem Arthnex (Recomendado)
        </button>

        <button
          onClick={() => setActiveTab('local')}
          style={{
            background: activeTab === 'local' ? D.accentSoft : 'transparent',
            border: `1px solid ${activeTab === 'local' ? D.accent : D.borderLight}`,
            color: activeTab === 'local' ? D.accent : D.textSecond,
            borderRadius: '6px',
            padding: '8px 16px',
            fontSize: '12.5px',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>📁</span> Arquivos Locais (Legado)
        </button>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          MODO NUVEM ARTHNEX
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'cloud' && (
        <div>
          {/* ── 1. Ordem de Serviço (Arthnex) ── */}
          <Section
            num="1"
            title="Ordem de Serviço (Arthnex Cloud)"
            D={D}
            badge={
              selectedWo
                ? `O.S. ${selectedWo} (${woTurbines.length} Turbinas)`
                : 'Selecione uma O.S.'
            }
            badgeColor={selectedWo ? D.success : D.textMuted}
          >
            <div
              style={{
                display: 'flex',
                gap: '10px',
                alignItems: 'center',
              }}
            >
              <div style={{ flex: 1, position: 'relative' }}>
                <input
                  list="horizon-wo-options"
                  value={woSearch}
                  disabled={loadingWos}
                  placeholder={
                    loadingWos
                      ? 'Carregando workorders...'
                      : '🔍 Digite para buscar e selecionar por código, parque ou cliente...'
                  }
                  onChange={e => onTypeWorkorder(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    background: D.inputBg,
                    border: `1px solid ${selectedWo ? D.accent : D.borderLight}`,
                    color: D.textPrimary,
                    fontSize: '12.5px',
                  }}
                />
                <datalist id="horizon-wo-options">
                  {workorders.map(wo => {
                    const id = wo.workorders_id || wo.id
                    const desc =
                      wo.description || wo.workorder_description || id
                    const local = wo.windfarm_local || wo.client_name || ''
                    const fullLabel = `${desc}${local ? ` — ${local}` : ''} (${id})`
                    return <option key={id} value={fullLabel} />
                  })}
                </datalist>
              </div>

              {woSearch && (
                <button
                  onClick={() => {
                    setWoSearch('')
                    setSelectedWo('')
                    setWoTurbines([])
                    setSelectedTurbines([])
                  }}
                  title="Limpar seleção"
                  style={{
                    background: 'transparent',
                    border: 0,
                    color: D.textMuted,
                    cursor: 'pointer',
                    fontSize: '12px',
                    padding: '4px 8px',
                  }}
                >
                  ✕ Limpar
                </button>
              )}

              <button
                onClick={loadWorkorders}
                disabled={loadingWos}
                style={{
                  ...btn(D.border, D.bgDeep),
                  color: D.textSecond,
                  padding: '7px 12px',
                  fontSize: '11.5px',
                }}
              >
                {loadingWos ? 'Carregando...' : '🔄 Atualizar'}
              </button>
            </div>

            {selectedWo && (
              <div
                style={{
                  marginTop: '8px',
                  fontSize: '12px',
                  color: D.success,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                ✓ <strong>O.S. Conectada:</strong> {selectedWo}{' '}
                {siteName ? `— Parque: ${siteName}` : ''}
              </div>
            )}

            {loadingTurbines && (
              <div
                style={{
                  marginTop: '10px',
                  fontSize: '12px',
                  color: D.textMuted,
                }}
              >
                🔄 Buscando turbinas e fotos da O.S. no Arthnex...
              </div>
            )}
          </Section>

          {/* ── 2. Planilha de Horizon Task IDs ── */}
          <Section
            num="2"
            title="Planilha de Horizon Task IDs (.xlsx / .csv)"
            D={D}
            badge={
              Object.keys(taskMap).length > 0
                ? `🟢 ${Object.keys(taskMap).length} Task IDs Carregados`
                : 'Pendente'
            }
            badgeColor={Object.keys(taskMap).length > 0 ? D.success : D.warning}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                flexWrap: 'wrap',
              }}
            >
              <button
                onClick={handlePickTaskFile}
                disabled={loadingTaskMap}
                style={btn(D.accent, taskFile ? D.accentSoft : undefined)}
              >
                {Icons.file(taskFile ? D.accent : '#fff')}
                {taskFile
                  ? basename(taskFile)
                  : 'Selecionar Planilha Horizon...'}
              </button>

              {taskSheets.length > 1 && (
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <span style={{ fontSize: '12px', color: D.textSecond }}>
                    Aba do Parque:
                  </span>
                  <select
                    value={selectedSheet}
                    onChange={e => handleChangeSheet(e.target.value)}
                    style={{
                      padding: '5px 10px',
                      borderRadius: '4px',
                      background: D.inputBg,
                      border: `1px solid ${D.borderLight}`,
                      color: D.textPrimary,
                      fontSize: '12px',
                    }}
                  >
                    {taskSheets.map(s => (
                      <option key={s.name} value={s.name}>
                        {s.name} ({s.rowCount} linhas)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {loadingTaskMap && (
                <span style={{ fontSize: '12px', color: D.textMuted }}>
                  🔄 Extraindo IDs...
                </span>
              )}
            </div>

            {taskFile && Object.keys(taskMap).length > 0 && (
              <div
                style={{
                  marginTop: '10px',
                  fontSize: '12px',
                  color: D.textSecond,
                  display: 'flex',
                  gap: '12px',
                }}
              >
                <span>
                  ✓ Arquivo: <strong>{basename(taskFile)}</strong>
                </span>
                {selectedSheet && (
                  <span>
                    ✓ Aba: <strong>{selectedSheet}</strong>
                  </span>
                )}
                <span>
                  ✓ Mapeados: <strong>{Object.keys(taskMap).length} IDs</strong>
                </span>
              </div>
            )}
          </Section>

          {/* ── 3. Auditoria, Vínculo Lado a Lado ("De / Para") e Seleção de Turbinas ── */}
          {woTurbines.length > 0 && (
            <Section
              num="3"
              title="Auditoria e Mapeamento de Turbinas (Arthnex ↔ Horizon)"
              D={D}
              badge={`📊 ${selectedTurbines.length} de ${woTurbines.length} selecionadas`}
              badgeColor={selectedTurbines.length > 0 ? D.success : D.textMuted}
            >
              {(() => {
                const sheetTurbines = Object.keys(taskMap).sort()
                const filteredWoTurbines = woTurbines.filter(t => {
                  if (!turbineSearch) return true
                  const q = turbineSearch.toLowerCase()
                  const match = getTurbineMatch(t.turbine)
                  return (
                    t.turbine.toLowerCase().includes(q) ||
                    match.matchedSheetTurbine.toLowerCase().includes(q) ||
                    match.taskId.toLowerCase().includes(q)
                  )
                })

                const numManualOverrides =
                  Object.keys(manualTaskOverrides).length

                return (
                  <div>
                    {/* Barra de Ações Rápidas e Busca */}
                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        marginBottom: '12px',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                      }}
                    >
                      <input
                        type="text"
                        placeholder="🔍 Filtrar turbinas na tabela (ex: 08, HIW, etc.)..."
                        value={turbineSearch}
                        onChange={e => setTurbineSearch(e.target.value)}
                        style={{
                          padding: '5px 10px',
                          borderRadius: '5px',
                          background: D.inputBg,
                          border: `1px solid ${D.borderLight}`,
                          color: D.textPrimary,
                          fontSize: '11.5px',
                          minWidth: '220px',
                        }}
                      />

                      <button
                        onClick={selectMatchedOnly}
                        style={{
                          ...btn(D.accent, D.accentSoft),
                          padding: '4px 10px',
                          fontSize: '11px',
                        }}
                      >
                        🎯 Apenas com Task ID (
                        {
                          woTurbines.filter(t =>
                            Boolean(getTurbineMatch(t.turbine).taskId)
                          ).length
                        }
                        )
                      </button>

                      <button
                        onClick={() => {
                          const visNames = filteredWoTurbines.map(
                            t => t.turbine
                          )
                          setSelectedTurbines(prev => {
                            const n = new Set(prev)
                            visNames.forEach(name => n.add(name))
                            return Array.from(n)
                          })
                        }}
                        style={{
                          ...btn(D.border, D.bgDeep),
                          color: D.textPrimary,
                          padding: '4px 10px',
                          fontSize: '11px',
                        }}
                      >
                        ✅ Selecionar Visíveis ({filteredWoTurbines.length})
                      </button>

                      <button
                        onClick={() => {
                          const visSet = new Set(
                            filteredWoTurbines.map(t => t.turbine)
                          )
                          setSelectedTurbines(prev =>
                            prev.filter(name => !visSet.has(name))
                          )
                        }}
                        style={{
                          ...btn(D.border, D.bgDeep),
                          color: D.textPrimary,
                          padding: '4px 10px',
                          fontSize: '11px',
                        }}
                      >
                        ❌ Desmarcar Visíveis
                      </button>

                      {numManualOverrides > 0 && (
                        <button
                          onClick={resetAllManualMatches}
                          style={{
                            ...btn(D.warning, `${D.warning}22`),
                            color: D.warning,
                            padding: '4px 10px',
                            fontSize: '11px',
                          }}
                        >
                          ↺ Resetar Matches Manuais ({numManualOverrides})
                        </button>
                      )}

                      <span
                        style={{
                          fontSize: '11px',
                          color: D.textMuted,
                          marginLeft: 'auto',
                        }}
                      >
                        💡 Segure <strong>Shift + Clique</strong> para
                        selecionar intervalos.
                      </span>
                    </div>

                    {/* Tabela Lado a Lado "De / Para" */}
                    <div
                      style={{
                        maxHeight: '320px',
                        overflowY: 'auto',
                        border: `1px solid ${D.borderLight}`,
                        borderRadius: '6px',
                      }}
                    >
                      <table
                        style={{
                          width: '100%',
                          borderCollapse: 'collapse',
                          fontSize: '12px',
                        }}
                      >
                        <thead>
                          <tr
                            style={{
                              background: D.bgDeep,
                              borderBottom: `1px solid ${D.borderLight}`,
                              color: D.textSecond,
                              textAlign: 'left',
                            }}
                          >
                            <th style={{ padding: '8px 10px', width: '36px' }}>
                              #
                            </th>
                            <th style={{ padding: '8px 10px' }}>
                              Turbina (Arthnex / O.S.)
                            </th>
                            <th style={{ padding: '8px 10px' }}>
                              Correspondência na Planilha (Horizon)
                            </th>
                            <th style={{ padding: '8px 10px' }}>
                              Horizon Task ID
                            </th>
                            <th style={{ padding: '8px 10px' }}>Pás</th>
                            <th style={{ padding: '8px 10px' }}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredWoTurbines.map((t, idx) => {
                            const isSelected = selectedTurbines.includes(
                              t.turbine
                            )
                            const match = getTurbineMatch(t.turbine)
                            const isManual =
                              manualTaskOverrides[t.turbine] !== undefined

                            return (
                              <tr
                                key={t.turbine || idx}
                                onClick={e =>
                                  handleTurbineCheck(t.turbine, idx, e)
                                }
                                style={{
                                  cursor: 'pointer',
                                  background: isSelected
                                    ? `${D.accent}12`
                                    : idx % 2 === 0
                                      ? 'transparent'
                                      : `${D.bgDeep}40`,
                                  borderBottom: `1px solid ${D.borderLight}40`,
                                }}
                              >
                                <td style={{ padding: '6px 10px' }}>
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => {}} // tratado no onClick do tr
                                    style={{ cursor: 'pointer' }}
                                  />
                                </td>
                                <td
                                  style={{
                                    padding: '6px 10px',
                                    fontWeight: 600,
                                    color: isSelected
                                      ? D.accent
                                      : D.textPrimary,
                                  }}
                                >
                                  {t.turbine}
                                </td>

                                {/* Seletor / De-Para Lado a Lado */}
                                <td
                                  style={{ padding: '6px 10px' }}
                                  onClick={e => e.stopPropagation()}
                                >
                                  {sheetTurbines.length > 0 ? (
                                    <div
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '6px',
                                      }}
                                    >
                                      <select
                                        value={
                                          match.matchedSheetTurbine ||
                                          '__NONE__'
                                        }
                                        onChange={e => {
                                          const val = e.target.value
                                          setManualTaskOverrides(prev => ({
                                            ...prev,
                                            [t.turbine]: val,
                                          }))
                                        }}
                                        style={{
                                          fontSize: '11.5px',
                                          padding: '3px 8px',
                                          borderRadius: '4px',
                                          background: isManual
                                            ? `${D.accent}22`
                                            : D.inputBg,
                                          border: `1px solid ${
                                            isManual ? D.accent : D.borderLight
                                          }`,
                                          color: isManual
                                            ? D.accent
                                            : D.textPrimary,
                                          fontWeight: isManual ? 600 : 400,
                                          cursor: 'pointer',
                                          maxWidth: '220px',
                                        }}
                                      >
                                        <option value="__NONE__">
                                          -- Sem Vínculo (Não Mapear) --
                                        </option>
                                        {sheetTurbines.map(st => (
                                          <option key={st} value={st}>
                                            {st}{' '}
                                            {st === t.turbine
                                              ? '(Nome Idêntico)'
                                              : ''}
                                          </option>
                                        ))}
                                      </select>
                                      {isManual && (
                                        <button
                                          onClick={() => {
                                            setManualTaskOverrides(prev => {
                                              const c = { ...prev }
                                              delete c[t.turbine]
                                              return c
                                            })
                                          }}
                                          title="Restaurar para match automático"
                                          style={{
                                            background: D.accentSoft,
                                            border: `1px solid ${D.accent}44`,
                                            color: D.accent,
                                            borderRadius: '4px',
                                            padding: '2px 6px',
                                            cursor: 'pointer',
                                            fontSize: '10.5px',
                                            fontWeight: 600,
                                          }}
                                        >
                                          ↺ Auto
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <span
                                      style={{
                                        color: D.textMuted,
                                        fontSize: '11px',
                                        fontStyle: 'italic',
                                      }}
                                    >
                                      Carregue a planilha no passo 2
                                    </span>
                                  )}
                                </td>

                                <td
                                  style={{
                                    padding: '6px 10px',
                                    color: match.taskId
                                      ? D.textPrimary
                                      : D.textMuted,
                                    fontFamily: 'monospace',
                                    fontSize: '11px',
                                  }}
                                >
                                  {match.taskId || '(Pendente)'}
                                </td>
                                <td
                                  style={{
                                    padding: '6px 10px',
                                    color: D.textSecond,
                                  }}
                                >
                                  {t.windblades?.length || 3} pás
                                </td>
                                <td style={{ padding: '6px 10px' }}>
                                  {match.matchType === 'direct' && (
                                    <span
                                      style={{
                                        background: `${D.success}22`,
                                        color: D.success,
                                        padding: '2px 6px',
                                        borderRadius: '4px',
                                        fontSize: '10.5px',
                                        fontWeight: 600,
                                      }}
                                    >
                                      ✓ Direto
                                    </span>
                                  )}
                                  {match.matchType === 'fuzzy' && (
                                    <span
                                      style={{
                                        background: `${D.accent}22`,
                                        color: D.accent,
                                        padding: '2px 6px',
                                        borderRadius: '4px',
                                        fontSize: '10.5px',
                                        fontWeight: 600,
                                      }}
                                    >
                                      ⚡ Automático
                                    </span>
                                  )}
                                  {match.matchType === 'manual' && (
                                    <span
                                      style={{
                                        background: `${D.warning}22`,
                                        color: D.warning,
                                        padding: '2px 6px',
                                        borderRadius: '4px',
                                        fontSize: '10.5px',
                                        fontWeight: 600,
                                      }}
                                    >
                                      ✏️ Manual
                                    </span>
                                  )}
                                  {match.matchType === 'manual_none' && (
                                    <span
                                      style={{
                                        background: `${D.textMuted}22`,
                                        color: D.textMuted,
                                        padding: '2px 6px',
                                        borderRadius: '4px',
                                        fontSize: '10.5px',
                                        fontWeight: 600,
                                      }}
                                    >
                                      🚫 Ignorado
                                    </span>
                                  )}
                                  {match.matchType === 'none' && (
                                    <span
                                      style={{
                                        background: `${D.error}22`,
                                        color: D.error,
                                        padding: '2px 6px',
                                        borderRadius: '4px',
                                        fontSize: '10.5px',
                                        fontWeight: 600,
                                      }}
                                    >
                                      ⚠ Sem ID
                                    </span>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              })()}
            </Section>
          )}

          {/* ── 4. Configuração e Geração do Pacote ── */}
          {selectedWo && (
            <Section num="4" title="Geração do Pacote SkySpecs/Horizon" D={D}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '12px',
                  marginBottom: '16px',
                }}
              >
                <div>
                  <label
                    style={{
                      fontSize: '12px',
                      color: D.textSecond,
                      display: 'block',
                      marginBottom: '4px',
                    }}
                  >
                    Nome do Parque (Site):
                  </label>
                  <input
                    type="text"
                    value={siteName}
                    onChange={e => setSiteName(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '7px 10px',
                      borderRadius: '5px',
                      background: D.inputBg,
                      border: `1px solid ${D.borderLight}`,
                      color: D.textPrimary,
                      fontSize: '12px',
                    }}
                  />
                </div>

                <div>
                  <label
                    style={{
                      fontSize: '12px',
                      color: D.textSecond,
                      display: 'block',
                      marginBottom: '4px',
                    }}
                  >
                    Tipo de Inspeção (Inspection Type):
                  </label>
                  <select
                    value={inspectionType}
                    onChange={e => setInspectionType(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '7px 10px',
                      borderRadius: '5px',
                      background: D.inputBg,
                      border: `1px solid ${D.borderLight}`,
                      color: D.textPrimary,
                      fontSize: '12px',
                    }}
                  >
                    <option value="Autonomous Drone">Autonomous Drone</option>
                    <option value="Manual Drone">Manual Drone</option>
                    <option value="Blade Internal">Blade Internal</option>
                    <option value="Ground Photo">Ground Photo</option>
                  </select>
                </div>
              </div>

              <div
                style={{ display: 'flex', gap: '12px', alignItems: 'center' }}
              >
                <button
                  onClick={handleGenerateFromCloud}
                  disabled={cloudLoading || selectedTurbines.length === 0}
                  style={{
                    ...btn(
                      D.accent,
                      cloudLoading || selectedTurbines.length === 0
                        ? undefined
                        : undefined
                    ),
                    padding: '10px 20px',
                    fontSize: '13px',
                  }}
                >
                  {cloudLoading
                    ? '⏳ Gerando Pacote...'
                    : '📦 Gerar Pacote Horizon (.ZIP)'}
                </button>

                <span style={{ fontSize: '12px', color: D.textSecond }}>
                  Incluirá <strong>{selectedTurbines.length} turbina(s)</strong>{' '}
                  selecionada(s).
                </span>
              </div>

              {/* Resultado da Geração */}
              {cloudResult && (
                <div
                  style={{
                    marginTop: '16px',
                    padding: '14px',
                    borderRadius: '8px',
                    background: `${D.success}15`,
                    border: `1px solid ${D.success}44`,
                  }}
                >
                  <div
                    style={{
                      fontWeight: 700,
                      color: D.success,
                      fontSize: '13.5px',
                      marginBottom: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <span>✔</span> Pacote SkySpecs/Horizon Gerado com Sucesso!
                  </div>

                  <div
                    style={{
                      fontSize: '12px',
                      color: D.textPrimary,
                      marginBottom: '10px',
                      display: 'flex',
                      gap: '16px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span>
                      📋 Turbinas: <strong>{cloudResult.summaryCount}</strong>
                    </span>
                    <span>
                      📷 Fotos: <strong>{cloudResult.detailsCount}</strong>
                    </span>
                    <span>
                      🔍 Danos: <strong>{cloudResult.damagesCount}</strong>
                    </span>
                  </div>

                  <div
                    style={{
                      fontSize: '11.5px',
                      color: D.textMuted,
                      wordBreak: 'break-all',
                      marginBottom: '12px',
                    }}
                  >
                    Arquivo: {cloudResult.zipPath}
                  </div>

                  {cloudResult.zipPath && onOpenFolder && (
                    <button
                      onClick={() => onOpenFolder(cloudResult.zipPath)}
                      style={btn(D.success)}
                    >
                      📂 Abrir Pasta do Pacote
                    </button>
                  )}
                </div>
              )}
            </Section>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          MODO ARQUIVOS LOCAIS (LEGADO)
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'local' && (
        <div>
          {/* ── 1. FICHEIROS ── */}
          <Section
            num="1"
            title="Ficheiros de Entrada (Modo Manual)"
            D={D}
            badge={
              files.horizons.length > 0 && files.summaries.length > 0
                ? `${files.horizons.length + files.summaries.length + (files.details ? 1 : 0) + files.damages.length} ficheiro(s)`
                : null
            }
            badgeColor={D.textMuted}
          >
            <FileInputRow
              label="Base Horizon"
              required
              D={D}
              files={files.horizons}
              onPick={() => pickMulti('horizons')}
              onRemove={i => removeFromArray('horizons', i)}
            />

            <FileInputRow
              label="Summary ATW"
              required
              D={D}
              files={files.summaries}
              onPick={() => pickMulti('summaries')}
              onRemove={i => removeFromArray('summaries', i)}
            />

            <FileInputRow
              label="Details"
              D={D}
              single
              value={files.details}
              onPick={() => pickSingle('details')}
              onRemove={() => setFiles(f => ({ ...f, details: '' }))}
            />

            <FileInputRow
              label="Damages"
              D={D}
              files={files.damages}
              onPick={() => pickMulti('damages')}
              onRemove={i => removeFromArray('damages', i)}
            />

            <div
              style={{
                marginTop: '12px',
                paddingTop: '10px',
                borderTop: `1px solid ${D.borderLight}`,
              }}
            >
              <button
                style={{
                  ...btn(
                    D.accent,
                    files.horizons.length > 0 && files.summaries.length > 0
                      ? D.accentSoft
                      : undefined
                  ),
                  opacity:
                    files.horizons.length > 0 && files.summaries.length > 0
                      ? 1
                      : 0.5,
                  cursor:
                    files.horizons.length > 0 && files.summaries.length > 0
                      ? 'pointer'
                      : 'not-allowed',
                }}
                disabled={
                  !(files.horizons.length > 0 && files.summaries.length > 0) ||
                  loading === 'analyze'
                }
                onClick={handleAnalyze}
              >
                {loading === 'analyze'
                  ? 'A analisar...'
                  : 'Analisar Nomenclatura →'}
              </button>
            </div>
          </Section>

          {/* ── 2. NOMENCLATURA ── */}
          {validation && (
            <Section
              num="2"
              title="Validação de Nomenclatura"
              D={D}
              badge={computedState?.isValid ? '✅ OK' : '⚠ Por resolver'}
              badgeColor={computedState?.isValid ? D.success : D.warning}
            >
              <div style={{ fontSize: '12px', color: D.textSecond }}>
                Turbinas Horizon: <strong>{validation.turbinas_horizon}</strong>{' '}
                | Turbinas ATW: <strong>{validation.turbinas_atw}</strong>
              </div>

              {computedState?.extras.length > 0 && (
                <div
                  style={{
                    marginTop: '8px',
                    color: D.warning,
                    fontSize: '12px',
                  }}
                >
                  ⚠ Turbinas extras na ATW: {computedState.extras.join(', ')}
                </div>
              )}
              {computedState?.faltantes.length > 0 && (
                <div
                  style={{ marginTop: '8px', color: D.error, fontSize: '12px' }}
                >
                  ❌ Turbinas faltantes na ATW:{' '}
                  {computedState.faltantes.join(', ')}
                </div>
              )}

              <div style={{ marginTop: '12px' }}>
                <button
                  style={btn(D.accent)}
                  disabled={!computedState?.isValid || loading === 'generate'}
                  onClick={handleGenerateLocal}
                >
                  {loading === 'generate'
                    ? 'A gerar pacote...'
                    : 'Gerar Pacote Horizon (.ZIP) →'}
                </button>
              </div>
            </Section>
          )}

          {/* ── 3. PACOTE CONCLUÍDO (LOCAL) ── */}
          {pkg && (
            <Section num="3" title="Pacote Gerado" D={D}>
              <div
                style={{
                  padding: '12px',
                  borderRadius: '6px',
                  background: `${D.success}15`,
                  color: D.success,
                  fontWeight: 600,
                  fontSize: '13px',
                }}
              >
                ✔ Pacote gerado com sucesso: {pkg.zip_path}
              </div>
              {pkg.zip_path && onOpenFolder && (
                <div style={{ marginTop: '10px' }}>
                  <button
                    onClick={() => onOpenFolder(pkg.zip_path)}
                    style={btn(D.success)}
                  >
                    📂 Abrir Pasta
                  </button>
                </div>
              )}
            </Section>
          )}

          {/* ── Utilitário Standalone: Higienizar Damages ── */}
          <div style={{ marginTop: '20px' }}>
            <Section
              num="+"
              title="Utilitário: Higienizar Damages Direto"
              D={D}
            >
              <div
                style={{ display: 'flex', gap: '8px', alignItems: 'center' }}
              >
                <input
                  type="text"
                  placeholder="Nome do Site (Opcional)"
                  value={standaloneSiteName}
                  onChange={e => setStandaloneSiteName(e.target.value)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '4px',
                    background: D.inputBg,
                    border: `1px solid ${D.borderLight}`,
                    color: D.textPrimary,
                    fontSize: '12px',
                  }}
                />
                <button
                  onClick={handleFixDamagesStandalone}
                  disabled={loading === 'fix_damages'}
                  style={btn(D.accent, D.accentSoft)}
                >
                  {loading === 'fix_damages'
                    ? 'Higienizando...'
                    : 'Selecionar CSVs de Damages...'}
                </button>
              </div>
            </Section>
          </div>
        </div>
      )}
    </div>
  )
}
