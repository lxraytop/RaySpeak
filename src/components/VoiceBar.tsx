import { useEffect, useRef } from 'react'
import { Columns2, LayoutGrid, Mic, MicOff, Settings, Volume2 } from 'lucide-react'
import type { LayoutId } from '../types'

interface Props {
  muted: boolean
  deafened: boolean
  connected: boolean
  deviceName: string
  inputVolume: number
  codecLabel: string
  layout: LayoutId
  onToggleMute: () => void
  onToggleDeafen: () => void
  onOpenSettings: () => void
  onToggleConnection: () => void
  onLayout: (layout: LayoutId) => void
}

export function VoiceBar({
  muted,
  deafened,
  connected,
  deviceName,
  inputVolume,
  codecLabel,
  layout,
  onToggleMute,
  onToggleDeafen,
  onOpenSettings,
  onToggleConnection,
  onLayout,
}: Props) {
  const live = connected && !muted
  const barsRef = useRef<Array<HTMLElement | null>>([])

  useEffect(() => {
    const reset = () =>
      barsRef.current.forEach((bar) => {
        if (bar) bar.style.height = '4px'
      })
    if (!live) {
      reset()
      return
    }
    let level = 0
    let frame = 0
    const onLevel = (event: Event) => {
      level = (event as CustomEvent<{ level: number }>).detail.level
    }
    const tick = () => {
      barsRef.current.forEach((bar, index) => {
        if (!bar) return
        const height =
          3 +
          Math.min(
            10,
            level * 24 * (0.55 + 0.45 * Math.abs(Math.sin(index * 1.6))),
          )
        bar.style.height = `${height}px`
      })
      frame = requestAnimationFrame(tick)
    }
    window.addEventListener('rayspeak:level', onLevel)
    tick()
    return () => {
      window.removeEventListener('rayspeak:level', onLevel)
      cancelAnimationFrame(frame)
      reset()
    }
  }, [live])

  return (
    <footer className="voicebar">
      <div className="vb-left">
        <button
          className={`vb-icon ${muted ? 'danger' : ''}`}
          title={muted ? '取消静音' : '静音'}
          onClick={onToggleMute}
        >
          {muted ? <MicOff size={17} strokeWidth={1.9} /> : <Mic size={17} strokeWidth={1.9} />}
        </button>
        <button
          className={`vb-icon ${deafened ? 'danger' : ''}`}
          title={deafened ? '取消闭麦' : '闭麦'}
          onClick={onToggleDeafen}
        >
          <Volume2 size={17} strokeWidth={1.9} />
          {deafened && <span className="slash" />}
        </button>
        <button className="vb-icon" title="语音设置" onClick={onOpenSettings}>
          <Settings size={17} strokeWidth={1.9} />
        </button>

        <div className="vb-device">
          <span className="vb-device-label">麦克风</span>
          <span className="vb-dot">·</span>
          <span className="vb-device-name">{deviceName}</span>
          <span className={`meter real ${live ? 'live' : ''}`} aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <i
                key={i}
                ref={(element) => {
                  barsRef.current[i] = element
                }}
              />
            ))}
          </span>
          <span className="vb-gain">{inputVolume}%</span>
        </div>
      </div>

      <div className="vb-layout" title="切换房间布局">
        <button
          className={`vb-layout-btn ${layout === 'cards' ? 'active' : ''}`}
          onClick={() => onLayout('cards')}
          title="成员卡片布局"
        >
          <Columns2 size={14} strokeWidth={2} />
          成员栏
        </button>
        <button
          className={`vb-layout-btn ${layout === 'grid' ? 'active' : ''}`}
          onClick={() => onLayout('grid')}
          title="网格式布局"
        >
          <LayoutGrid size={14} strokeWidth={2} />
          网格
        </button>
      </div>

      <div className="vb-right">
        <span className="vb-codec">{codecLabel}</span>
        <button
          className={`vb-connect ${connected ? 'disconnect' : ''}`}
          onClick={onToggleConnection}
        >
          {connected ? '断开连接' : '重新连接'}
        </button>
      </div>
    </footer>
  )
}
