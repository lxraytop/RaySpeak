import {
  BadgeCheck,
  Crown,
  Flag,
  Mic,
  MicOff,
  Moon,
  Music2,
  Radio,
  Shield,
  Smartphone,
  Sparkles,
  Star,
  Swords,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CSSProperties } from 'react'
import { groupMap } from '../data/mock'
import type { Client, GroupIcon } from '../types'
import { groupIconUrl } from '../utils/icons'

const groupIconMap: Record<GroupIcon, LucideIcon> = {
  shield: Shield,
  crown: Crown,
  flag: Flag,
  music: Music2,
  star: Star,
  badge: BadgeCheck,
  users: Users,
  swords: Swords,
  radio: Radio,
  spark: Sparkles,
}

export function GroupChip({ id, size = 16 }: { id: string; size?: number }) {
  const group = groupMap.get(id)
  if (!group) return null
  const Icon = groupIconMap[group.icon] ?? Users
  const custom = groupIconUrl(id)
  const style = {
    '--g': group.color,
    width: size,
    height: size,
    borderRadius: Math.max(4, Math.round(size * 0.3)),
  } as CSSProperties
  return (
    <span
      className="group-chip"
      style={style}
      title={`${group.type === 'server' ? '服务器组' : '频道组'} · ${group.name}`}
    >
      {custom ? (
        <img src={custom} alt="" draggable={false} />
      ) : (
        <Icon size={Math.round(size * 0.7)} strokeWidth={2.2} />
      )}
    </span>
  )
}

export function GroupChips({ ids, max = 3 }: { ids: string[]; max?: number }) {
  const visible = ids.slice(0, max)
  const rest = ids.length - visible.length
  return (
    <span className="group-chips">
      {visible.map((id) => (
        <GroupChip key={id} id={id} />
      ))}
      {rest > 0 && (
        <span className="group-chip more" title={`还有 ${rest} 个组`}>
          +{rest}
        </span>
      )}
    </span>
  )
}

export function StatusIcons({
  client,
  size = 14,
}: {
  client: Pick<Client, 'micMuted' | 'outputMuted' | 'talking' | 'presence' | 'device'>
  size?: number
}) {
  return (
    <span className="status-icons">
      {client.micMuted ? (
        <MicOff size={size} strokeWidth={2} className="st mic-off" />
      ) : (
        <Mic
          size={size}
          strokeWidth={2}
          className={`st mic-on ${client.talking ? 'live' : ''}`}
        />
      )}
      {client.outputMuted ? (
        <VolumeX size={size} strokeWidth={2} className="st spk-off" />
      ) : (
        <Volume2 size={size} strokeWidth={2} className="st spk-on" />
      )}
      {client.device === 'mobile' && <Smartphone size={size} strokeWidth={2} className="st device" />}
      {client.presence === 'away' && <Moon size={size} strokeWidth={2} className="st away" />}
    </span>
  )
}

export function clientStateText(client: Client) {
  if (client.presence === 'offline') return '离线'
  if (client.presence === 'busy') return '勿扰'
  if (client.talking) return '正在说话'
  if (client.outputMuted) return '扬声器关闭'
  if (client.micMuted) return '已静音'
  if (client.presence === 'away') return client.awayMessage ?? '离开'
  if (client.self) return '在线（你）'
  return '在线'
}

export function VolumeControl({
  value,
  muted,
  onChange,
  onToggleMute,
}: {
  value: number
  muted: boolean
  onChange: (value: number) => void
  onToggleMute: () => void
}) {
  return (
    <div className="volume-control" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`vc-btn ${muted ? 'muted' : ''}`}
        title={muted ? '取消本地静音' : '本地静音'}
        onClick={onToggleMute}
      >
        {muted ? <VolumeX size={13} strokeWidth={2.1} /> : <Volume2 size={13} strokeWidth={2.1} />}
      </button>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={value}
        title={`收音音量 ${value}%`}
        style={{ '--fill': `${value / 2}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="vc-value">{value}%</span>
    </div>
  )
}
