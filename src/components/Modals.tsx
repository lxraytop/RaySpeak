import { useState } from 'react'
import { Check, Copy, Link2, Lock, Send, ShieldCheck } from 'lucide-react'
import type { SystemLine, VoiceChannel } from '../types'
import { stripTsTags } from '../utils/tsText'
import { rayInviteLink } from './MessageText'
import { Modal } from './Modal'

export function InviteModal({
  channel,
  contact,
  onClose,
  onCopy,
  onSend,
}: {
  channel: VoiceChannel
  contact?: string | null
  onClose: () => void
  onCopy: () => void
  onSend?: (message: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const name = stripTsTags(channel.name)
  const code = rayInviteLink(channel.id, name)
  const message = `我在 RaySpeak 的「${name}」频道等你，点击链接直接加入：${code}`

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true)
    onCopy()
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <Modal
      title={contact ? `邀请 ${contact}` : '邀请成员'}
      subtitle={
        contact
          ? `把邀请码发给 ${contact}，邀请加入「${name}」`
          : `把「${name}」的邀请码发给朋友`
      }
      onClose={onClose}
    >
      <div className="invite-link">
        <Link2 size={16} strokeWidth={1.9} />
        <span>{code}</span>
        <button className="small-btn" onClick={() => copy(message)}>
          {copied ? <Check size={14} strokeWidth={2.2} /> : <Copy size={14} strokeWidth={1.9} />}
          {copied ? '已复制' : '复制邀请'}
        </button>
      </div>

      <div className="invite-tips">
        <ShieldCheck size={15} strokeWidth={1.9} />
        <span>
          {contact
            ? `点击“发送私聊邀请”会通过 TeamSpeak 私聊发送 ray:// 链接，对方点击后自动打开并加入频道。`
            : '复制 ray:// 邀请链接发给朋友，对方点击后会自动打开 RaySpeak 并加入频道。服务器地址不会出现在链接中。'}
        </span>
      </div>

      {contact && onSend && (
        <div className="invite-actions">
          <button className="primary-btn" onClick={() => onSend(message)}>
            <Send size={14} strokeWidth={2} />
            发送私聊邀请
          </button>
        </div>
      )}
    </Modal>
  )
}

export function ChannelEventsModal({
  channelName,
  lines,
  onClose,
}: {
  channelName: string
  lines: SystemLine[]
  onClose: () => void
}) {
  const visible = lines.slice(-60).reverse()
  return (
    <Modal title="频道动态" subtitle={`${channelName} · 成员进出与系统事件`} onClose={onClose}>
      <div className="event-list">
        {visible.map((line) => (
          <div className="event-row" key={line.id}>
            <span className="sys-dot" />
            <span>{line.text}</span>
          </div>
        ))}
        {visible.length === 0 && <div className="chat-empty">还没有频道动态。</div>}
      </div>
    </Modal>
  )
}

export function PasswordModal({
  channel,
  error,
  busy = false,
  onClose,
  onSubmit,
}: {
  channel: VoiceChannel
  error?: string | null
  busy?: boolean
  onClose: () => void
  onSubmit: (password: string) => void
}) {
  const [password, setPassword] = useState('')
  const blocked = busy || !password.trim()

  return (
    <Modal
      title="频道已加锁"
      subtitle={`加入「${stripTsTags(channel.name)}」需要输入频道密码`}
      onClose={onClose}
    >
      <form
        className="password-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (blocked) return
          onSubmit(password)
        }}
      >
        <label className={`password-input ${error ? 'has-error' : ''}`}>
          <Lock size={15} strokeWidth={1.9} />
          <input
            autoFocus
            type="password"
            value={password}
            maxLength={64}
            placeholder="频道密码"
            aria-invalid={Boolean(error)}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? (
          <p className="modal-error">{error}</p>
        ) : (
          <p className="modal-tip">当前频道已加密，密码只会用于本次加入请求。</p>
        )}
        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-btn" disabled={blocked}>
            {busy ? '正在加入…' : error ? '重试加入' : '加入频道'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
