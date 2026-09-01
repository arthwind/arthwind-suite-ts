// components/StatusBar.jsx — Barra de status inferior

export default function StatusBar({ T, D, active, running, progress }) {
  const activeModule = T.modules.find(m => m.id === active)

  return (
    <div
      className="statusbar"
      style={{ borderTop: `1px solid ${D.border}`, background: D.bgDeep }}
    >
      <span className="statusbar-app" style={{ color: D.textMuted }}>
        Arthwind Suite
      </span>
      <span style={{ color: D.border }}>·</span>
      <span className="statusbar-module" style={{ color: D.textMuted }}>
        {activeModule?.label}
      </span>
      {running && progress >= 0 && (
        <>
          <span style={{ color: D.border }}>·</span>
          <span className="statusbar-progress" style={{ color: D.accent }}>
            {progress}%
          </span>
        </>
      )}
      <span
        className="statusbar-status"
        style={{
          color: running ? D.accent : D.textMuted,
          fontWeight: running ? 600 : 400,
        }}
      >
        {running ? T.processing : T.ready}
      </span>
    </div>
  )
}
