import { useEffect, useRef, useState } from 'react'
import { Activity, Send, Smile, X } from 'lucide-react'
import type { ChatMessage, SystemLine, VoiceChannel } from '../types'
import { emojiList } from '../data/mock'
import { renderTsText } from '../utils/tsText'
import { Avatar } from './Avatar'
import { GroupChip } from './memberBits'
import { MessageText } from './MessageText'

interface Props {
  channel: VoiceChannel
  messages: ChatMessage[]
  system: SystemLine[]
  selfGroups: string[]
  onSend: (text: string) => void
  onMore: () => void
  onSelectClient: (id: string) => void
}

export function ChatPanel({
  channel,
  messages,
  system,
  selfGroups,
  onSend,
  onMore,
  onSelectClient,
}: Props) {
  const [draft, setDraft] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [channel.id, messages.length])

  useEffect(() => {
    setEmojiOpen(false)
    setDraft('')
  }, [channel.id])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
    inputRef.current?.focus()
  }

  const appendEmoji = (emoji: string) => {
    setDraft((value) => `${value}${emoji}`.slice(0, 500))
    inputRef.current?.focus()
  }

  return (
    <section className="card chat-card">
      <div className="card-head chat-head">
        <div className="card-title">
          房间消息
          <span className="card-hint">仅本房间可见</span>
        </div>
        <div className="card-tools">
          <span className="chat-topic">#{renderTsText(channel.name)}</span>
          <button className="icon-btn" title="频道动态" onClick={onMore}>
            <Activity size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="chat-list" ref={listRef}>
        {messages.map((message) => (
          <div className={`msg ${message.self ? 'is-self' : ''}`} key={message.id}>
            <button
              className="msg-avatar"
              title={`${message.author} 的资料`}
              onClick={() => onSelectClient(message.clientId)}
            >
              <Avatar letter={message.letter} hue={message.hue} size={28} src={message.avatarUrl} />
            </button>
            <div className="msg-body">
              <div className="msg-head">
                <span className={`msg-author ${message.self ? 'is-self' : ''}`}>
                  {message.author}
                </span>
                {message.self && selfGroups[0] && <GroupChip id={selfGroups[0]} size={13} />}
                <span className="msg-time">{message.time}</span>
              </div>
              <p className="msg-text">
                <MessageText text={message.text} />
              </p>
            </div>
          </div>
        ))}

        {messages.length === 0 && (
          <div className="chat-empty">
            <span>这里还没有消息</span>
            <small>在下方输入，和房间里的朋友打个招呼</small>
          </div>
        )}

        {system.map((line) => (
          <div className="sys-msg" key={line.id}>
            <span className="sys-dot" />
            {line.text}
            {line.strong && <strong>{line.strong}</strong>}
          </div>
        ))}
      </div>

      {emojiOpen && (
        <div className="emoji-pop">
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
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <button
          type="button"
          className={`composer-icon ${emojiOpen ? 'active' : ''}`}
          title="表情"
          onClick={() => setEmojiOpen((value) => !value)}
        >
          <Smile size={17} strokeWidth={1.9} />
        </button>
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`发送消息到 ${channel.name.replace(/\[[^\]]+\]/g, '')}，Enter 发送`}
          maxLength={500}
        />
        <span className="composer-count">{draft.length > 0 ? `${draft.length}/500` : ''}</span>
        <button type="submit" className="send-btn" disabled={!draft.trim()}>
          <Send size={14} strokeWidth={2} />
          发送
        </button>
      </form>
    </section>
  )
}
