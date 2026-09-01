// components/GpsSelector.jsx — Lista de fotos GPS para seleção da raiz (Z=0)

export default function GpsSelector({ T, D, gpsFotos, gpsRaiz, setGpsRaiz }) {
  if (gpsFotos.length === 0) return null

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="field-label" style={{ color: D.textMuted }}>
        {T.select_root}
      </div>
      <div
        className="gps-list"
        style={{ border: `1px solid ${D.border}`, background: D.logBg }}
      >
        {gpsFotos.map((f, i) => (
          <div
            key={i}
            className={`gps-row${gpsRaiz === f.nome ? ' selected' : ''}`}
            onClick={() => setGpsRaiz(f.nome)}
          >
            <span
              className="gps-row-name"
              style={{
                color: gpsRaiz === f.nome ? D.accent : D.textSecond,
                fontWeight: gpsRaiz === f.nome ? 600 : 400,
              }}
            >
              {f.nome}
            </span>
            <span className="gps-row-alt" style={{ color: D.textMuted }}>
              {f.altitude.toFixed(3)} m
            </span>
          </div>
        ))}
      </div>
      {gpsRaiz && (
        <div className="gps-selected" style={{ color: D.success }}>
          {T.root_selected}: {gpsRaiz}
        </div>
      )}
    </div>
  )
}
