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
  // 后端快照已经按 TeamSpeak 显示顺序输出，`order` 是前驱频道 ID，不是序号。
  const children = channels.filter((item) => item.parentId === channel.id)

  const q = (query ?? '').trim().toLowerCase()
  const channelMatches = !q || stripTsTags(channel.name).toLowerCase().includes(q)
  const occupants = clients.filter((client) => client.channelId === channel.id)
  const members = occupants.filter(
    (client) => channelMatches || stripClientTags(client.name).toLowerCase().includes(q),
  )
  const count = occupants.length
  const hasItems = children.length > 0 || count > 0
  const open = expanded[channel.id] !== false
  const iconUrl = showIcons ? channelIconUrl(channel.iconId) : ''
  const active = channel.id === activeId
  // [cspacer] 之类的分隔频道同样是真实频道：可以有人、也可以进入，
  // 所以照样显示人数与成员，只是行样式更接近分组标题。
  const spacer = channel.kind === 'spacer'
  const memberNames = occupants
    .slice(0, 8)
    .map((client) => stripClientTags(client.name))
    .join('、')

  return (
    <div className="tree-node" data-depth={depth}>
      <button
        className={`tree-row ${active ? 'active' : ''} ${count > 0 ? 'occupied' : ''} ${
          spacer ? 'is-spacer' : ''
        }`}
        data-channel-id={channel.id}
        onClick={() => onJoin(channel.id)}
        title={[
          count > 0 ? `${count} 人在频道：${memberNames}${count > 8 ? '…' : ''}` : '当前无人在线',
          channel.maxClients ? `上限 ${channel.maxClients} 人` : '',
          `${channel.codec} · ${channel.bitrate}kbps`,
          children.length > 0 ? `${children.length} 个子频道` : '',
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

        {spacer ? (
          <span className={`tree-spacer-text ${parsed.align}`}>
            {renderTsText(channel.name)}
          </span>
        ) : (
          <>
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
          </>
        )}

        {(!spacer || count > 0) && (
          <span
            className={`tree-count ${count === 0 ? 'zero' : 'has'}`}
            aria-label={`${count} 人在线`}
          >
            {count}
          </span>
        )}
      </button>

      {open && (members.length > 0 || children.length > 0) && (
        <div className="tree-branch">
          {members.length > 0 && (
            <div className="tree-members">
              {members.map((member) => (
                <button
                  key={member.id}
                  className={`tree-member ${member.talking ? 'talking' : ''} ${
                    member.id === selfId ? 'is-self' : ''
                  }`}
                  data-client-id={member.id}
                  onClick={() => onSelectClient(member.id)}
                  title={member.name}
                >
                  <span className="tree-avatar">
                    <Avatar
                      letter={member.letter}
                      hue={member.hue}
                      size={18}
                      src={member.avatarUrl}
                    />
                  </span>
                  <span className="tree-member-name">{renderTsText(member.name)}</span>
                  <span className="tree-member-status">
                    <StatusIcons client={member} size={12.5} />
                  </span>
                </button>
              ))}
            </div>
          )}

          {children.map((child) => (
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
        </div>
      )}
    </div>
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
