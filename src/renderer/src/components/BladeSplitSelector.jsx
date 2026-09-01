import React from 'react'
import { Icons } from '../constants/icons.jsx'

/**
 * Estrutura esperada de bladeSplitSuspeitos (vinda do backend):
 *   [
 *     {
 *       blade_position?: string,   // JSON
 *       blade_sn?: string,         // CSV
 *       total_fotos: number,
 *       sessoes: [
 *         {
 *           session_idx: number,
 *           ts_inicio: string | null,
 *           ts_fim: string | null,
 *           total_fotos: number,
 *           sides?: string[],
 *           original_indices: number[],
 *           itens_com_tempo: [{original_idx, dt, side?}],
 *         }
 *       ]
 *     }
 *   ]
 *
 * Saída em setOptions.correcoes, formato depende do tipo de arquivo:
 *   JSON: [{blade_position, sessoes: [{itens_com_tempo, novo_blade_position, novo_blade_sn}]}]
 *   CSV:  [{blade_sn_original, sessoes: [{original_indices, novo_sn}]}]
 */
export default function BladeSplitSelector({
  T,
  D,
  lang,
  dataFile,
  bladeSplitSuspeitos,
  setBladeSplitSuspeitos,
  setOptions,
}) {
  if (!bladeSplitSuspeitos || bladeSplitSuspeitos.length === 0) return null

  const isCsv = (dataFile || '').toLowerCase().endsWith('.csv')
  const VALID_POSITIONS = ['A', 'B', 'C']

  const fmtTs = ts => {
    if (!ts || ts === 'None' || ts === 'null') return '—'
    // "2026-04-15 14:23:45" → "15/04 14:23"
    const m = String(ts).match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/)
    return m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : String(ts)
  }

  const updateSession = (bladeIdx, sessIdx, field, value) => {
    if (
      field === 'novo_blade_position' &&
      value &&
      !VALID_POSITIONS.includes(value.toUpperCase())
    )
      return

    const newSuspeitos = bladeSplitSuspeitos.map((b, i) => {
      if (i !== bladeIdx) return b
      const newSessoes = b.sessoes.map((s, j) => {
        if (j !== sessIdx) return s
        return {
          ...s,
          [field]:
            field === 'novo_blade_position' ? value.toUpperCase() : value,
        }
      })
      return { ...b, sessoes: newSessoes }
    })
    setBladeSplitSuspeitos(newSuspeitos)

    // Monta as correcoes no formato esperado pelo backend
    if (isCsv) {
      const correcoes = newSuspeitos
        .map(b => {
          const sessoesPreenchidas = b.sessoes
            .filter(s => s.novo_sn && s.novo_sn.trim())
            .map(s => ({
              original_indices: s.original_indices,
              novo_sn: s.novo_sn.trim(),
            }))
          if (sessoesPreenchidas.length === 0) return null
          return {
            blade_sn_original: String(b.blade_sn ?? b.blade_position ?? ''),
            sessoes: sessoesPreenchidas,
          }
        })
        .filter(Boolean)
      setOptions(o => ({ ...o, correcoes }))
    } else {
      const correcoes = newSuspeitos
        .map(b => {
          const sessoesPreenchidas = b.sessoes
            .filter(
              s =>
                s.novo_blade_position &&
                s.novo_blade_sn &&
                s.novo_blade_sn.trim()
            )
            .map(s => ({
              itens_com_tempo: s.itens_com_tempo,
              novo_blade_position: s.novo_blade_position,
              novo_blade_sn: s.novo_blade_sn.trim(),
            }))
          if (sessoesPreenchidas.length === 0) return null
          return {
            blade_position: String(b.blade_position ?? b.blade_sn ?? ''),
            sessoes: sessoesPreenchidas,
          }
        })
        .filter(Boolean)
      setOptions(o => ({ ...o, correcoes }))
    }
  }

  return (
    <div
      className="gps-selector-container"
      style={{ background: D.logBg, border: `1px solid ${D.borderLight}` }}
    >
      <div
        className="gps-selector-header"
        style={{ color: D.accent, borderBottom: `1px solid ${D.borderLight}` }}
      >
        {Icons.warn(D.accent)}{' '}
        {isCsv
          ? 'Sessões de voo detectadas (por Blade SN)'
          : 'Sessões de voo detectadas (por posição)'}
      </div>
      <div className="gps-list">
        {bladeSplitSuspeitos.map((b, bIdx) => {
          const label = isCsv
            ? `Blade SN ${b.blade_sn ?? b.blade_position}`
            : `Posição ${b.blade_position ?? b.blade_sn}`
          return (
            <div
              key={bIdx}
              className="split-item"
              style={{
                padding: '12px',
                borderBottom: `1px solid ${D.borderLight}`,
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ color: D.textPrimary }}>
                <strong>{label}</strong>
                <span
                  style={{
                    color: D.textSecond,
                    marginLeft: 8,
                    fontSize: '0.9em',
                  }}
                >
                  {b.total_fotos} fotos • {b.sessoes?.length || 0} sessões
                </span>
              </div>

              {(b.sessoes || []).map((s, sIdx) => (
                <div
                  key={sIdx}
                  style={{
                    background: D.bgDeep,
                    padding: '8px 10px',
                    borderRadius: 4,
                    border: `1px solid ${D.borderLight}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ color: D.textSecond, fontSize: '0.85em' }}>
                    <strong style={{ color: D.textPrimary }}>
                      Sessão {s.session_idx + 1}
                    </strong>
                    {' • '}
                    {s.total_fotos} fotos
                    {' • '}
                    {fmtTs(s.ts_inicio)} → {fmtTs(s.ts_fim)}
                    {s.sides &&
                      s.sides.length > 0 &&
                      ` • sides: ${s.sides.join(', ')}`}
                  </div>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    {!isCsv && (
                      <input
                        type="text"
                        placeholder="Nova Posição (A/B/C)"
                        style={{
                          background: D.inputBg,
                          border: `1px solid ${D.border}`,
                          color: D.textPrimary,
                          padding: '6px',
                          borderRadius: '4px',
                          width: '130px',
                        }}
                        value={s.novo_blade_position || ''}
                        onChange={e =>
                          updateSession(
                            bIdx,
                            sIdx,
                            'novo_blade_position',
                            e.target.value
                          )
                        }
                      />
                    )}
                    <input
                      type="text"
                      placeholder={isCsv ? 'Novo Blade SN' : 'Novo SN'}
                      style={{
                        background: D.inputBg,
                        border: `1px solid ${D.border}`,
                        color: D.textPrimary,
                        padding: '6px',
                        borderRadius: '4px',
                        flex: 1,
                      }}
                      value={isCsv ? s.novo_sn || '' : s.novo_blade_sn || ''}
                      onChange={e =>
                        updateSession(
                          bIdx,
                          sIdx,
                          isCsv ? 'novo_sn' : 'novo_blade_sn',
                          e.target.value
                        )
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
