import { useMemo, useState } from 'react'
import { Plus, RefreshCw, Search, X } from 'lucide-react'
import type { Client, VoiceChannel } from '../types'
import { stripClientTags, stripTsTags } from '../utils/tsText'
import { ChannelTree } from './ChannelTree'

interface Props {
  channels: VoiceChannel[]
  clients: Client[]
  activeId: string
  selfId: string
  serverName: string
  serverMax: number
  serverIcon: string
  showIcons: boolean
  onCreate: () => void
  onJoin: (id: string) => void
  onSelectClient: (id: string) => void
  onRefresh: () => void
  refreshing?: boolean
}

const sections = [{ id: 'public', label: '公共频道' }] as const

export function ChannelSidebar({
  channels,
  clients,
  activeId,
  selfId,
  serverName,
  serverMax,
  serverIcon,
  showIcons,
  onCreate,
  onJoin,
  onSelectClient,
  onRefresh,
  refreshing = false,
}: Props) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const query = search.trim().toLowerCase()

  // 离线联系人会留在联系人列表里，但绝不能计入“在线人数”
  const onlineClients = useMemo(
    () => clients.filter((client) => client.presence !== 'offline'),
    [clients],
  )

  const occupiedChannels = useMemo(
    () =>
      channels.filter(
        (channel) =>
          channel.kind === 'voice' &&
          onlineClients.some((client) => client.channelId === channel.id),
      ).length,
    [channels, onlineClients],
  )

  const visibleChannels = useMemo(() => {
    if (!query) return channels
    const keep = new Set<string>()
    for (const channel of channels) {
      const nameHit = stripTsTags(channel.name).toLowerCase().includes(query)
      const memberHit = clients.some(
        (client) =>
          client.channelId === channel.id &&
          stripClientTags(client.name).toLowerCase().includes(query),
      )
      if (!nameHit && !memberHit) continue
      let cursor: VoiceChannel | undefined = channel
      while (cursor) {
        keep.add(cursor.id)
        const parentId: string | null = cursor.parentId
        cursor = parentId ? channels.find((item) => item.id === parentId) : undefined
      }
    }
    return channels.filter((channel) => keep.has(channel.id))
  }, [channels, clients, query])

  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: prev[id] === false ? true : false }))

  return (
    <aside className="sidebar">
      <div className="server-card" title={serverName}>
        <span className="server-logo">
          {serverIcon ? (
            <img src={serverIcon} alt="" draggable={false} />
          ) : (
            stripTsTags(serverName).slice(0, 1) || 'R'
          )}
        </span>
        <span className="server-meta">
          <span className="server-name">{stripTsTags(serverName) || '语音服务器'}</span>
          <span className="server-sub">
            {serverMax > 0
              ? `${onlineClients.length}/${serverMax}`
              : onlineClients.length}{' '}
            人在线 · {occupiedChannels} 个频道有人
          </span>
        </span>
      </div>

      <label className="search">
        <Search size={15} strokeWidth={2} />
        <input
          placeholder="搜索频道或成员"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search && (
          <button className="search-clear" title="清除" onClick={() => setSearch('')}>
            <X size={12} strokeWidth={2.4} />
          </button>
        )}
      </label>

      <div className="side-head">
        <span>语音频道</span>
        <div className="side-head-actions">
          <button
            className="icon-btn"
            title="刷新频道、成员与图标"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw size={15} strokeWidth={2} className={refreshing ? 'spin' : ''} />
          </button>
          <button className="icon-btn" title="新建频道" onClick={onCreate}>
            <Plus size={17} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="channel-scroll">
        {query && visibleChannels.length === 0 && (
          <div className="side-empty">没有匹配的频道或成员</div>
        )}

        {sections.map((section) => {
          const list = visibleChannels.filter((channel) => channel.section === section.id)
          if (list.length === 0) return null
          const online = onlineClients.filter((client) =>
            channels.some(
              (channel) =>
                channel.id === client.channelId &&
                channel.section === section.id,
            ),
          ).length
          return (
            <div className="channel-group" key={section.id}>
              <div className="side-section">
                <span>{section.label}</span>
                <em>{online}</em>
              </div>
              <ChannelTree
                section={section.id}
                channels={list}
                clients={clients}
                activeId={activeId}
                selfId={selfId}
                expanded={expanded}
                showIcons={showIcons}
                query={query}
                onToggle={toggle}
                onJoin={onJoin}
                onSelectClient={onSelectClient}
              />
            </div>
          )
        })}
      </div>

      <button className="create-channel" onClick={onCreate}>
        <Plus size={16} strokeWidth={2} />
        创建频道
      </button>
    </aside>
  )
}
