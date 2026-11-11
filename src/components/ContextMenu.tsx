import { useEffect, type ReactNode } from 'react'

export interface ContextItem {
  label: string
  icon?: ReactNode
  hint?: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: ContextItem[]
  onClose: () => void
}) {
  useEffect(() => {
    const close = () => onClose()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const width = 208
  const height = Math.min(items.length * 34 + 12, 380)
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8))

  return (
    <div
      className="context-menu"
      style={{ left, top, width }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      role="menu"
    >
      {items.map((item, index) => (
        <button
          key={`${item.label}-${index}`}
          className={`context-item ${item.danger ? 'danger' : ''}`}
          disabled={item.disabled}
          role="menuitem"
          onClick={() => {
            if (item.disabled) return
            onClose()
            item.onClick()
          }}
        >
          {item.icon && <span className="context-icon">{item.icon}</span>}
          <span className="context-label">{item.label}</span>
          {item.hint && <span className="context-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  )
}
