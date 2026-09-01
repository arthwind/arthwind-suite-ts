import React, { useState } from 'react'

/**
 * Configuração de regiões para o Módulo 15 (Calibrar Z GoPro RAW).
 * Abordagem simplificada: Z = z_inicial + pos_index × 500 mm
 *
 * Props:
 *   regioes    — [{region, num_min, num_max, total}]
 *   setOptions — setter de options (popula options.referencias)
 *   D          — tema
 *
 * Estrutura enviada ao backend via options.referencias:
 *   {
 *     "LE": { z_inicial: 0, paired: true, transition: 6040 },
 *     ...
 *   }
 */

export default function GoproRawSelector({ regioes, setOptions, D }) {
  const [cfg, setCfg] = useState(() =>
    Object.fromEntries(
      (regioes || []).map(r => [
        r.region,
        { z_inicial: '', paired: false, transition: '', photocard: '' },
      ])
    )
  )

  if (!regioes || regioes.length === 0) return null

  const buildReferencias = newCfg => {
    const refs = {}
    for (const { region } of regioes) {
      const c = newCfg[region] || {}
      refs[region] = {
        z_inicial: parseInt(c.z_inicial) || 0,
        paired: !!c.paired,
        transition: parseInt(c.transition) || 0,
        photocard: parseInt(c.photocard) || 0,
      }
    }
    return refs
  }

  const update = (region, field, value) => {
    const next = { ...cfg, [region]: { ...cfg[region], [field]: value } }
    setCfg(next)
    setOptions(o => ({ ...o, referencias: buildReferencias(next) }))
  }

  const inputStyle = {
    background: D.inputBg,
    border: `1px solid ${D.border}`,
    color: D.textPrimary,
    padding: '5px 7px',
    borderRadius: '4px',
    fontSize: '12px',
    outline: 'none',
    fontFamily: 'inherit',
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        marginTop: '6px',
      }}
    >
      {regioes.map(({ region, num_min, num_max, total }) => {
        const c = cfg[region] || {
          z_inicial: '',
          paired: false,
          transition: '',
          photocard: '',
        }
        const zIni = parseInt(c.z_inicial) || 0
        const trans = parseInt(c.transition) || 0
        const pcard = parseInt(c.photocard) || 0

        // Estimativa de posições e Z máximo
        const effective_total = pcard > 0 ? Math.max(0, total - 1) : total
        let nPos = effective_total
        if (c.paired) {
          if (trans > 0 && trans > num_min) {
            let ratio = (trans - num_min) / Math.max(1, num_max - num_min)
            if (ratio > 1) ratio = 1
            if (ratio < 0) ratio = 0
            const photos_before = Math.round(effective_total * ratio)
            const photos_after = effective_total - photos_before
            nPos = Math.floor(photos_before / 2) + photos_after
          } else {
            nPos = Math.floor(effective_total / 2)
          }
        }
        const zMax = zIni + Math.max(0, nPos - 1) * 500

        return (
          <div
            key={region}
            style={{
              background: D.logBg,
              border: `1px solid ${D.borderLight}`,
              borderRadius: '6px',
              padding: '10px 12px',
            }}
          >
            {/* Header */}
            <div style={{ marginBottom: '10px' }}>
              <strong style={{ color: D.accent, fontSize: '13px' }}>
                {region}
              </strong>
              <span
                style={{
                  color: D.textSecond,
                  fontSize: '11px',
                  marginLeft: '8px',
                }}
              >
                {total} fotos · GOPR{num_min} → GOPR{num_max}
              </span>
            </div>

            {/* Z inicial e Photocard */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                marginBottom: '10px',
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                <span
                  style={{
                    fontSize: '12px',
                    color: D.textSecond,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Z inicial (mm):
                </span>
                <input
                  type="number"
                  placeholder="0"
                  value={c.z_inicial}
                  onChange={e => update(region, 'z_inicial', e.target.value)}
                  style={{ ...inputStyle, width: '100px' }}
                />
              </div>

              <div
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                <span
                  style={{
                    fontSize: '12px',
                    color: D.textSecond,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Photocard (GOPR):
                </span>
                <input
                  type="number"
                  placeholder="vazio=nenhum"
                  value={c.photocard}
                  onChange={e => update(region, 'photocard', e.target.value)}
                  style={{ ...inputStyle, width: '100px' }}
                />
              </div>
            </div>

            {/* Fotos em pares */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  cursor: 'pointer',
                  fontSize: '12px',
                  color: D.textSecond,
                }}
              >
                <input
                  type="checkbox"
                  checked={c.paired}
                  onChange={e => update(region, 'paired', e.target.checked)}
                  style={{ accentColor: D.accent, cursor: 'pointer' }}
                />
                Fotos em pares (0° e 45°)
              </label>
              {c.paired && (
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
                >
                  <span style={{ fontSize: '11px', color: D.textMuted }}>
                    até GOPR
                  </span>
                  <input
                    type="number"
                    placeholder={String(num_max)}
                    value={c.transition}
                    onChange={e => update(region, 'transition', e.target.value)}
                    style={{ ...inputStyle, width: '90px' }}
                  />
                  <span style={{ fontSize: '11px', color: D.textMuted }}>
                    (vazio = todos)
                  </span>
                </div>
              )}
            </div>

            {/* Preview */}
            <div
              style={{
                background: D.bgDeep,
                borderRadius: '4px',
                padding: '6px 10px',
                fontSize: '11px',
                color: D.textSecond,
                marginTop: '10px',
                display: 'flex',
                gap: '16px',
                flexWrap: 'wrap',
              }}
            >
              <span>
                posições:{' '}
                <strong style={{ color: D.textPrimary }}>{nPos}</strong>
              </span>
              <span>
                passo: <strong style={{ color: D.textPrimary }}>500 mm</strong>
              </span>
              <span>
                Z:{' '}
                <strong style={{ color: D.success }}>
                  {zIni} → {zMax} mm
                </strong>
              </span>
              {c.paired && (
                <span style={{ color: D.warning }}>· pares ativos</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
