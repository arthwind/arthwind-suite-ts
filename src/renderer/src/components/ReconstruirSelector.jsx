import { useEffect, useState } from 'react'

const SIDES = ['SS', 'PS', 'LE', 'TE']

const emptySide = () => ({
  side: 'SS',
  start: '',
  end: '',
  pixel_mm_avg: '0.45',
})

export default function ReconstruirSelector({ D, fotos, setOptions }) {
  const [bladeSn, setBladeSn] = useState('')
  const [sides, setSides] = useState([emptySide()])

  // Propaga config ao parent sempre que algo muda
  useEffect(() => {
    setOptions(o => ({
      ...o,
      blade_sn: bladeSn,
      sides: sides.map(s => ({
        ...s,
        pixel_mm_avg: parseFloat(s.pixel_mm_avg) || 0.45,
      })),
    }))
  }, [bladeSn, sides]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateSide = (idx, field, value) => {
    setSides(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: value }
      return next
    })
  }

  const addSide = () => setSides(prev => [...prev, emptySide()])
  const removeSide = idx => setSides(prev => prev.filter((_, i) => i !== idx))

  const inputStyle = {
    background: D.inputBg,
    border: `1px solid ${D.border}`,
    color: D.textPrimary,
    padding: '5px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    outline: 'none',
  }

  const selectStyle = { ...inputStyle, cursor: 'pointer' }

  return (
    <div
      style={{
        background: D.logBg,
        border: `1px solid ${D.borderLight}`,
        borderRadius: '6px',
        padding: '12px',
        marginTop: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      {/* Blade SN */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={{ color: D.textMuted, fontSize: '11px' }}>Blade SN</span>
        <input
          type="text"
          placeholder="Ex: SN-123456"
          value={bladeSn}
          onChange={e => setBladeSn(e.target.value)}
          style={{ ...inputStyle, width: '220px' }}
        />
      </div>

      {/* Cabeçalho da tabela de lados */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '70px 1fr 1fr 90px 28px',
          gap: '6px',
          alignItems: 'center',
        }}
      >
        <span style={{ color: D.textMuted, fontSize: '11px' }}>Lado</span>
        <span style={{ color: D.textMuted, fontSize: '11px' }}>
          Foto início
        </span>
        <span style={{ color: D.textMuted, fontSize: '11px' }}>Foto fim</span>
        <span style={{ color: D.textMuted, fontSize: '11px' }}>
          Pixel MM médio
        </span>
        <span />
      </div>

      {/* Linhas de lados */}
      {sides.map((s, idx) => (
        <div
          key={idx}
          style={{
            display: 'grid',
            gridTemplateColumns: '70px 1fr 1fr 90px 28px',
            gap: '6px',
            alignItems: 'center',
          }}
        >
          {/* Side name */}
          <select
            value={s.side}
            onChange={e => updateSide(idx, 'side', e.target.value)}
            style={selectStyle}
          >
            {SIDES.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          {/* Start photo */}
          <select
            value={s.start}
            onChange={e => updateSide(idx, 'start', e.target.value)}
            style={{ ...selectStyle, width: '100%' }}
          >
            <option value="">— início —</option>
            {fotos.map(f => (
              <option key={f.nome} value={f.nome}>
                {f.nome} ({f.z_relativo_mm} mm)
              </option>
            ))}
          </select>

          {/* End photo */}
          <select
            value={s.end}
            onChange={e => updateSide(idx, 'end', e.target.value)}
            style={{ ...selectStyle, width: '100%' }}
          >
            <option value="">— fim —</option>
            {fotos.map(f => (
              <option key={f.nome} value={f.nome}>
                {f.nome} ({f.z_relativo_mm} mm)
              </option>
            ))}
          </select>

          {/* Pixel MM avg */}
          <input
            type="number"
            step="0.01"
            min="0.1"
            max="1.0"
            value={s.pixel_mm_avg}
            onChange={e => updateSide(idx, 'pixel_mm_avg', e.target.value)}
            style={inputStyle}
          />

          {/* Indicador tip→root */}
          {['SS', 'PS'].includes(s.side) && (
            <span
              style={{
                gridColumn: '1 / -1',
                color: D.warning,
                fontSize: '11px',
                marginTop: '-4px',
              }}
            >
              ↩ Ordem invertida automaticamente (tip→root)
            </span>
          )}

          {/* Remove */}
          <button
            onClick={() => removeSide(idx)}
            disabled={sides.length === 1}
            style={{
              background: 'transparent',
              border: 'none',
              color: sides.length === 1 ? D.textMuted : D.error,
              cursor: sides.length === 1 ? 'default' : 'pointer',
              fontSize: '14px',
              padding: 0,
            }}
            title="Remover lado"
          >
            ✕
          </button>
        </div>
      ))}

      {/* Botão adicionar lado */}
      <button
        onClick={addSide}
        style={{
          alignSelf: 'flex-start',
          background: D.accentSofter,
          border: `1px solid ${D.border}`,
          color: D.accent,
          borderRadius: '4px',
          padding: '4px 10px',
          fontSize: '12px',
          cursor: 'pointer',
        }}
      >
        + Adicionar lado
      </button>
    </div>
  )
}
