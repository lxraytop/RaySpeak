import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Ban,
  CircleUserRound,
  Copy,
  Hand,
  LogIn,
  MessageSquare,
  Radio,
  Search,
  Send,
  ShieldCheck,
  ShieldOff,
  Smile,
  UserPlus,
  WifiOff,
  X,
} from 'lucide-react'
import type { Client, DmMessage, VoiceChannel } from '../types'
import { emojiList, groupMap } from '../data/mock'
import { stripClientTags, stripTsTags } from '../utils/tsText'
import { Avatar } from './Avatar'
import { GroupChip } from './memberBits'
import { MessageText } from './MessageText'

interface Props {
  clients: Client[]
  self?: Client
  messages: DmMessage[]
  activeId: string | null
  blocked: string[]
  unread: Record<string, number>
  channels: VoiceChannel[]
  onSelect: (id: string) => void
  onSend: (text: string) => void
  onOpenProfile: (id: string) => void
  onInvite: (client: Client) => void
  onPoke: (client: Client) => void
  onBlock: (client: Client) => void
  onUnblock: (client: Client) => void
  onJoinChannel: (client: Client) => void
  onJumpVoice: () => void
  onToast: (message: string) => void
}

function GroupSection({ title, ids }: { title: string; ids: string[] }) {
  return (
    <div className="dm-group-block">
      <span className="dm-group-title">{title}</span>
      <div className="dm-group-list">
        {ids.map((id) => {
          const group = groupMap.get(id)
          if (!group) return null
          return (
            <span className="dm-group-pill" key={id}>
              <GroupChip id={id} size={17} />
              {group.name}
            </span>
          )
        })}
        {ids.length === 0 && <span className="profile-group-empty">未分配</span>}
      </div>
    </div>
  )
}

