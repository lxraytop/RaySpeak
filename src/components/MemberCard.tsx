import type { KeyboardEvent } from 'react'
import type { Client } from '../types'
import { renderTsText } from '../utils/tsText'
import { Avatar } from './Avatar'
import { GroupChips, StatusIcons, VolumeControl, clientStateText } from './memberBits'

interface Props {
  client: Client
  onOpen: (id: string) => void
  onVolume: (id: string, volume: number) => void
  onToggleLocalMute: (id: string) => void
  variant?: 'panel' | 'grid'
}

export function MemberCard({
  client,
  onOpen,
  onVolume,
  onToggleLocalMute,
  variant = 'panel',
}: Props) {
  const open = () => onOpen(client.id)
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      open()
    }
  }

  return (
    <div
      className={`member-card ${variant} ${client.talking ? 'talking' : ''} ${
        client.self ? 'is-self' : ''
      } ${client.localMuted ? 'locally-muted' : ''}`}
      data-client-id={client.id}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKey}
      title={`${client.name} · 点击查看资料`}
    >
      <div className="mc-head">
        <span className={`mc-avatar ${client.talking ? 'speaking' : ''}`}>
          <Avatar
            letter={client.letter}
            hue={client.hue}
            size={variant === 'grid' ? 42 : 38}
            src={client.avatarUrl}
          />
          <span className={`presence ${client.presence}`} />
        </span>

        <span className="mc-id">
          <span className="mc-name">
            {renderTsText(client.name)}
            {client.self && <em className="mc-you">你</em>}
          </span>
          <span className={`mc-state ${client.talking ? 'live' : ''}`}>
            <StatusIcons client={client} size={12} />
            <span className="mc-state-text">{clientStateText(client)}</span>
          </span>
        </span>

        <GroupChips ids={client.serverGroups} max={variant === 'grid' ? 3 : 2} />
      </div>

      {client.self ? (
        <div className="mc-self-note">
          <span className="mc-device">{client.device === 'mobile' ? '手机端在线' : '桌面端在线'}</span>
          <span className="mc-self-hint">这是你 · 可在设置中修改昵称</span>
        </div>
      ) : (
        <VolumeControl
          value={client.volume}
          muted={client.localMuted}
          onChange={(value) => onVolume(client.id, value)}
          onToggleMute={() => onToggleLocalMute(client.id)}
        />
      )}
    </div>
  )
}
