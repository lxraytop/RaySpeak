import { Minus, Square, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function withWindow(fn: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
  if (!inTauri()) return
  try {
    await fn(getCurrentWindow())
  } catch {
    /* window api unavailable */
  }
}

interface Props {
  connected: boolean
  latency: number
  status?: string
}

export function TitleBar({ connected, latency, status }: Props) {
  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onDoubleClick={() => withWindow((w) => w.toggleMaximize())}
    >
      <div className="brand" data-tauri-drag-region>
        <span className="brand-logo">
          <img src="/logo.png" alt="" draggable={false} />
        </span>
        <span className="brand-name">RaySpeak</span>
        <span className="brand-badge">V2</span>
      </div>

      <div className={`connbar ${connected ? '' : 'offline'}`} data-tauri-drag-region>
        <span className="conn-dot" />
        {status ?? (connected ? `已连接 · 延迟 ${latency} ms` : '连接已断开')}
      </div>

      <div className="win-controls">
        <button
          className="win-btn"
          title="最小化"
          onClick={() => withWindow((w) => w.minimize())}
        >
          <Minus size={15} strokeWidth={1.8} />
        </button>
        <button
          className="win-btn"
          title="最大化"
          onClick={() => withWindow((w) => w.toggleMaximize())}
        >
          <Square size={12} strokeWidth={1.8} />
        </button>
        <button
          className="win-btn close"
          title="关闭"
          onClick={() => withWindow((w) => w.close())}
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  )
}
