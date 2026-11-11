import { ChevronRight, Lock, Volume2 } from 'lucide-react'
import { channelIconUrl } from '../utils/icons'
import { renderTsText, parseChannelName, stripClientTags, stripTsTags } from '../utils/tsText'
import type { Client, VoiceChannel } from '../types'
import { Avatar } from './Avatar'
import { StatusIcons } from './memberBits'

interface TreeProps {
  section: 'public' | 'mine'
  channels: VoiceChannel[]
  clients: Client[]
  activeId: string
  selfId: string
  expanded: Record<string, boolean>
  showIcons: boolean
  query?: string
  onToggle: (id: string) => void
  onJoin: (id: string) => void
  onSelectClient: (id: string) => void
}

function ChannelNode({
  channel,
  depth,
  channels,
  clients,
  activeId,
  expanded,
  showIcons,
  query,
  onToggle,
  onJoin,
  onSelectClient,
  selfId,
}: {
  channel: VoiceChannel
  depth: number
} & Omit<TreeProps, 'section'>) {
  const parsed = parseChannelName(channel.name)
  // The backend snapshot is already in TeamSpeak display order; `order` is
  // the predecessor channel id, not a sortable position.
  const children = channels.filter((item) => item.parentId === channel.id)

  if (channel.kind === 'spacer') {
    return (
      <>
        {parsed.text.trim() && (
          <div className={`tree-spacer ${parsed.align}`} aria-hidden="true">
            <span>{renderTsText(channel.name)}</span>
          </div>
        )}
        {children.map((child) => (
          <ChannelNode
            key={child.id}
            channel={child}
            depth={depth}
            channels={channels}
            clients={clients}
            activeId={activeId}
            expanded={expanded}
            showIcons={showIcons}
            query={query}
            onToggle={onToggle}
            onJoin={onJoin}
            onSelectClient={onSelectClient}
            selfId={selfId}
          />
        ))}
      </>
    )
  }

  const q = (query ?? '').trim().toLowerCase()
  const channelMatches = !q || stripTsTags(channel.name).toLowerCase().includes(q)
  const occupants = clients.filter((client) => client.channelId === channel.id)
  const members = occupants.filter(
    (client) =>
      channelMatches || stripClientTags(client.name).toLowerCase().includes(q),
  )
  const count = occupants.length
  const hasItems = children.length > 0 || count > 0
  const open = expanded[channel.id] !== false
  const iconUrl = showIcons ? channelIconUrl(channel.iconId) : ''
  const active = channel.id === activeId
  const memberNames = occupants
    .slice(0, 8)
    .map((client) => stripClientTags(client.name))
    .join('、')

  return (
    <>
      <button
        className={`tree-row ${active ? 'active' : ''} ${count > 0 ? 'occupied' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-channel-id={channel.id}
        onClick={() => onJoin(channel.id)}
        title={[
          count > 0 ? `${count} 人在频道：${memberNames}${count > 8 ? '…' : ''}` : '当前无人在线',
          channel.maxClients ? `上限 ${channel.maxClients} 人` : '',
          `${channel.codec} · ${channel.bitrate}kbps`,
        ]
          .filter(Boolean)
          .join(' · ')}
      >
        <span
          className={`tree-chevron ${hasItems ? '' : 'empty'} ${open ? 'open' : ''}`}
          role="button"
          tabIndex={-1}
          onClick={(event) => {
            if (!hasItems) return
            event.stopPropagation()
            onToggle(channel.id)
          }}
        >
          <ChevronRight size={12} strokeWidth={2.4} />
        </span>

        <span className="tree-icon">
          {iconUrl ? (
            <img src={iconUrl} alt="" draggable={false} />
          ) : (
            <Volume2 size={15} strokeWidth={1.9} />
          )}
        </span>

        <span className="tree-name">{renderTsText(channel.name)}</span>

        {channel.password && (
          <span className="tree-lock" title="频道已加锁">
            <Lock size={11} strokeWidth={2.2} />
          </span>
        )}

        <span
          className={`tree-count ${count === 0 ? 'zero' : 'has'}`}
          aria-label={`${count} 人在线`}
        >
          {count}
        </span>
      </button>

      {open && members.length > 0 && (
        <div className="tree-members">
          {members.map((member) => (
            <button
              key={member.id}
              className={`tree-member ${member.talking ? 'talking' : ''} ${
                member.id === selfId ? 'is-self' : ''
              }`}
              data-client-id={member.id}
              style={{ paddingLeft: 8 + (depth + 1) * 14 + 14 }}
              onClick={() => onSelectClient(member.id)}
              title={member.name}
            >
              <span className="tree-avatar">
                <Avatar letter={member.letter} hue={member.hue} size={18} src={member.avatarUrl} />
              </span>
              <span className="tree-member-name">{renderTsText(member.name)}</span>
              <span className="tree-member-status">
                <StatusIcons client={member} size={12.5} />
              </span>
            </button>
          ))}
        </div>
      )}

      {open &&
        children.map((child) => (
          <ChannelNode
            key={child.id}
            channel={child}
            depth={depth + 1}
            channels={channels}
            clients={clients}
            activeId={activeId}
            expanded={expanded}
            showIcons={showIcons}
            query={query}
            onToggle={onToggle}
            onJoin={onJoin}
            onSelectClient={onSelectClient}
            selfId={selfId}
          />
        ))}
    </>
  )
}

export function ChannelTree(props: TreeProps) {
  const known = new Set(props.channels.map((channel) => channel.id))
  const roots = props.channels.filter(
    (channel) =>
      (channel.parentId === null || !known.has(channel.parentId)) &&
      channel.section === props.section,
  )

  return (
    <div className="channel-tree">
      {roots.map((channel) => (
        <ChannelNode
          key={channel.id}
          channel={channel}
          depth={0}
          channels={props.channels}
          clients={props.clients}
          activeId={props.activeId}
          expanded={props.expanded}
          showIcons={props.showIcons}
          query={props.query}
          onToggle={props.onToggle}
          onJoin={props.onJoin}
          onSelectClient={props.onSelectClient}
          selfId={props.selfId}
        />
      ))}
    </div>
  )
}