export function ContactsPage({
  clients,
  self,
  messages,
  activeId,
  blocked,
  unread,
  channels,
  onSelect,
  onSend,
  onOpenProfile,
  onInvite,
  onPoke,
  onBlock,
  onUnblock,
  onJoinChannel,
  onJumpVoice,
  onToast,
}: Props) {
  const [tab, setTab] = useState<'recent' | 'all'>(
    messages.length === 0 ? 'all' : 'recent',
  )
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const channelOf = (client: Client) =>
    client.channelId
      ? stripTsTags(channels.find((channel) => channel.id === client.channelId)?.name ?? '')
      : ''

  // 在线成员排在前面，离线（来自本地聊天记录）排在后面，避免状态混淆
  const contacts = useMemo(
    () =>
      clients
        .filter((client) => !client.self)
        .slice()
        .sort((a, b) => {
          const online = Number(b.presence !== 'offline') - Number(a.presence !== 'offline')
          if (online !== 0) return online
          return stripClientTags(a.name).localeCompare(stripClientTags(b.name), 'zh-Hans-CN')
        }),
    [clients],
  )
  const onlineCount = contacts.filter((client) => client.presence !== 'offline').length
  const active = contacts.find((client) => client.id === activeId) ?? null
  const activeMessages = messages.filter((message) => message.contactId === activeId)
  const isBlocked = active ? blocked.includes(active.id) : false
  const activeOnline = Boolean(active && active.presence !== 'offline')
  const activeChannelName = active ? channelOf(active) : ''
  const canJoinActive =
    Boolean(active && activeOnline && active.channelId) && active?.channelId !== self?.channelId

  const lastByContact = useMemo(() => {
    const map = new Map<string, DmMessage>()
    for (const message of messages) map.set(message.contactId, message)
    return map
  }, [messages])

  const recent = useMemo(
    () =>
      Array.from(lastByContact.entries())
        .sort((a, b) => b[1].time.localeCompare(a[1].time))
        .map(([id]) => contacts.find((client) => client.id === id))
        .filter((client): client is Client => Boolean(client)),
    [lastByContact, contacts],
  )

  const query = search.trim().toLowerCase()
  const list = (tab === 'recent' ? recent : contacts).filter(
    (client) => !query || stripClientTags(client.name).toLowerCase().includes(query),
  )

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeId, activeMessages.length])

  useEffect(() => {
    setEmojiOpen(false)
    setDraft('')
  }, [activeId])

  const submit = () => {
    const text = draft.trim()
    if (!text || !active || isBlocked) return
    if (!activeOnline) {
      onToast('对方不在线，TeamSpeak 不保存离线消息')
      return
    }
    onSend(text)
    setDraft('')
    inputRef.current?.focus()
  }

  const appendEmoji = (emoji: string) => {
    setDraft((value) => `${value}${emoji}`.slice(0, 500))
    inputRef.current?.focus()
  }

  const copyUid = async (client: Client) => {
    try {
      await navigator.clipboard.writeText(client.uid ?? client.id)
    } catch {
      /* clipboard unavailable */
    }
    onToast('唯一标识已复制')
  }

  return (
    <section className="contacts-page">
      <aside className="card dm-sidebar">
        <header className="dm-side-head">
          <div>
            <h2>私聊</h2>
            <span>{onlineCount} 人在线 · {recent.length} 个会话</span>
          </div>
          <span className="dm-head-icon"><MessageSquare size={16} strokeWidth={1.9} /></span>
        </header>

        <label className="search dm-search">
          <Search size={15} strokeWidth={2} />
          <input
            placeholder="搜索联系人"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search && (
            <button className="search-clear" title="清除" onClick={() => setSearch('')}>
              <X size={12} strokeWidth={2.4} />
            </button>
          )}
        </label>

        <div className="dm-tabs" role="tablist">
          <button
            className={tab === 'recent' ? 'active' : ''}
            role="tab"
            aria-selected={tab === 'recent'}
            onClick={() => setTab('recent')}
          >
            最近会话
          </button>
          <button
            className={tab === 'all' ? 'active' : ''}
            role="tab"
            aria-selected={tab === 'all'}
            onClick={() => setTab('all')}
          >
            全部联系人
          </button>
        </div>

        <div className="dm-list">
          {list.map((client) => {
            const last = lastByContact.get(client.id)
            const online = client.presence !== 'offline'
            const where = channelOf(client)
            return (
              <button
                key={client.id}
                className={`dm-row ${activeId === client.id ? 'active' : ''} ${
                  blocked.includes(client.id) ? 'is-blocked' : ''
                } ${online ? '' : 'is-offline'}`}
                onClick={() => onSelect(client.id)}
              >
                <span className="dm-row-avatar">
                  <Avatar
                    letter={client.letter}
                    hue={client.hue}
                    size={36}
                    src={client.avatarUrl}
                  />
                  <span className={`presence dm-presence ${client.presence}`} />
                </span>
                <span className="dm-row-body">
                  <span className="dm-row-top">
                    <strong>{stripClientTags(client.name)}</strong>
                    {online && where && <em className="dm-row-channel">{where}</em>}
                    {unread[client.id] ? (
                      <span className="dm-unread">
                        {unread[client.id] > 99 ? '99+' : unread[client.id]}
                      </span>
                    ) : (
                      last && <time>{last.time}</time>
                    )}
                  </span>
                  <span className="dm-row-preview">
                    {last
                      ? `${last.self ? '你：' : ''}${last.text}`
                      : online
                        ? '在线 · 点击开始私聊'
                        : client.connectedAt === '历史会话'
                          ? '离线 · 历史会话'
                          : `离线 · ${client.connectedAt}`}
                  </span>
                </span>
              </button>
            )
          })}
          {list.length === 0 && (
            <div className="dm-empty-list">
              <span>没有匹配的联系人</span>
              <small>换个关键词试试</small>
            </div>
          )}
        </div>

        <footer className="dm-side-foot">
          <ShieldCheck size={13} strokeWidth={1.9} />
          TeamSpeak 不保存离线消息，对方离线时消息无法送达
        </footer>
      </aside>

      <section className="card dm-main">
        {active ? (
          <>
            <header className="dm-head">
              <span className="dm-head-avatar">
                <Avatar letter={active.letter} hue={active.hue} size={38} src={active.avatarUrl} />
                <span className={`presence dm-presence ${active.presence}`} />
              </span>
              <div className="dm-head-id">
                <strong>{stripClientTags(active.name)}</strong>
                <span className={`dm-head-state ${active.presence}`}>
                  {activeOnline
                    ? activeChannelName
                      ? `在线 · ${activeChannelName}`
                      : '在线 · 未加入频道'
                    : active.connectedAt === '历史会话'
                      ? '离线 · 历史会话'
                      : `离线 · ${active.connectedAt}`}
                </span>
              </div>
              <div className="dm-head-actions">
                <button
                  className="dm-action"
                  title={
                    canJoinActive
                      ? `加入 ${stripClientTags(active.name)} 所在的频道`
                      : '对方不在频道中'
                  }
                  disabled={!canJoinActive}
                  onClick={() => onJoinChannel(active)}
                >
                  <LogIn size={16} strokeWidth={1.9} />
                </button>
                <button
                  className="dm-action"
                  title={activeOnline ? '邀请进服务器' : '对方不在线，无法发送邀请'}
                  disabled={!activeOnline}
                  onClick={() => onInvite(active)}
                >
                  <UserPlus size={16} strokeWidth={1.9} />
                </button>
                <button
                  className="dm-action"
                  title={activeOnline ? '戳一戳' : '对方不在线'}
                  disabled={!activeOnline}
                  onClick={() => onPoke(active)}
                >
                  <Hand size={16} strokeWidth={1.9} />
                </button>
                <button
                  className="dm-action"
                  title="查看资料"
                  onClick={() => onOpenProfile(active.id)}
                >
                  <CircleUserRound size={16} strokeWidth={1.9} />
                </button>
                <button className="dm-action" title="回到语音频道" onClick={onJumpVoice}>
                  <Radio size={16} strokeWidth={1.9} />
                </button>
              </div>
            </header>

            <div className="dm-list-scroll" ref={listRef}>
              <div className="dm-day">今天</div>
              {activeMessages.map((message) =>
                message.system ? (
                  <div className="dm-system" key={message.id}>
                    <span className="sys-dot" />
                    {message.text}
                  </div>
                ) : (
                  <div className={`msg ${message.self ? 'is-self' : ''}`} key={message.id}>
                    <span className="msg-avatar static">
                      <Avatar
                        letter={message.letter}
                        hue={message.hue}
                        size={28}
                        src={
                          message.self
                            ? self?.avatarUrl ?? message.avatarUrl
                            : active.avatarUrl ?? message.avatarUrl
                        }
                      />
                    </span>
                    <div className="msg-body">
                      <div className="msg-head">
                        <span className={`msg-author ${message.self ? 'is-self' : ''}`}>
                          {message.author}
                        </span>
                        {message.self && self?.serverGroups[0] && (
                          <GroupChip id={self.serverGroups[0]} size={13} />
                        )}
                        <span className="msg-time">{message.time}</span>
                      </div>
                      <p className="msg-text">
                        <MessageText text={message.text} />
                      </p>
                    </div>
                  </div>
                ),
              )}
              {activeMessages.length === 0 && (
                <div className="chat-empty dm-chat-empty">
                  <span>还没有私聊消息</span>
                  <small>和 {stripClientTags(active.name)} 打个招呼吧</small>
                </div>
              )}
            </div>

            {isBlocked && (
              <div className="dm-blocked">
                <Ban size={14} strokeWidth={2} />
                已屏蔽该联系人，解除后可继续发送消息
                <button className="small-btn ghost" onClick={() => onUnblock(active)}>
                  解除屏蔽
                </button>
              </div>
            )}

            {!isBlocked && !activeOnline && (
              <div className="dm-offline-note">
                <WifiOff size={14} strokeWidth={2} />
                对方当前不在服务器，TeamSpeak 无法投递离线消息；上方记录仅保存在本机。
              </div>
            )}

            {emojiOpen && (
              <div className="emoji-pop dm-emoji">
                <div className="emoji-pop-head">
                  <span>表情</span>
                  <button className="icon-btn" onClick={() => setEmojiOpen(false)} title="关闭">
                    <X size={14} strokeWidth={2.2} />
                  </button>
                </div>
                <div className="emoji-grid">
                  {emojiList.map((emoji) => (
                    <button key={emoji} onClick={() => appendEmoji(emoji)}>
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <form
              className={`composer ${isBlocked || !activeOnline ? 'disabled' : ''}`}
              onSubmit={(event) => {
                event.preventDefault()
                submit()
              }}
            >
              <button
                type="button"
                className={`composer-icon ${emojiOpen ? 'active' : ''}`}
                title="表情"
                disabled={isBlocked || !activeOnline}
                onClick={() => setEmojiOpen((value) => !value)}
              >
                <Smile size={17} strokeWidth={1.9} />
              </button>
              <input
                ref={inputRef}
                value={draft}
                disabled={isBlocked || !activeOnline}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  isBlocked
                    ? '已屏蔽该联系人'
                    : activeOnline
                      ? `发送私聊消息给 ${stripClientTags(active.name)}`
                      : '对方不在线，无法发送私聊消息'
                }
                maxLength={500}
              />
              <span className="dm-privacy">
                <ShieldCheck size={11} strokeWidth={2} /> 仅双方可见
              </span>
              <button
                type="submit"
                className="send-btn"
                disabled={isBlocked || !activeOnline || !draft.trim()}
              >
                <Send size={14} strokeWidth={2} />
                发送
              </button>
            </form>
          </>
        ) : (
          <div className="dm-placeholder">
            <span className="dm-placeholder-icon">
              <MessageSquare size={26} strokeWidth={1.6} />
            </span>
            <strong>选择一位联系人开始私聊</strong>
            <span>私聊消息通过 tsclient-rs 的私聊目标转发，服务器不保存离线消息。</span>
          </div>
        )}
      </section>

      <aside className="card dm-profile">
        {active ? (
          <>
            <div
              className="dm-profile-cover"
              style={{ ['--h' as string]: active.hue }}
            />
            <div className="dm-profile-top">
              <span className="dm-profile-avatar">
                <Avatar letter={active.letter} hue={active.hue} size={58} src={active.avatarUrl} />
                <span className={`presence dm-presence lg ${active.presence}`} />
              </span>
              <div>
                <strong>{stripClientTags(active.name)}</strong>
                <span className={activeOnline ? 'dm-presence-chip online' : 'dm-presence-chip offline'}>
                  {activeOnline ? '在线' : '离线'}
                </span>
              </div>
            </div>
            <p className="dm-profile-desc">{active.description}</p>

            <div className="dm-profile-groups">
              <GroupSection title="服务器组" ids={active.serverGroups} />
              <GroupSection title="频道组" ids={active.channelGroups} />
            </div>

            <div className="dm-profile-meta">
              <div>
                <span>当前频道</span>
                <strong>
                  {activeOnline
                    ? activeChannelName || '未加入频道'
                    : '不在服务器'}
                </strong>
              </div>
              <div>
                <span>平台</span>
                <strong>{active.platform ?? '未知'}</strong>
              </div>
              <div>
                <span>客户端</span>
                <strong>{active.version ?? 'TeamSpeak'}</strong>
              </div>
              <div>
                <span>数据库 ID</span>
                <strong>{active.dbId ?? '—'}</strong>
              </div>
            </div>

            <div className="dm-profile-actions">
              <button
                className="primary-btn"
                disabled={!canJoinActive}
                title={canJoinActive ? '加入对方所在频道' : '对方不在频道中'}
                onClick={() => onJoinChannel(active)}
              >
                <LogIn size={14} strokeWidth={2} />
                加入 TA 的频道
              </button>
              <button
                className="ghost-btn"
                disabled={!activeOnline}
                onClick={() => onInvite(active)}
              >
                <UserPlus size={14} strokeWidth={2} />
                邀请进服务器
              </button>
              <button className="ghost-btn" disabled={!activeOnline} onClick={() => onPoke(active)}>
                <Hand size={14} strokeWidth={2} />
                戳一戳
              </button>
              <button className="ghost-btn" onClick={() => copyUid(active)}>
                <Copy size={14} strokeWidth={2} />
                复制 UID
              </button>
              <button
                className={`ghost-btn ${isBlocked ? '' : 'danger'}`}
                onClick={() => (isBlocked ? onUnblock(active) : onBlock(active))}
              >
                {isBlocked ? (
                  <ShieldCheck size={14} strokeWidth={2} />
                ) : (
                  <ShieldOff size={14} strokeWidth={2} />
                )}
                {isBlocked ? '解除屏蔽' : '屏蔽联系人'}
              </button>
            </div>
          </>
        ) : (
          <div className="dm-profile-empty">
            <CircleUserRound size={24} strokeWidth={1.6} />
            <span>联系人资料</span>
          </div>
        )}
      </aside>
    </section>
  )
}
