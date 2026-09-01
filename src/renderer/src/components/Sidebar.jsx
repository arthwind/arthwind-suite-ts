// components/Sidebar.jsx — Navegação lateral com módulos

import { Icons } from '../constants/icons.jsx'
import { GROUP_COLORS } from '../constants/translations.js'

export default function Sidebar({ T, D, active, onSwitch, collapsed }) {
  const renderGroups = () => {
    const groups = {}
    T.modules.forEach(m => {
      if (!groups[m.group]) groups[m.group] = []
      groups[m.group].push(m)
    })

    return Object.keys(groups).map((groupName, idx) => {
      const groupColor = GROUP_COLORS[groupName] || D.accent

      return (
        <div key={idx} style={{ marginBottom: '16px' }}>
          {groupName && (
            <div
              className="sidebar-group-row"
              style={{
                fontSize: '10px',
                fontWeight: '700',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: D.textMuted,
                padding: '8px 18px',
                marginTop: idx === 0 ? '4px' : '12px',
                marginBottom: '4px',
              }}
            >
              <span
                className="sidebar-group-dot"
                style={{ background: groupColor }}
              />
              {groupName}
            </div>
          )}
          {groups[groupName].map(m => {
            const isActive = active === m.id
            const iconColor = isActive ? groupColor : D.textMuted
            const iconBg = isActive ? `${groupColor}16` : D.accentSofter

            return (
              <div
                key={m.id}
                className={`nav-item ${isActive ? 'active' : ''}`}
                onClick={() => onSwitch(m.id)}
                style={{
                  borderLeftColor: isActive ? groupColor : 'transparent',
                }}
              >
                <div className="nav-icon" style={{ background: iconBg }}>
                  {Icons[m.icon] ? Icons[m.icon](iconColor) : null}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="nav-item-label"
                    style={{ color: isActive ? groupColor : D.textSecond }}
                  >
                    {m.label}
                  </div>
                  <div
                    className="nav-item-short"
                    style={{ color: D.textMuted }}
                  >
                    {m.short}
                  </div>
                </div>
                <span
                  className="nav-badge"
                  style={{
                    background: isActive ? `${groupColor}18` : D.accentSofter,
                    color: isActive ? groupColor : D.textMuted,
                  }}
                >
                  {m.id}
                </span>
              </div>
            )
          })}
        </div>
      )
    })
  }

  return (
    <div
      className={`sidebar ${collapsed ? 'collapsed' : ''}`}
      style={{ borderRight: `1px solid ${D.border}`, background: D.bgPanel }}
    >
      {renderGroups()}
    </div>
  )
}
