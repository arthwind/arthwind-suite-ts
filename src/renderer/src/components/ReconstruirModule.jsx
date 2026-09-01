import { useEffect, useRef, useState } from 'react'

const SIDES = ['LE', 'SS', 'TE', 'PS']
const emptyTab = () => ({
  folderPath: '',
  fotos: [],
  bladeSn: '',
  fotosLoading: false,
  sides: SIDES.map(s => ({
    side: s,
    start: '',
    end: '',
    pixel_mm_avg: '0.45',
  })),
})

export default function ReconstruirModule({ D, isPyWebView, onOpenFolder }) {
  const [activeTab, setActiveTab] = useState('A')
  const [tabs, setTabs] = useState({
    A: emptyTab(),
    B: emptyTab(),
    C: emptyTab(),
  })
  const [genUploader, setGenUploader] = useState(false)
  const [workorder, setWorkorder] = useState('')
  const [turbine, setTurbine] = useState('')
  const [jsonRefPath, setJsonRefPath] = useState('')
  const [running, setRunning] = useState(false)
  const [ran, setRan] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [logs, setLogs] = useState([])
  const [outputDirs, setOutputDirs] = useState([])
  const logRef = useRef(null)

  useEffect(() => {
    const onLog = e => {
      const { text, type } = e.detail
      setLogs(prev => [...prev, { text, type }])
    }
    window.addEventListener('arthdolog', onLog)
    return () => window.removeEventListener('arthdolog', onLog)
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  const updateTab = (key, field, value) =>
    setTabs(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }))

  const pickFolder = async key => {
    if (!isPyWebView) return
    const path = await window.pywebview.api.pick_folder()
    if (path) {
      setTabs(prev => ({
        ...prev,
        [key]: { ...prev[key], folderPath: path, fotos: [] },
      }))
    }
  }

  const pickRootFolder = async () => {
    if (!isPyWebView) return
    const root = await window.pywebview.api.pick_folder()
    if (!root) return
    const res = await window.pywebview.api.detectar_estrutura_abc(root)
    if (!res.detected) {
      alert('Nenhuma estrutura A/B/C detectada na pasta selecionada.')
      return
    }
    const labels = Object.keys(res.folders).sort().join(', ')
    const names = Object.entries(res.folders)
      .map(([k, v]) => `${k}: ${v.split(/[\\/]/).pop()}`)
      .join('\n')
    const ok = window.confirm(
      `Estrutura detectada:\n${names}\n\nDeseja usar este formato?`
    )
    if (!ok) return
    setTabs(prev => {
      const next = { ...prev }
      for (const [label, path] of Object.entries(res.folders)) {
        next[label] = { ...prev[label], folderPath: path, fotos: [] }
      }
      return next
    })
    // Auto-carrega fotos para cada pá detectada
    for (const [label, path] of Object.entries(res.folders)) {
      updateTab(label, 'fotosLoading', true)
      window.pywebview.api.carregar_fotos_reconstruir_sync(path).then(r => {
        if (r.success) updateTab(label, 'fotos', r.fotos)
        updateTab(label, 'fotosLoading', false)
      })
    }
  }

  const loadPhotos = async key => {
    if (!isPyWebView) return
    updateTab(key, 'fotosLoading', true)
    try {
      const res = await window.pywebview.api.carregar_fotos_reconstruir_sync(
        tabs[key].folderPath
      )
      if (res.success) updateTab(key, 'fotos', res.fotos)
      else alert('Erro ao carregar fotos: ' + res.error)
    } finally {
      updateTab(key, 'fotosLoading', false)
    }
  }

  const loadJsonRef = async () => {
    if (!isPyWebView) return
    const path = await window.pywebview.api.pick_file('json')
    if (!path) return
    const res = await window.pywebview.api.ler_json_referencia_pixel_mm(path)
    if (!res.success) {
      alert('Erro: ' + res.error)
      return
    }
    setJsonRefPath(path)
    const avgs = res.averages
    setTabs(prev => {
      const next = {}
      for (const k of ['A', 'B', 'C']) {
        const tab = prev[k]
        next[k] = {
          ...tab,
          sides: tab.sides.map(s => ({
            ...s,
            pixel_mm_avg:
              avgs[s.side] != null
                ? String(avgs[s.side].toFixed(5))
                : s.pixel_mm_avg,
          })),
        }
      }
      return next
    })
  }

  const updateSide = (key, idx, field, val) =>
    setTabs(prev => {
      const tab = prev[key]
      const next = [...tab.sides]
      next[idx] = { ...next[idx], [field]: val }
      return { ...prev, [key]: { ...tab, sides: next } }
    })

  const addSide = key =>
    setTabs(prev => ({
      ...prev,
      [key]: { ...prev[key], sides: [...prev[key].sides, emptySide()] },
    }))

  const removeSide = (key, idx) =>
    setTabs(prev => {
      const tab = prev[key]
      if (tab.sides.length <= 1) return prev
      return {
        ...prev,
        [key]: { ...tab, sides: tab.sides.filter((_, i) => i !== idx) },
      }
    })

  const handleRun = async () => {
    if (!isPyWebView || running) return
    const tabsConfig = ['A', 'B', 'C']
      .map(k => ({ blade_label: k, ...tabs[k] }))
      .filter(
        t =>
          t.folderPath &&
          t.bladeSn &&
          t.fotos.length > 0 &&
          t.sides.some(s => s.start && s.end)
      )
      .map(({ blade_label, folderPath, bladeSn, sides }) => ({
        blade_label,
        pasta: folderPath,
        blade_sn: bladeSn,
        sides: sides.map(s => ({
          ...s,
          pixel_mm_avg: parseFloat(s.pixel_mm_avg) || 0.45,
        })),
      }))

    if (tabsConfig.length === 0) {
      alert(
        'Configure ao menos uma pá: pasta carregada + Blade SN + ao menos um lado com início e fim.'
      )
      return
    }

    setRunning(true)
    setRan(false)
    setHasError(false)
    setLogs([])
    setOutputDirs([])

    try {
      const res = await window.pywebview.api.reconstruir_csv_multi(
        tabsConfig,
        workorder,
        turbine,
        genUploader,
        jsonRefPath
      )
      setHasError(!res.success)
      if (res.success) setOutputDirs(res.output_dirs || [])
    } catch (e) {
      setHasError(true)
    } finally {
      setRunning(false)
      setRan(true)
    }
  }

  const inp = {
    background: D.inputBg,
    border: `1px solid ${D.border}`,
    color: D.textPrimary,
    padding: '5px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    outline: 'none',
    fontFamily: 'inherit',
  }

  const tabReady = k => {
    const t = tabs[k]
    return !!(
      t.folderPath &&
      t.bladeSn &&
      t.fotos.length > 0 &&
      t.sides.some(s => s.start && s.end)
    )
  }

  const canRun = !running && ['A', 'B', 'C'].some(tabReady)

  const logColor = type =>
    ({ success: D.success, warning: D.warning, error: D.error, info: D.info })[
      type
    ] || D.info

  const tab = tabs[activeTab]

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '16px 20px',
        height: '100%',
      }}
    >
      {/* Opções de saída + JSON global */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '20px',
          flexWrap: 'wrap',
          padding: '10px 14px',
          background: D.bgCard,
          border: `1px solid ${D.borderLight}`,
          borderRadius: '6px',
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={genUploader}
            onChange={e => setGenUploader(e.target.checked)}
            style={{ accentColor: D.accent, width: '14px', height: '14px' }}
          />
          <span
            style={{
              fontSize: '12.5px',
              color: D.textPrimary,
              fontWeight: 600,
            }}
          >
            Gerar também CSV para Image Uploader
          </span>
        </label>
        {genUploader && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '11px', color: D.textMuted }}>
                Work Order
              </span>
              <input
                type="text"
                value={workorder}
                onChange={e => setWorkorder(e.target.value)}
                placeholder="Ex: WO-2025-001"
                style={{ ...inp, width: '160px' }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '11px', color: D.textMuted }}>
                Turbina
              </span>
              <input
                type="text"
                value={turbine}
                onChange={e => setTurbine(e.target.value)}
                placeholder="Ex: WTG-01"
                style={{ ...inp, width: '130px' }}
              />
            </div>
          </>
        )}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
          }}
        >
          <button
            onClick={pickRootFolder}
            title="Detecta subpastas A/B/C automaticamente e pré-carrega as três abas"
            style={{
              padding: '5px 12px',
              background: D.accentSofter,
              border: `1px solid ${D.border}`,
              color: D.accent,
              borderRadius: '4px',
              fontSize: '11px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            📂 Selecionar pasta raiz (A/B/C)
          </button>
          <button
            onClick={loadJsonRef}
            title="Carrega médias de pixel_mm de um photo_data.json e aplica nas 3 pás. Ao reconstruir, gera JSON matched unificado na pasta pai."
            style={{
              padding: '5px 12px',
              background: jsonRefPath ? `${D.success}18` : D.accentSofter,
              border: `1px solid ${jsonRefPath ? D.success : D.border}`,
              color: jsonRefPath ? D.success : D.accent,
              borderRadius: '4px',
              fontSize: '11px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {jsonRefPath
              ? `✓ ${jsonRefPath.split(/[\\/]/).pop()}`
              : '📥 JSON de referência'}
          </button>
        </div>
      </div>

      {/* Conteúdo principal: abas + log */}
      <div style={{ display: 'flex', gap: '16px', flex: 1, minHeight: 0 }}>
        {/* Esquerda: configuração por aba */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: '0',
            minWidth: 0,
          }}
        >
          {/* Tab bar */}
          <div style={{ display: 'flex', gap: '4px' }}>
            {['A', 'B', 'C'].map(k => {
              const ready = tabReady(k)
              const active = activeTab === k
              return (
                <button
                  key={k}
                  onClick={() => setActiveTab(k)}
                  style={{
                    padding: '6px 22px',
                    borderRadius: '5px 5px 0 0',
                    fontSize: '12.5px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: `1px solid ${active ? D.accent : D.borderLight}`,
                    borderBottom: active ? `1px solid ${D.bgCard}` : undefined,
                    background: active ? D.bgCard : D.bgDeep,
                    color: active ? D.accent : ready ? D.success : D.textMuted,
                    transition: 'all 0.15s',
                  }}
                >
                  Pá {k}
                  {ready ? ' ✓' : ''}
                </button>
              )
            })}
          </div>

          {/* Painel da aba */}
          <div
            style={{
              flex: 1,
              background: D.bgCard,
              border: `1px solid ${D.borderLight}`,
              borderRadius: '0 6px 6px 6px',
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              overflow: 'auto',
            }}
          >
            {/* Pasta */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontSize: '11px',
                  color: D.textMuted,
                  minWidth: '38px',
                }}
              >
                Pasta
              </span>
              <div
                style={{
                  ...inp,
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: tab.folderPath ? D.textPrimary : D.textMuted,
                  cursor: 'default',
                }}
              >
                {tab.folderPath || 'Nenhuma pasta selecionada'}
              </div>
              <button
                onClick={() => pickFolder(activeTab)}
                style={{
                  padding: '5px 12px',
                  background: D.accentSoft,
                  border: `1px solid ${D.accent}`,
                  color: D.accent,
                  borderRadius: '4px',
                  fontSize: '11px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                Selecionar
              </button>
              <button
                onClick={() => loadPhotos(activeTab)}
                disabled={!tab.folderPath || tab.fotosLoading}
                style={{
                  padding: '5px 12px',
                  background: D.accentSoft,
                  border: `1px solid ${D.accent}`,
                  color: D.accent,
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  cursor:
                    tab.folderPath && !tab.fotosLoading ? 'pointer' : 'default',
                  opacity: !tab.folderPath ? 0.5 : 1,
                }}
              >
                {tab.fotosLoading
                  ? 'Lendo...'
                  : tab.fotos.length > 0
                    ? `${tab.fotos.length} fotos ✓`
                    : 'Carregar Fotos'}
              </button>
            </div>

            {/* Blade SN */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontSize: '11px',
                  color: D.textMuted,
                  minWidth: '55px',
                }}
              >
                Blade SN
              </span>
              <input
                type="text"
                value={tab.bladeSn}
                onChange={e => updateTab(activeTab, 'bladeSn', e.target.value)}
                placeholder="Ex: SN-123456"
                style={{ ...inp, width: '210px' }}
              />
            </div>

            {/* Tabela de lados */}
            {tab.fotos.length > 0 ? (
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '68px 1fr 1fr 100px 26px',
                    gap: '6px',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ color: D.textMuted, fontSize: '11px' }}>
                    Lado
                  </span>
                  <span style={{ color: D.textMuted, fontSize: '11px' }}>
                    Foto início
                  </span>
                  <span style={{ color: D.textMuted, fontSize: '11px' }}>
                    Foto fim
                  </span>
                  <span style={{ color: D.textMuted, fontSize: '11px' }}>
                    Pixel MM médio
                  </span>
                  <span />
                </div>

                {tab.sides.map((s, idx) => (
                  <div key={idx}>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '68px 1fr 1fr 100px 26px',
                        gap: '6px',
                        alignItems: 'center',
                      }}
                    >
                      <select
                        value={s.side}
                        onChange={e =>
                          updateSide(activeTab, idx, 'side', e.target.value)
                        }
                        style={{ ...inp, cursor: 'pointer' }}
                      >
                        {SIDES.map(n => (
                          <option key={n}>{n}</option>
                        ))}
                      </select>
                      <select
                        value={s.start}
                        onChange={e =>
                          updateSide(activeTab, idx, 'start', e.target.value)
                        }
                        style={{ ...inp, width: '100%' }}
                      >
                        <option value="">— início —</option>
                        {tab.fotos.map(f => (
                          <option key={f.nome} value={f.nome}>
                            {f.nome} ({f.z_relativo_mm} mm)
                          </option>
                        ))}
                      </select>
                      <select
                        value={s.end}
                        onChange={e =>
                          updateSide(activeTab, idx, 'end', e.target.value)
                        }
                        style={{ ...inp, width: '100%' }}
                      >
                        <option value="">— fim —</option>
                        {tab.fotos.map(f => (
                          <option key={f.nome} value={f.nome}>
                            {f.nome} ({f.z_relativo_mm} mm)
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        step="0.001"
                        min="0.1"
                        max="1.0"
                        value={s.pixel_mm_avg}
                        onChange={e =>
                          updateSide(
                            activeTab,
                            idx,
                            'pixel_mm_avg',
                            e.target.value
                          )
                        }
                        style={{ ...inp, width: '100%' }}
                      />
                      <button
                        onClick={() => removeSide(activeTab, idx)}
                        disabled={tab.sides.length <= 1}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: tab.sides.length <= 1 ? D.textMuted : D.error,
                          cursor: tab.sides.length <= 1 ? 'default' : 'pointer',
                          fontSize: '14px',
                          padding: 0,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    {['SS', 'PS'].includes(s.side) && (
                      <span
                        style={{
                          fontSize: '10.5px',
                          color: D.warning,
                          marginLeft: '74px',
                          display: 'block',
                          marginTop: '-2px',
                        }}
                      >
                        ↩ Ordem invertida automaticamente (tip→root)
                      </span>
                    )}
                  </div>
                ))}

                <button
                  onClick={() => addSide(activeTab)}
                  style={{
                    alignSelf: 'flex-start',
                    background: D.accentSofter,
                    border: `1px solid ${D.border}`,
                    color: D.accent,
                    borderRadius: '4px',
                    padding: '4px 10px',
                    fontSize: '11.5px',
                    cursor: 'pointer',
                    marginTop: '2px',
                  }}
                >
                  + Adicionar lado
                </button>
              </div>
            ) : (
              <div
                style={{
                  color: D.textMuted,
                  fontSize: '12px',
                  textAlign: 'center',
                  padding: '24px 0',
                }}
              >
                Selecione uma pasta e clique em "Carregar Fotos" para começar.
              </div>
            )}
          </div>

          {/* Botão executar */}
          <button
            onClick={handleRun}
            disabled={!canRun}
            style={{
              marginTop: '12px',
              padding: '10px',
              borderRadius: '6px',
              fontSize: '13.5px',
              fontWeight: 700,
              border: 'none',
              background: canRun ? D.accent : D.accentSofter,
              color: '#fff',
              cursor: canRun ? 'pointer' : 'default',
              opacity: canRun ? 1 : 0.6,
            }}
          >
            {running ? 'Reconstruindo...' : 'Reconstruir CSV'}
          </button>

          {/* Banner de resultado */}
          {ran && !running && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: '6px',
                background: hasError ? `${D.error}18` : `${D.success}14`,
                border: `1px solid ${hasError ? D.error : D.success}`,
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                marginTop: '4px',
              }}
            >
              <span style={{ fontSize: '18px' }}>{hasError ? '⚠' : '✓'}</span>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontSize: '12.5px',
                    fontWeight: 700,
                    color: hasError ? D.error : D.success,
                  }}
                >
                  {hasError
                    ? 'Erro na reconstrução — verifique o log.'
                    : `${outputDirs.length} pá(s) reconstruída(s) com sucesso.`}
                </div>
                {!hasError && outputDirs.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      gap: '6px',
                      marginTop: '6px',
                      flexWrap: 'wrap',
                    }}
                  >
                    {outputDirs.map((dir, i) => (
                      <button
                        key={i}
                        onClick={() => onOpenFolder(dir)}
                        style={{
                          padding: '3px 10px',
                          background: D.accentSofter,
                          border: `1px solid ${D.border}`,
                          color: D.accent,
                          borderRadius: '4px',
                          fontSize: '11px',
                          cursor: 'pointer',
                        }}
                      >
                        📁 {dir.split(/[\\/]/).pop()}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Direita: log */}
        <div
          style={{
            width: '300px',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              color: D.textMuted,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Log
          </span>
          <div
            ref={logRef}
            style={{
              flex: 1,
              overflow: 'auto',
              background: D.logBg,
              border: `1px solid ${D.borderLight}`,
              borderLeft: `1px solid ${D.border}`,
              borderRadius: '6px',
              padding: '10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
              minHeight: '200px',
            }}
          >
            {logs.length === 0 ? (
              <span style={{ color: D.textMuted, fontSize: '11.5px' }}>
                A saída aparecerá aqui...
              </span>
            ) : (
              logs.map((l, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: '11.5px',
                    color: logColor(l.type),
                    lineHeight: 1.45,
                  }}
                >
                  {l.text}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
