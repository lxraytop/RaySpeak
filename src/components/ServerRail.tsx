import { Headphones, Mic, MicOff, Settings, Users } from 'lucide-react'
import { Avatar } from './Avatar'

interface Props {
  muted: boolean
  deafened: boolean
  selfName: string
  selfAvatar?: string
  selfStatus?: 'online' | 'away' | 'busy'
  unreadCount?: number
  onToggleMute: () => void
  onToggleDeafen: () => void
  onNavigate: (tab: 'voice' | 'contacts' | 'settings') => void
  activeTab: 'voice' | 'contacts' | 'settings'
}

const tabs = [
  { id: 'voice', label: '语音', icon: Mic },
  { id: 'contacts', label: '联系人', icon: Users },
  { id: 'settings', label: '设置', icon: Settings },
] as const

export function ServerRail({
  muted,
  deafened,
  selfName,
  selfAvatar,
  selfStatus = 'online',
  unreadCount = 0,
  onToggleMute,
  onToggleDeafen,
  onNavigate,
  activeTab,
}: Props) {
  return (
    <nav className="rail">
      <div className="rail-tabs">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`rail-item ${activeTab === id ? 'active' : ''}`}
            onClick={() => onNavigate(id)}
          >
            <Icon size={21} strokeWidth={1.8} />
            <span>{label}</span>
            {id === 'contacts' && unreadCount > 0 && (
              <span className="rail-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
            )}
          </button>
        ))}
      </div>

      <div className="rail-bottom">
        <div className="rail-me" title={selfName}>
          <Avatar letter={selfName.slice(0, 1) || 'R'} hue={214} size={42} src={selfAvatar} />
          <span className={`presence ${selfStatus} rail-presence`} />
        </div>
        <div className="rail-actions">
          <button
            className={`rail-mini ${muted ? 'danger' : ''}`}
            title={muted ? '取消静音' : '静音'}
            onClick={onToggleMute}
          >
            {muted ? <MicOff size={17} strokeWidth={1.8} /> : <Mic size={17} strokeWidth={1.8} />}
          </button>
          <button
            className={`rail-mini ${deafened ? 'danger' : ''}`}
            title={deafened ? '取消闭麦' : '闭麦'}
            onClick={onToggleDeafen}
          >
            <Headphones size={17} strokeWidth={1.8} />
            {deafened && <span className="slash" />}
          </button>
        </div>
      </div>
    </nav>
  )
}
