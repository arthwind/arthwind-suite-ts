import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Icons } from '../constants/icons.jsx'

/**
 * Módulo 16 — Horizon Processor
 * Secções: Ficheiros → Nomenclatura → Requisitos → Pacote
 */

const basename = p => (p ? p.split(/[\\/]/).pop() : '')
const normalizar = s => s.toLowerCase().replace(/[-_\s]/g, '')

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
  const [files, setFiles] = useState({
    horizons: [],
    summaries: [],
    details: '',
    damages: [],
  })
  const [loading, setLoading] = useState('')
  const [step, setStep] = useState(0)

  // Nomenclatura
  const [validation, setValidation] = useState(null)
  const [removals, setRemovals] = useState({
    turbinas_removidas: [],
    turbinas_horizon_removidas: [],
  })
  const [vinculos, setVinculos] = useState({})
  const [autoAccepted, setAutoAccepted] = useState({})
  const [autoRejected, setAutoRejected] = useState(new Set())

  // Requisitos (auto)
  const [requirements, setRequirements] = useState(null)
  const [reqsLoading, setReqsLoading] = useState(false)
  const reqsTimerRef = useRef(null)

  // Pacote
  const [pkg, setPkg] = useState(null)

  // ── Normalização (espelha _normalizar do Python — só separadores) ──
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

  // ── File pickers (multi e single) ─────────────────────────────────────────
  const pickMulti = useCallback(
    async key => {
      if (!isPyWebView) return
      const paths = await window.pywebview.api.pick_files('csv')
      if (paths?.length) setFiles(f => ({ ...f, [key]: [...f[key], ...paths] }))
    },
    [isPyWebView]
  )

  const pickSingle = useCallback(
    async key => {
      if (!isPyWebView) return
      const path = await window.pywebview.api.pick_file('csv')
      if (path) setFiles(f => ({ ...f, [key]: path }))
    },
    [isPyWebView]
  )

  const removeFromArray = (key, idx) =>
    setFiles(f => ({ ...f, [key]: f[key].filter((_, i) => i !== idx) }))

  const [standaloneSiteName, setStandaloneSiteName] = useState('')

  const handleFixDamagesStandalone = async () => {
    if (!isPyWebView) return
    const paths = await window.pywebview.api.pick_files('csv')
    if (!paths || paths.length === 0) return

    setLoading('fix_damages')
    try {
      const res = await window.pywebview.api.horizon_corrigir_damages_direto(
        paths,
        standaloneSiteName
      )
      if (res.success) {
        alert(
          `Sucesso! ${res.corrected_files.length} arquivo(s) de Damages corrigidos e salvos na mesma pasta.`
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

  // ── Analisar nomenclatura ──────────────────────────────────────────────────
  const handleAnalyze = async () => {
    setLoading('analyze')
    try {
      const result = isPyWebView
        ? await window.pywebview.api.horizon_analisar(
            files.horizons,
            files.summaries
          )
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

  // ── Auto-verificação de requisitos ─────────────────────────────────────────
  const doCheckReqs = useCallback(
    async (f, r, v, aa) => {
      if (!f.details) return
      setReqsLoading(true)
      try {
        const allV = { ...v, ...aa }
        const result = isPyWebView
          ? await window.pywebview.api.horizon_validar_requisitos(
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
    [isPyWebView]
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

  useEffect(() => {
    if (!files.details) return
    scheduleReqsCheck(files, removals, vinculos, autoAccepted)
  }, [removals, vinculos, autoAccepted]) // eslint-disable-line

  // ── Gerar pacote ───────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    setLoading('generate')
    try {
      const allV = { ...vinculos, ...autoAccepted }
      const result = isPyWebView
        ? await window.pywebview.api.horizon_gerar_pacote(
            files.horizons,
            files.summaries,
            files.details,
            files.damages,
            allV,
            removals.turbinas_removidas,
            removals.turbinas_horizon_removidas
          )
        : {
            success: true,
            zip_path: 'C:/Demo/HORIZON_OUTPUT/horizon_package.zip',
            output_dir: 'C:/Demo/HORIZON_OUTPUT',
            erros_pos: [],
          }
      setPkg(result)
    } finally {
      setLoading('')
    }
  }

  // ── Estilos ─────────────────────────────────────────────────────────────────
  const pill = active => ({
    display: 'inline-block',
    background: active ? D.accentSoft : 'none',
    border: `1px solid ${active ? D.accent : D.border}`,
    color: active ? D.accent : D.textSecond,
    borderRadius: '12px',
    padding: '2px 10px',
    fontSize: '11px',
    cursor: 'pointer',
    margin: '0 3px 4px 0',
  })
  const tag = color => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    background: `${color}18`,
    color,
    border: `1px solid ${color}44`,
    borderRadius: '4px',
    padding: '1px 7px',
    fontSize: '11px',
    margin: '2px',
  })
  const btn = (color, bg) => ({
    background: bg || 'none',
    border: `1px solid ${color}`,
    color,
    borderRadius: '4px',
    padding: '5px 14px',
    fontSize: '12px',
    cursor: 'pointer',
  })

  // ── Badges para cabeçalhos ─────────────────────────────────────────────────
  const nomBadge = !validation
    ? null
    : computedState?.isValid
      ? { text: '✅ OK', color: D.success }
      : computedState?.pendentesOk === false
        ? {
            text: `⚡ ${Object.keys(computedState.autoMatchesPendentes).length} auto-match(es)`,
            color: D.warning,
          }
        : {
            text: `⚠ ${computedState.extras.length + computedState.faltantes.length} por resolver`,
            color: D.warning,
          }

  const reqsBadge = reqsLoading
    ? { text: '🔄 verificando...', color: D.textMuted }
    : !requirements
      ? null
      : requirements.errors.length > 0
        ? { text: `❌ ${requirements.errors.length} erro(s)`, color: D.error }
        : requirements.warnings.length > 0
          ? {
              text: `⚠ ${requirements.warnings.length} aviso(s)`,
              color: D.warning,
            }
          : { text: '✅ OK', color: D.success }

  const canAnalyze = files.horizons.length > 0 && files.summaries.length > 0
  const canGenerate =
    computedState?.isValid &&
    requirements &&
    requirements.errors.length === 0 &&
    !loading

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* ── 1. FICHEIROS ── */}
      <Section
        num="1"
        title="Ficheiros de Entrada"
        D={D}
        badge={
          canAnalyze
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
              ...btn(D.accent, canAnalyze ? D.accentSoft : undefined),
              opacity: !canAnalyze || loading === 'analyze' ? 0.5 : 1,
            }}
            disabled={!canAnalyze || loading === 'analyze'}
            onClick={handleAnalyze}
          >
            {loading === 'analyze'
              ? '🔄 Analisando...'
              : '🔍 Analisar Nomenclatura'}
          </button>
          {!canAnalyze && (
            <span
              style={{
                fontSize: '11px',
                color: D.textMuted,
                marginLeft: '10px',
              }}
            >
              Selecione pelo menos 1 Base Horizon e 1 Summary ATW
            </span>
          )}
        </div>

        <div
          style={{
            marginTop: '14px',
            paddingTop: '10px',
            borderTop: `1px dashed ${D.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <span style={{ fontSize: '11.5px', color: D.textSecond }}>
            <strong>Correção Direta de Danos (Arthnex → Horizon):</strong>{' '}
            Corrige coordenadas e gera colunas obrigatórias para importação no
            Horizon.
          </span>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
              width: '100%',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '3px',
                flex: '1',
                minWidth: '200px',
              }}
            >
              <label
                style={{
                  fontSize: '10.5px',
                  color: D.textMuted,
                  fontWeight: 'bold',
                }}
              >
                Nome do Site na Horizon (Opcional - tenta detectar se vazio):
              </label>
              <input
                type="text"
                placeholder="Ex: Serra da Babilônia"
                value={standaloneSiteName}
                onChange={e => setStandaloneSiteName(e.target.value)}
                style={{
                  padding: '5px 8px',
                  borderRadius: '4px',
                  border: `1px solid ${D.border}`,
                  backgroundColor: D.bgCard || 'rgba(0,0,0,0.2)',
                  color: D.textPrimary || '#fff',
                  fontSize: '12px',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <button
              style={{
                ...btn(D.warning, `${D.warning}11`),
                fontSize: '11.5px',
                padding: '6px 14px',
                height: '30px',
                marginTop: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={handleFixDamagesStandalone}
              disabled={loading === 'fix_damages'}
            >
              {loading === 'fix_damages'
                ? '🔄 Corrigindo...'
                : '⚡ Corrigir Apenas CSVs de Damages'}
            </button>
          </div>
        </div>
      </Section>

      {/* ── 2. NOMENCLATURA ── */}
      <Section
        num="2"
        title="Validação de Nomenclatura"
        D={D}
        badge={nomBadge?.text}
        badgeColor={nomBadge?.color}
      >
        {!validation ? (
          <div style={{ fontSize: '12px', color: D.textMuted }}>
            Carregue os ficheiros e clique em "Analisar Nomenclatura".
          </div>
        ) : (
          <>
            {/* Métricas */}
            <div
              style={{
                display: 'flex',
                gap: '20px',
                marginBottom: '12px',
                flexWrap: 'wrap',
              }}
            >
              {[
                ['Horizon', validation.turbinas_horizon, D.textPrimary],
                ['ATW', validation.turbinas_atw, D.textPrimary],
                [
                  'Extras',
                  computedState.extras.length,
                  computedState.extras.length > 0 ? D.warning : D.success,
                ],
                [
                  'Faltantes',
                  computedState.faltantes.length,
                  computedState.faltantes.length > 0 ? D.warning : D.success,
                ],
              ].map(([label, val, color]) => (
                <div
                  key={label}
                  style={{ textAlign: 'center', minWidth: '50px' }}
                >
                  <div style={{ fontSize: '20px', fontWeight: 700, color }}>
                    {val}
                  </div>
                  <div style={{ fontSize: '10px', color: D.textMuted }}>
                    {label}
                  </div>
                </div>
              ))}
              {validation.n_duplicatas > 0 && (
                <div
                  style={{
                    alignSelf: 'center',
                    fontSize: '11px',
                    color: D.warning,
                  }}
                >
                  ⚠ {validation.n_duplicatas} duplicata(s) removida(s)
                </div>
              )}
            </div>

            {/* Auto-matches pendentes */}
            {Object.keys(computedState.autoMatchesPendentes).length > 0 && (
              <div
                style={{
                  background: `${D.warning}11`,
                  border: `1px solid ${D.warning}33`,
                  borderRadius: '6px',
                  padding: '10px',
                  marginBottom: '10px',
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    color: D.warning,
                    fontWeight: 600,
                    marginBottom: '6px',
                  }}
                >
                  ⚡ {Object.keys(computedState.autoMatchesPendentes).length}{' '}
                  correspondência(s) automática(s) — revise:
                </div>
                <div
                  style={{
                    fontSize: '11px',
                    color: D.textMuted,
                    marginBottom: '8px',
                  }}
                >
                  Nomes idênticos após remover espaços/hífens.
                </div>
                {Object.entries(computedState.autoMatchesPendentes).map(
                  ([th, ta]) => (
                    <div
                      key={th}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        marginBottom: '5px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={tag(D.warning)}>{th}</span>
                      <span style={{ color: D.textMuted }}>→</span>
                      <span style={tag(D.warning)}>{ta}</span>
                      <span
                        style={{
                          fontSize: '10px',
                          color: D.textMuted,
                          flex: 1,
                        }}
                      >
                        ({normalizar(th)} = {normalizar(ta)})
                      </span>
                      <button
                        style={{
                          ...btn(D.success),
                          padding: '2px 8px',
                          fontSize: '11px',
                        }}
                        onClick={() =>
                          setAutoAccepted(a => ({ ...a, [th]: ta }))
                        }
                      >
                        ✓
                      </button>
                      <button
                        style={{
                          ...btn(D.error),
                          padding: '2px 8px',
                          fontSize: '11px',
                        }}
                        onClick={() =>
                          setAutoRejected(r => new Set([...r, th]))
                        }
                      >
                        ✗
                      </button>
                    </div>
                  )
                )}
                <button
                  style={{
                    ...btn(D.success, `${D.success}18`),
                    fontSize: '11px',
                    marginTop: '4px',
                  }}
                  onClick={() =>
                    setAutoAccepted(a => ({
                      ...a,
                      ...computedState.autoMatchesPendentes,
                    }))
                  }
                >
                  ✓ Aceitar todos (
                  {Object.keys(computedState.autoMatchesPendentes).length})
                </button>
              </div>
            )}

            {/* Auto-matches aceites */}
            {Object.keys(autoAccepted).length > 0 && (
              <div style={{ marginBottom: '10px' }}>
                <div
                  style={{
                    fontSize: '11px',
                    color: D.textMuted,
                    marginBottom: '4px',
                  }}
                >
                  Correspondências aceites:
                </div>
                {Object.entries(autoAccepted).map(([th, ta]) => (
                  <span key={th} style={tag(D.success)}>
                    {th} → {ta}
                    <span
                      style={{ cursor: 'pointer' }}
                      onClick={() =>
                        setAutoAccepted(a =>
                          Object.fromEntries(
                            Object.entries(a).filter(([k]) => k !== th)
                          )
                        )
                      }
                    >
                      ×
                    </span>
                  </span>
                ))}
              </div>
            )}

            {/* Extras */}
            {computedState.extras.length > 0 && (
              <div style={{ marginBottom: '10px' }}>
                <div
                  style={{
                    fontSize: '12px',
                    color: D.warning,
                    marginBottom: '6px',
                  }}
                >
                  ⚠ {computedState.extras.length} turbina(s) no ATW não existem
                  na Horizon:
                </div>
                <div
                  style={{
                    fontSize: '11px',
                    color: D.textMuted,
                    marginBottom: '4px',
                  }}
                >
                  Clique para marcar para remoção:
                </div>
                {computedState.extras.map(t => (
                  <span
                    key={t}
                    style={pill(removals.turbinas_removidas.includes(t))}
                    onClick={() =>
                      setRemovals(r => ({
                        ...r,
                        turbinas_removidas: r.turbinas_removidas.includes(t)
                          ? r.turbinas_removidas.filter(x => x !== t)
                          : [...r.turbinas_removidas, t],
                      }))
                    }
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}

            {/* Faltantes */}
            {computedState.faltantes.length > 0 && (
              <div style={{ marginBottom: '10px' }}>
                <div
                  style={{
                    fontSize: '12px',
                    color: D.warning,
                    marginBottom: '6px',
                  }}
                >
                  ⚠ {computedState.faltantes.length} turbina(s) da Horizon não
                  têm inspeção no ATW:
                </div>
                <div
                  style={{
                    fontSize: '11px',
                    color: D.textMuted,
                    marginBottom: '4px',
                  }}
                >
                  Remover da Horizon (sem inspeção):
                </div>
                {computedState.faltantes.map(t => (
                  <span
                    key={t}
                    style={pill(
                      removals.turbinas_horizon_removidas.includes(t)
                    )}
                    onClick={() =>
                      setRemovals(r => ({
                        ...r,
                        turbinas_horizon_removidas:
                          r.turbinas_horizon_removidas.includes(t)
                            ? r.turbinas_horizon_removidas.filter(x => x !== t)
                            : [...r.turbinas_horizon_removidas, t],
                      }))
                    }
                  >
                    {t}
                  </span>
                ))}
                {computedState.faltantes.filter(
                  t => !removals.turbinas_horizon_removidas.includes(t)
                ).length > 0 && (
                  <div style={{ marginTop: '8px' }}>
                    <div
                      style={{
                        fontSize: '11px',
                        color: D.textMuted,
                        marginBottom: '4px',
                      }}
                    >
                      Ou vincular a uma turbina ATW:
                    </div>
                    {computedState.faltantes
                      .filter(
                        t => !removals.turbinas_horizon_removidas.includes(t)
                      )
                      .map(th => {
                        const sug = validation.suggestions[th]
                        return (
                          <div
                            key={th}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              marginBottom: '5px',
                            }}
                          >
                            <span
                              style={{
                                fontSize: '12px',
                                color: D.textSecond,
                                minWidth: '120px',
                              }}
                            >
                              {th}
                            </span>
                            <span style={{ color: D.textMuted }}>→</span>
                            <select
                              value={vinculos[th] || ''}
                              onChange={e =>
                                setVinculos(v =>
                                  e.target.value
                                    ? { ...v, [th]: e.target.value }
                                    : Object.fromEntries(
                                        Object.entries(v).filter(
                                          ([k]) => k !== th
                                        )
                                      )
                                )
                              }
                              style={{
                                background: D.inputBg,
                                border: `1px solid ${D.border}`,
                                color: D.textPrimary,
                                padding: '3px 7px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                outline: 'none',
                                flex: 1,
                              }}
                            >
                              <option value="">-- Vincular a... --</option>
                              {computedState.opcAtw.map(t => (
                                <option key={t} value={t}>
                                  {t}
                                  {sug?.suggestion === t
                                    ? ` (${Math.round(sug.score * 100)}% similar)`
                                    : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        )
                      })}
                  </div>
                )}
              </div>
            )}

            {computedState.isValid && (
              <div style={{ fontSize: '12px', color: D.success }}>
                ✅ Nomenclatura OK — todos os nomes reconciliados.
              </div>
            )}
          </>
        )}
      </Section>

      {/* ── 3. REQUISITOS ── */}
      <Section
        num="3"
        title="Requisitos Horizon"
        D={D}
        badge={reqsBadge?.text}
        badgeColor={reqsBadge?.color}
      >
        {!files.details ? (
          <div style={{ fontSize: '12px', color: D.textMuted }}>
            Adicione o ficheiro Details (secção 1) para verificar os requisitos.
          </div>
        ) : !requirements && !reqsLoading ? (
          <div style={{ fontSize: '12px', color: D.textMuted }}>
            Aguardando...
          </div>
        ) : requirements ? (
          <div>
            {requirements.errors.length === 0 &&
              requirements.warnings.length === 0 && (
                <div
                  style={{
                    fontSize: '12px',
                    color: D.success,
                    marginBottom: '4px',
                  }}
                >
                  ✅ Todos os requisitos atendidos.
                </div>
              )}
            {requirements.errors.map((e, i) => (
              <div
                key={i}
                style={{
                  fontSize: '12px',
                  color: D.error,
                  marginBottom: '3px',
                }}
              >
                ❌ {e}
              </div>
            ))}
            {requirements.warnings.map((w, i) => (
              <div
                key={i}
                style={{
                  fontSize: '12px',
                  color: D.warning,
                  marginBottom: '3px',
                }}
              >
                ⚠ {w}
              </div>
            ))}
          </div>
        ) : null}
      </Section>

      {/* ── 4. GERAR PACOTE ── */}
      <Section num="4" title="Gerar Pacote Final" D={D}>
        {!computedState?.isValid ? (
          <div style={{ fontSize: '12px', color: D.textMuted }}>
            Resolva a nomenclatura (secção 2) para gerar o pacote.
          </div>
        ) : requirements?.errors.length > 0 ? (
          <div style={{ fontSize: '12px', color: D.textMuted }}>
            Corrija os erros de requisitos (secção 3) antes de gerar.
          </div>
        ) : !requirements ? (
          <div style={{ fontSize: '12px', color: D.textMuted }}>
            Adicione o Details para verificar os requisitos.
          </div>
        ) : (
          <>
            {requirements.warnings.length > 0 && (
              <div
                style={{
                  fontSize: '11px',
                  color: D.textMuted,
                  marginBottom: '8px',
                }}
              >
                {requirements.warnings.length} aviso(s) presentes — o pacote
                pode ser gerado mesmo assim.
              </div>
            )}
            <button
              style={{
                ...btn(D.success, `${D.success}18`),
                opacity: loading === 'generate' ? 0.5 : 1,
                fontSize: '13px',
                padding: '7px 18px',
              }}
              disabled={loading === 'generate'}
              onClick={handleGenerate}
            >
              {loading === 'generate'
                ? '🔄 Gerando...'
                : '⬇ Gerar Pacote Final (.ZIP)'}
            </button>

            {/* Resultado */}
            {pkg && (
              <div
                style={{
                  marginTop: '12px',
                  paddingTop: '10px',
                  borderTop: `1px solid ${D.borderLight}`,
                }}
              >
                {pkg.erros_pos?.length > 0 ? (
                  <>
                    <div
                      style={{
                        fontSize: '12px',
                        color: D.warning,
                        marginBottom: '6px',
                      }}
                    >
                      ⚠ Pacote gerado com avisos:
                    </div>
                    {pkg.erros_pos.map((e, i) => (
                      <div
                        key={i}
                        style={{
                          fontSize: '11px',
                          color: D.warning,
                          marginBottom: '2px',
                        }}
                      >
                        • {e}
                      </div>
                    ))}
                  </>
                ) : (
                  <div
                    style={{
                      fontSize: '12px',
                      color: D.success,
                      marginBottom: '6px',
                    }}
                  >
                    ✅ Pacote verificado e aprovado.
                  </div>
                )}
                <div
                  style={{
                    fontSize: '11px',
                    color: D.textSecond,
                    marginBottom: '8px',
                    marginTop: '4px',
                  }}
                >
                  📦 {basename(pkg.zip_path)}
                </div>
                <button
                  style={{ ...btn(D.accent), fontSize: '12px' }}
                  onClick={() => onOpenFolder?.(pkg.output_dir)}
                >
                  {Icons.opendir(D.accent)} Abrir pasta de saída
                </button>
              </div>
            )}
          </>
        )}
      </Section>
    </div>
  )
}
