import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icons } from '../constants/icons.jsx'

// Módulo 19 — Arthnex Uploader: replica corrigida do "Image Uploader" oficial
// (mesma API: scheduler.arthnex.com + x-api-key estática). A correção em relação ao
// original é no backend (arthnex_uploader_api.py): o nome enviado ao servidor é sempre
// só o nome do arquivo (sem subpastas), mesmo quando o CSV referencia o arquivo por um
// caminho relativo com subpastas (caso comum do Arthdrone).
//
// Suporta enviar vários CSVs de uma vez (ex: a turbina inteira): a pá de cada CSV é
// detectada automaticamente pela coluna "blade" e "turbine", ou pode ser vinculada
// manualmente via dropdown inline ou modal de mapeamento por turbina (3 pás).
export default function ArthnexUploaderModule({ T, D }) {
  const [useHomolog, setUseHomolog] = useState(false)
  const [workorders, setWorkorders] = useState([])
  const [workorderId, setWorkorderId] = useState('')
  const [workorderQuery, setWorkorderQuery] = useState('')
  const [pSurface, setPSurface] = useState('')
  const [collectDate, setCollectDate] = useState('')
  const [csvPaths, setCsvPaths] = useState([])
  const [pendingBlades, setPendingBlades] = useState([])
  const [loadingPas, setLoadingPas] = useState(false)
  const [manualOverrides, setManualOverrides] = useState({}) // { [csvPath]: windbladeId }
  const [csvAnalysis, setCsvAnalysis] = useState({}) // { [csvPath]: { status, bladeRaw, turbineRaw, candidateBlades, matched } }
  const [turbineSearch, setTurbineSearch] = useState({}) // { [csvPath]: searchFilterText }
  const [showModal, setShowModal] = useState(false)
  const [selectedTurbineModal, setSelectedTurbineModal] = useState('')

  const [loadingWo, setLoadingWo] = useState(false)
  const [running, setRunning] = useState(false)
  const [fileProgress, setFileProgress] = useState(0)
  const [batchProgress, setBatchProgress] = useState(null)
  const [logs, setLogs] = useState([])
  const [result, setResult] = useState(null)

  const addLog = useCallback((text, type = 'info') => {
    setLogs(prev => [...prev, { text, type }])
  }, [])

  useEffect(() => {
    if (typeof window.pywebview === 'undefined') return
    const onLog = e => addLog(e.detail.text, e.detail.type)
    const onProgress = e =>
      setFileProgress(Math.round((e.detail.current / e.detail.total) * 100))
    const onBatchProgress = e => {
      setBatchProgress(e.detail)
      setFileProgress(0)
    }
    window.addEventListener('arthlog', onLog)
    window.addEventListener('arthprogress', onProgress)
    window.addEventListener('arthnex_batch_progress', onBatchProgress)
    return () => {
      window.removeEventListener('arthlog', onLog)
      window.removeEventListener('arthprogress', onProgress)
      window.removeEventListener('arthnex_batch_progress', onBatchProgress)
    }
  }, [addLog])

  useEffect(() => {
    if (
      !csvPaths.length ||
      !pendingBlades.length ||
      typeof window.pywebview === 'undefined' ||
      typeof window.pywebview.api?.arthnex_analisar_csvs !== 'function'
    ) {
      setCsvAnalysis({})
      return
    }
    let isMounted = true
    window.pywebview.api
      .arthnex_analisar_csvs(csvPaths, pendingBlades)
      .then(res => {
        if (isMounted && res) {
          setCsvAnalysis(res)
        }
      })
      .catch(err => {
        console.error('Erro ao analisar ambiguidades de CSVs:', err)
      })
    return () => {
      isMounted = false
    }
  }, [csvPaths, pendingBlades])

  const carregarWorkorders = useCallback(async () => {
    if (
      typeof window.pywebview === 'undefined' &&
      typeof window.api === 'undefined'
    )
      return
    const invoker = window.pywebview?.api || window.api
    setLoadingWo(true)
    setWorkorders([])
    setWorkorderId('')
    setWorkorderQuery('')
    setPendingBlades([])
    setManualOverrides({})
    setCsvAnalysis({})
    try {
      const res = await invoker.arthnex_listar_workorders(useHomolog)
      const list = res.data || res.workorders || (Array.isArray(res) ? res : [])
      if (res.success || Array.isArray(list)) {
        const sorted = [...list].sort((a, b) =>
          (a.description || '').localeCompare(b.description || '')
        )
        setWorkorders(sorted)
      } else addLog(`Erro ao carregar workorders: ${res.error}`, 'error')
    } finally {
      setLoadingWo(false)
    }
  }, [useHomolog, addLog])

  useEffect(() => {
    carregarWorkorders()
    const onAuthChanged = () => carregarWorkorders()
    window.addEventListener('arthnex_auth_changed', onAuthChanged)
    return () =>
      window.removeEventListener('arthnex_auth_changed', onAuthChanged)
  }, [carregarWorkorders])

  const carregarPas = useCallback(
    async woId => {
      if (
        !woId ||
        (typeof window.pywebview === 'undefined' &&
          typeof window.api === 'undefined')
      ) {
        setPendingBlades([])
        return
      }
      setLoadingPas(true)
      const invoker = window.pywebview?.api || window.api
      try {
        if (invoker?.uploader_get_hierarchy) {
          const hierRes = await invoker.uploader_get_hierarchy(woId, useHomolog)
          if (
            hierRes &&
            hierRes.success &&
            Array.isArray(hierRes.data) &&
            hierRes.data.length > 0
          ) {
            const flatList = []
            for (const pkg of hierRes.data) {
              for (const b of pkg.windblades || []) {
                flatList.push({
                  id: b.wo_package_id || b.windblade_id,
                  blade: b.blade,
                  blade_letter: b.blade_letter,
                  turbine: pkg.turbine,
                  turbine_id: pkg.turbine_id,
                  blade_model: b.blade_model,
                  blade_size: b.blade_size,
                  has_gallery: b.has_gallery,
                  is_360: b.is_360,
                })
              }
            }
            if (flatList.length > 0) {
              setPendingBlades(flatList)
              setLoadingPas(false)
              return
            }
          }
        }

        const res = await invoker.arthnex_listar_pas(woId, useHomolog)
        if (res.success) {
          setPendingBlades(res.data || [])
        } else {
          setPendingBlades([])
        }
      } catch (e) {
        setPendingBlades([])
      } finally {
        setLoadingPas(false)
      }
    },
    [useHomolog]
  )

  const onChangeWorkorder = useCallback(
    id => {
      setWorkorderId(id)
      const wo = workorders.find(w => String(w.id) === String(id))
      setPSurface(wo?.p_surface || '')
      setManualOverrides({})
      setCsvAnalysis({})
      carregarPas(id)
    },
    [workorders, carregarPas]
  )

  const onTypeWorkorder = useCallback(
    text => {
      setWorkorderQuery(text)
      const match = workorders.find(w => w.description === text)
      if (match) onChangeWorkorder(match.id)
      else if (!text) onChangeWorkorder('')
    },
    [workorders, onChangeWorkorder]
  )

  const pickCsvs = async () => {
    if (
      typeof window.pywebview === 'undefined' ||
      !window.pywebview.api?.pick_files
    )
      return
    const res = await window.pywebview.api.pick_files('csv')
    const pathsList = Array.isArray(res)
      ? res
      : typeof res === 'string'
        ? [res]
        : []
    if (pathsList.length > 0) {
      const validPaths = pathsList.filter(
        p => typeof p === 'string' && p.trim().length > 0
      )
      setCsvPaths(prev => [...new Set([...prev, ...validPaths])])
    }
  }

  const pickFolder = async () => {
    if (
      typeof window.pywebview === 'undefined' ||
      !window.pywebview.api?.pick_folder
    )
      return
    const folder = await window.pywebview.api.pick_folder()
    if (!folder || typeof folder !== 'string') return
    setLogs(prev => [
      ...prev,
      { text: `Procurando CSVs de upload em: ${folder}...`, type: 'info' },
    ])
    const found = await window.pywebview.api.arthnex_descobrir_csvs(folder)
    const foundList = Array.isArray(found) ? found : []
    if (foundList.length === 0) {
      addLog(`Nenhum CSV de upload encontrado em ${folder}.`, 'warning')
      return
    }
    setCsvPaths(prev => [...new Set([...prev, ...foundList])])
    addLog(
      `${foundList.length} CSV(s) de upload encontrado(s) e adicionado(s).`,
      'success'
    )
  }

  const removeCsv = path => {
    setCsvPaths(prev => prev.filter(p => p !== path))
    setManualOverrides(prev => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    setTurbineSearch(prev => {
      const next = { ...prev }
      delete next[path]
      return next
    })
  }

  const setOverrideForCsv = (path, windbladeId) => {
    setManualOverrides(prev => {
      if (!windbladeId) {
        const next = { ...prev }
        delete next[path]
        return next
      }
      return { ...prev, [path]: String(windbladeId) }
    })
  }

  const bladesPorTurbina = useMemo(() => {
    const groups = {}
    for (const b of pendingBlades) {
      const tName = b.turbine || 'Sem Turbina'
      if (!groups[tName]) groups[tName] = []
      groups[tName].push(b)
    }
    return groups
  }, [pendingBlades])

  const turbineList = useMemo(
    () => Object.keys(bladesPorTurbina).sort(),
    [bladesPorTurbina]
  )

  useEffect(() => {
    if (
      turbineList.length > 0 &&
      (!selectedTurbineModal || !bladesPorTurbina[selectedTurbineModal])
    ) {
      setSelectedTurbineModal(turbineList[0])
    }
  }, [turbineList, selectedTurbineModal, bladesPorTurbina])

  const canRun = workorderId && collectDate && csvPaths.length > 0 && !running

  const onUpload = async () => {
    setRunning(true)
    setFileProgress(0)
    setBatchProgress(null)
    setLogs([])
    setResult(null)
    const res = await window.pywebview.api.arthnex_upload_multi(
      csvPaths,
      workorderId,
      pSurface,
      collectDate,
      useHomolog,
      manualOverrides
    )
    setRunning(false)
    setResult(res)
    if (
      res &&
      res.success &&
      (!res.arquivosComFalha || res.arquivosComFalha === 0)
    ) {
      setCsvPaths([])
      setManualOverrides({})
      setCsvAnalysis({})
    }
  }

  const fieldStyle = {
    width: '100%',
    padding: '8px 11px',
    borderRadius: '6px',
    border: `1px solid ${D.border}`,
    background: D.inputBg,
    color: D.textPrimary,
    fontSize: '13px',
  }
  const labelStyle = {
    fontSize: '12px',
    fontWeight: 600,
    color: D.textSecond,
    marginBottom: '5px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
        padding: '18px',
        maxWidth: '750px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <label
          style={{
            fontSize: '12.5px',
            color: D.textSecond,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={useHomolog}
            onChange={e => setUseHomolog(e.target.checked)}
            disabled={running}
          />
          Usar ambiente de homologação (scheduler-homolog)
        </label>
      </div>

      <div>
        <label style={labelStyle}>
          Workorder{' '}
          {workorderId && !loadingWo ? Icons.checkCircle(D.success) : null}{' '}
          {loadingPas ? '(carregando pás...)' : ''}
        </label>
        <input
          style={fieldStyle}
          list="arthnex-wo-options"
          value={workorderQuery}
          disabled={loadingWo || running}
          placeholder={
            loadingWo
              ? 'Carregando workorders...'
              : 'Digite para buscar por nome ou número...'
          }
          onChange={e => onTypeWorkorder(e.target.value)}
        />
        <datalist id="arthnex-wo-options">
          {workorders.map(wo => (
            <option key={wo.id} value={wo.description} />
          ))}
        </datalist>
      </div>

      <div>
        <label style={labelStyle}>
          Data de coleta (aplicada a todos os CSVs do lote)
        </label>
        <input
          type="date"
          style={{ ...fieldStyle, maxWidth: '240px' }}
          value={collectDate}
          disabled={running}
          onChange={e => setCollectDate(e.target.value)}
        />
      </div>

      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '6px',
          }}
        >
          <label style={{ ...labelStyle, marginBottom: 0 }}>
            CSVs de upload — um por pá. O pareamento por turbina e pá é
            automático, mas você pode buscar turbinas ou resolver ambiguidades
            abaixo.
          </label>
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
          <button
            onClick={pickCsvs}
            disabled={running || !workorderId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 14px',
              borderRadius: '6px',
              border: `1px solid ${D.border}`,
              background: D.bgCard,
              color: D.textPrimary,
              cursor: running || !workorderId ? 'not-allowed' : 'pointer',
              fontSize: '12.5px',
              fontWeight: 500,
            }}
          >
            {Icons.fileText(D.accent)} Selecionar CSV(s)
          </button>
          <button
            onClick={pickFolder}
            disabled={running || !workorderId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 14px',
              borderRadius: '6px',
              border: `1px solid ${D.border}`,
              background: D.bgCard,
              color: D.textPrimary,
              cursor: running || !workorderId ? 'not-allowed' : 'pointer',
              fontSize: '12.5px',
              fontWeight: 500,
            }}
          >
            {Icons.folderOpen(D.accent)} Procurar em pasta
          </button>
          {pendingBlades.length > 0 && (
            <button
              onClick={() => setShowModal(true)}
              disabled={running}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '8px 14px',
                borderRadius: '6px',
                border: `1px solid ${D.accent}`,
                background: D.accent,
                color: '#fff',
                cursor: running ? 'not-allowed' : 'pointer',
                fontSize: '12.5px',
                fontWeight: 600,
              }}
            >
              {Icons.target('#fff')} Mapear por Turbina (3 Pás)
            </button>
          )}
        </div>

        {csvPaths.length > 0 && (
          <div
            style={{
              marginTop: '10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              border: `1px solid ${D.border}`,
              borderRadius: '6px',
              padding: '8px',
              maxHeight: '300px',
              overflowY: 'auto',
              background: D.bgCard,
            }}
          >
            {csvPaths.map(p => {
              const filename = p.split(/[/\\]/).pop()
              const selectedBladeId = manualOverrides[p] || ''
              const analysis = csvAnalysis[p]
              const searchVal = turbineSearch[p] || ''

              const filteredEntries = Object.entries(bladesPorTurbina).filter(
                ([turb]) => {
                  const s = searchVal.trim()
                  if (!s) return true
                  const normSearch = s
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, '')
                    .replace(/(^|[^0-9])0+(?=[0-9])/g, '$1')
                  const normTurb = turb
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, '')
                    .replace(/(^|[^0-9])0+(?=[0-9])/g, '$1')
                  return (
                    turb.toLowerCase().includes(s.toLowerCase()) ||
                    (normSearch && normTurb.includes(normSearch)) ||
                    (normTurb && normSearch.includes(normTurb))
                  )
                }
              )

              const matchedBlade = pendingBlades.find(
                b => String(b.id) === String(selectedBladeId)
              )

              return (
                <div
                  key={p}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    padding: '8px 10px',
                    background: D.inputBg,
                    borderRadius: '6px',
                    border: `1px solid ${selectedBladeId ? D.accent : D.border}`,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: '12px',
                      color: D.textSecond,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: '280px',
                      }}
                      title={p}
                    >
                      {Icons.fileText(D.accent)}
                      <strong style={{ color: D.textPrimary }}>
                        {filename}
                      </strong>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                    >
                      <input
                        type="text"
                        placeholder="🔍 Turbina..."
                        value={searchVal}
                        onChange={e =>
                          setTurbineSearch(prev => ({
                            ...prev,
                            [p]: e.target.value,
                          }))
                        }
                        disabled={running}
                        style={{
                          padding: '4px 7px',
                          fontSize: '11px',
                          borderRadius: '4px',
                          border: `1px solid ${D.border}`,
                          background: D.bgCard,
                          color: D.textPrimary,
                          width: '110px',
                        }}
                      />

                      <select
                        value={selectedBladeId}
                        onChange={e => setOverrideForCsv(p, e.target.value)}
                        disabled={running}
                        style={{
                          padding: '4px 8px',
                          fontSize: '11.5px',
                          borderRadius: '5px',
                          border: `1px solid ${selectedBladeId ? D.accent : D.border}`,
                          background: selectedBladeId
                            ? `${D.accent}18`
                            : D.bgCard,
                          color: selectedBladeId ? D.accent : D.textPrimary,
                          cursor: 'pointer',
                          maxWidth: '220px',
                        }}
                      >
                        <option value="">Auto-Match (Turbina + Pá)</option>
                        {filteredEntries.map(([turb, bList]) => (
                          <optgroup key={turb} label={`Turbina: ${turb}`}>
                            {bList.map(b => (
                              <option key={b.id} value={String(b.id)}>
                                {b.blade} ({b.turbine})
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>

                      <button
                        onClick={() => removeCsv(p)}
                        disabled={running}
                        style={{
                          border: 'none',
                          background: 'none',
                          color: D.error,
                          cursor: running ? 'not-allowed' : 'pointer',
                          padding: '2px 4px',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        {Icons.close(D.error)}
                      </button>
                    </div>
                  </div>

                  {/* Badge de Seleção Manual Confirmada */}
                  {selectedBladeId && (
                    <div
                      style={{
                        fontSize: '11px',
                        color: D.success,
                        fontWeight: 500,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: `${D.success}10`,
                        padding: '3px 8px',
                        borderRadius: '4px',
                      }}
                    >
                      <span>
                        ✓ Vincular a:{' '}
                        <strong>
                          {matchedBlade
                            ? `Turbina ${matchedBlade.turbine} — Pá ${matchedBlade.blade}`
                            : `Pá ID ${selectedBladeId}`}
                        </strong>
                      </span>
                      <button
                        onClick={() => setOverrideForCsv(p, '')}
                        style={{
                          border: 'none',
                          background: 'none',
                          color: D.textMuted,
                          cursor: 'pointer',
                          fontSize: '10.5px',
                          textDecoration: 'underline',
                        }}
                      >
                        Restaurar Auto-Match
                      </button>
                    </div>
                  )}

                  {/* Badge de Auto-Match Confirmado */}
                  {!selectedBladeId &&
                    analysis?.status === 'matched' &&
                    analysis?.matched && (
                      <div
                        style={{
                          fontSize: '11px',
                          color: D.textSecond,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          background: `${D.accent}0d`,
                          padding: '3px 8px',
                          borderRadius: '4px',
                        }}
                      >
                        <span style={{ color: D.success }}>✓</span>
                        <span>
                          Auto-detectado:{' '}
                          <strong>
                            Turbina {analysis.matched.turbine} — Pá{' '}
                            {analysis.matched.blade}
                          </strong>
                        </span>
                      </div>
                    )}

                  {/* Badge de Ambiguidade com Botões Rápidos */}
                  {!selectedBladeId && analysis?.status === 'ambiguous' && (
                    <div
                      style={{
                        background: '#ff980018',
                        border: '1px solid #ff980066',
                        borderRadius: '5px',
                        padding: '6px 9px',
                        fontSize: '11.5px',
                        color: D.textPrimary,
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 600,
                          color: '#ff9800',
                          marginBottom: '4px',
                        }}
                      >
                        ⚠️ Ambiguidade: Pá '{analysis.bladeRaw}' encontrada em{' '}
                        {analysis.candidateBlades?.length} turbinas pendentes
                        nesta Workorder.
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontSize: '11px', color: D.textSecond }}>
                          Selecione a turbina:
                        </span>
                        {analysis.candidateBlades?.map(cand => (
                          <button
                            key={cand.id}
                            onClick={() => setOverrideForCsv(p, cand.id)}
                            disabled={running}
                            style={{
                              padding: '2px 8px',
                              borderRadius: '4px',
                              border: `1px solid ${D.accent}`,
                              background: `${D.accent}22`,
                              color: D.accent,
                              fontSize: '11px',
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            Turbina {cand.turbine} ({cand.blade})
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Badge de Falta de Match */}
                  {!selectedBladeId && analysis?.status === 'no_match' && (
                    <div
                      style={{
                        background: '#f4433614',
                        border: '1px solid #f4433644',
                        borderRadius: '5px',
                        padding: '5px 8px',
                        fontSize: '11px',
                        color: D.error,
                      }}
                    >
                      ⚠️ Nenhuma turbina auto-detectada para a pá '
                      {analysis.bladeRaw || 'não informada'}'. Digite a turbina
                      no campo ao lado para selecionar.
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <button
        onClick={onUpload}
        disabled={!canRun}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          padding: '12px',
          borderRadius: '6px',
          border: 'none',
          cursor: canRun ? 'pointer' : 'not-allowed',
          background: canRun ? D.accent : D.border,
          color: '#fff',
          fontSize: '13.5px',
          fontWeight: 600,
          opacity: canRun ? 1 : 0.6,
        }}
      >
        {Icons.upload('#fff')}
        {running
          ? batchProgress
            ? `Enviando arquivo ${batchProgress.fileIndex}/${batchProgress.fileTotal} (${batchProgress.fileName}) — ${fileProgress}%`
            : 'Iniciando upload...'
          : `Subir fotos${csvPaths.length > 1 ? ` (${csvPaths.length} arquivos)` : ''}`}
      </button>

      {running && (
        <div
          style={{
            height: '6px',
            borderRadius: '3px',
            background: D.bgCard,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${fileProgress}%`,
              background: D.accent,
              transition: 'width 0.2s',
            }}
          />
        </div>
      )}

      {result && (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: '6px',
            fontSize: '12.5px',
            background: result.success ? `${D.success}14` : `${D.error}14`,
            color: result.success ? D.success : D.error,
            border: `1px solid ${result.success ? D.success : D.error}33`,
          }}
        >
          {result.success ? (
            <>
              <div
                style={{
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                {Icons.checkCircle(D.success)} Lote concluído:{' '}
                {result.totalEnviados}/{result.totalFotos} fotos enviadas em{' '}
                {result.resultados.length} arquivo(s), {result.arquivosComFalha}{' '}
                com falha.
              </div>
              {result.resultados.map((r, i) => (
                <div
                  key={i}
                  style={{
                    marginTop: '5px',
                    color: r.success ? D.textSecond : D.error,
                    fontSize: '12px',
                  }}
                >
                  • {r.arquivo}:{' '}
                  {r.success
                    ? `${r.enviados}/${r.total} enviadas — Turbina: ${r.turbine || 'N/A'} | Pá: ${r.blade || 'N/A'}`
                    : `falhou — ${r.error}`}
                </div>
              ))}
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {Icons.error(D.error)} Erro: {result.error}
            </div>
          )}
        </div>
      )}

      {/* Modal de Mapeamento de Pás por Turbina (3 Pás) */}
      {showModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999,
            padding: '20px',
          }}
        >
          <div
            style={{
              background: D.bgCard,
              border: `1px solid ${D.border}`,
              borderRadius: '8px',
              width: '100%',
              maxWidth: '640px',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              color: D.textPrimary,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderBottom: `1px solid ${D.border}`,
                paddingBottom: '10px',
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                {Icons.target(D.accent)}
                <h3
                  style={{
                    margin: 0,
                    fontSize: '15px',
                    color: D.textPrimary,
                    fontWeight: 600,
                  }}
                >
                  Mapeamento de Pás por Turbina
                </h3>
              </div>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  border: 'none',
                  background: 'none',
                  color: D.textSecond,
                  cursor: 'pointer',
                  padding: '4px',
                }}
              >
                {Icons.close(D.textSecond)}
              </button>
            </div>

            <div>
              <label style={labelStyle}>Selecione a Turbina:</label>
              <select
                value={selectedTurbineModal}
                onChange={e => setSelectedTurbineModal(e.target.value)}
                style={{ ...fieldStyle, fontSize: '13px', fontWeight: 600 }}
              >
                {turbineList.map(t => (
                  <option key={t} value={t}>
                    Turbina: {t} ({bladesPorTurbina[t]?.length || 0} pás
                    pendentes)
                  </option>
                ))}
              </select>
            </div>

            {selectedTurbineModal && bladesPorTurbina[selectedTurbineModal] && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  background: D.inputBg,
                  padding: '12px',
                  borderRadius: '6px',
                  border: `1px solid ${D.border}`,
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    color: D.textSecond,
                    fontWeight: 600,
                  }}
                >
                  Pás pendentes da Turbina {selectedTurbineModal}:
                </div>

                {bladesPorTurbina[selectedTurbineModal].map(bladeItem => {
                  const assignedCsv =
                    csvPaths.find(
                      p => String(manualOverrides[p]) === String(bladeItem.id)
                    ) || ''

                  return (
                    <div
                      key={bladeItem.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 10px',
                        background: D.bgCard,
                        borderRadius: '5px',
                        border: `1px solid ${D.border}`,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                      >
                        {Icons.leaf(D.accent)}
                        <div>
                          <div
                            style={{
                              fontSize: '12.5px',
                              fontWeight: 600,
                              color: D.textPrimary,
                            }}
                          >
                            Pá: {bladeItem.blade}
                          </div>
                          <div style={{ fontSize: '11px', color: D.textMuted }}>
                            ID Arthnex: {bladeItem.id}
                          </div>
                        </div>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        <select
                          value={assignedCsv}
                          onChange={e => {
                            const newCsv = e.target.value
                            if (assignedCsv) setOverrideForCsv(assignedCsv, '')
                            if (newCsv) setOverrideForCsv(newCsv, bladeItem.id)
                          }}
                          style={{
                            padding: '5px 9px',
                            fontSize: '12px',
                            borderRadius: '5px',
                            border: `1px solid ${assignedCsv ? D.accent : D.border}`,
                            background: assignedCsv
                              ? `${D.accent}18`
                              : D.inputBg,
                            color: assignedCsv ? D.accent : D.textPrimary,
                            cursor: 'pointer',
                            maxWidth: '280px',
                          }}
                        >
                          <option value="">(Nenhum CSV vinculado)</option>
                          {csvPaths.map(p => (
                            <option key={p} value={p}>
                              {p.split(/[/\\]/).pop()}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
                marginTop: '10px',
              }}
            >
              <button
                onClick={() => setShowModal(false)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  background: D.accent,
                  color: '#fff',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Concluído
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
