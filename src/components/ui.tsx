import { useEffect, useState, type ReactNode } from 'react'

export function Switch({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      className={`switch ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  suffix = '',
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  suffix?: string
}) {
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="slider-value">
        {value}
        {suffix}
      </span>
    </div>
  )
}

interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Select({
  value,
  options,
  onChange,
}: {
  value: string
  options: ReadonlyArray<string | { value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <div className="select-wrap">
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => {
          const item = typeof option === 'string' ? { value: option, label: option } : option
          return (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          )
        })}
      </select>
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  maxLength?: number
}) {
  return (
    <input
      className="text-input"
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
}) {
  return (
    <input
      className="text-input number"
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  )
}

export function HotkeyInput({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!recording) return
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        return
      }
      const parts: string[] = []
      if (event.ctrlKey) parts.push('Ctrl')
      if (event.shiftKey) parts.push('Shift')
      if (event.altKey) parts.push('Alt')
      if (event.metaKey) parts.push('Win')
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
        parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key)
      }
      if (parts.length === 0) return
      onChange(parts.join('+'))
      setRecording(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onChange])

  return (
    <button
      type="button"
      className={`hotkey-input ${recording ? 'recording' : ''}`}
      onClick={() => setRecording(true)}
    >
      {recording ? (
        <span className="hotkey-hint">按下组合键…</span>
      ) : (
        value.split('+').map((part) => (
          <kbd key={part} className="hotkey-key">
            {part}
          </kbd>
        ))
      )}
    </button>
  )
}

export function SettingRow({
  title,
  desc,
  children,
  vertical,
}: {
  title: string
  desc?: string
  children: ReactNode
  vertical?: boolean
}) {
  return (
    <div className={`set-row ${vertical ? 'vertical' : ''}`}>
      <div className="set-copy">
        <strong>{title}</strong>
        {desc && <span>{desc}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

export function SetCard({
  title,
  desc,
  children,
}: {
  title?: string
  desc?: string
  children: ReactNode
}) {
  return (
    <section className="set-card">
      {(title || desc) && (
        <header className="set-card-head">
          {title && <h3>{title}</h3>}
          {desc && <p>{desc}</p>}
        </header>
      )}
      {children}
    </section>
  )
}
