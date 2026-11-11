import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  Download,
  FileText,
  Image as ImageIcon,
  MonitorUp,
  Music2,
  Radio,
  ShieldAlert,
  Trash2,
  UploadCloud,
  Video,
  Volume2,
} from 'lucide-react'
import type { Client, FileItem, VoiceChannel } from '../types'
import { stripTsTags } from '../utils/tsText'
import { channelIconUrl } from '../utils/icons'
import { Modal } from './Modal'

export function ConfirmModal({
  title,
  subtitle,
  message,
  confirmLabel = '确认',
  danger,
  onConfirm,
  onClose,
}: {
  title: string
  subtitle?: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <div className="confirm-body">
        <span className={`confirm-icon ${danger ? 'danger' : ''}`}>
          {danger ? <ShieldAlert size={20} strokeWidth={1.9} /> : <AlertTriangle size={20} strokeWidth={1.9} />}
        </span>
        <p>{message}</p>
      </div>
      <div className="modal-actions">
        <button className="ghost-btn" onClick={onClose}>
          取消
        </button>
        <button
          className={danger ? 'danger-btn' : 'primary-btn'}
          onClick={() => {
            onConfirm()
            onClose()
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

export function MoveClientModal({
  client,
  channels,
  memberCount,
  onMove,
  onClose,
}: {
  client: Client
  channels: VoiceChannel[]
  memberCount: (id: string) => number
  onMove: (channelId: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const list = channels.filter(
    (channel) =>
      channel.kind === 'voice' &&
      stripTsTags(channel.name).toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <Modal
      title="移动到频道"
      subtitle={`把 ${stripTsTags(client.name)} 移动到其他语音频道`}
      onClose={onClose}
      wide
    >
      <label className="search modal-search">
        <span className="modal-search-icon">⌕</span>
        <input
          autoFocus
          value={query}
          placeholder="搜索频道"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="move-list">
        {list.map((channel) => {
          const here = channel.id === client.channelId
          return (
            <button
              key={channel.id}
              className={`move-row ${here ? 'current' : ''}`}
              disabled={here}
              onClick={() => {
                onMove(channel.id)
                onClose()
              }}
            >
              <span className="move-icon">
                {channelIconUrl(channel.iconId) ? (
                  <img src={channelIconUrl(channel.iconId)} alt="" />
                ) : (
                  <Volume2 size={14} strokeWidth={2} />
                )}
              </span>
              <span className="move-name">
                <strong>{stripTsTags(channel.name)}</strong>
                <em>
                  {channel.codec} · {channel.bitrate} kbps
                </em>
              </span>
              <span className="move-count">{memberCount(channel.id)} 人</span>
              {here && <span className="move-here">当前</span>}
            </button>
          )
        })}
        {list.length === 0 && <div className="chat-empty">没有匹配的频道。</div>}
      </div>
    </Modal>
  )
}

export type ChannelDraft = {
  name: string
  description: string
  parentId: string | null
  maxClients: number
  codec: string
  bitrate: number
  password: string
}

export function CreateChannelModal({
  channels,
  onCreate,
  onClose,
}: {
  channels: VoiceChannel[]
  onCreate: (draft: ChannelDraft) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [parentId, setParentId] = useState('')
  const [maxClients, setMaxClients] = useState(32)
  const [codec, setCodec] = useState('Opus')
  const [bitrate, setBitrate] = useState(64)
  const [passwordEnabled, setPasswordEnabled] = useState(false)
  const [password, setPassword] = useState('')

  const parents = channels.filter((channel) => channel.kind === 'voice')

  return (
    <Modal
      title="创建频道"
      subtitle="创建永久频道，成功后会立即加入"
      onClose={onClose}
      wide
    >
      <form
        className="channel-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!name.trim()) return
          if (passwordEnabled && !password.trim()) return
          onCreate({
            name: name.trim(),
            description: description.trim(),
            parentId: parentId || null,
            maxClients,
            codec,
            bitrate,
            password: passwordEnabled ? password.trim() : '',
          })
        }}
      >
        <div className="form-grid">
          <label className="form-field span-2">
            <span>频道名称</span>
            <input
              autoFocus
              className="text-input"
              value={name}
              maxLength={40}
              placeholder="例如：周末开黑"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="form-field span-2">
            <span>频道描述</span>
            <input
              className="text-input"
              value={description}
              maxLength={120}
              placeholder="可选，会显示在房间信息中"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>父频道</span>
            <div className="select-wrap">
              <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                <option value="">无（顶层频道）</option>
                {parents.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {stripTsTags(channel.name)}
                  </option>
                ))}
              </select>
            </div>
          </label>
          <label className="form-field">
            <span>人数上限</span>
            <input
              className="text-input number"
              type="number"
              min={1}
              max={512}
              value={maxClients}
              onChange={(event) => setMaxClients(Number(event.target.value))}
            />
          </label>
          <label className="form-field">
            <span>编解码</span>
            <div className="select-wrap">
              <select value={codec} onChange={(event) => setCodec(event.target.value)}>
                <option value="Opus">Opus</option>
                <option value="Opus Music">Opus Music</option>
              </select>
            </div>
          </label>
          <label className="form-field span-2">
            <span>码率 · {bitrate} kbps</span>
            <input
              type="range"
              className="form-range"
              min={16}
              max={128}
              step={8}
              value={bitrate}
              onChange={(event) => setBitrate(Number(event.target.value))}
            />
          </label>
        </div>
        <label className="form-check">
          <input
            type="checkbox"
            checked={passwordEnabled}
            onChange={(event) => setPasswordEnabled(event.target.checked)}
          />
          <span>设置频道密码（加入时需要验证）</span>
        </label>
        {passwordEnabled && (
          <label className="form-field">
            <span>频道密码</span>
            <input
              className="text-input"
              value={password}
              maxLength={32}
              placeholder="输入加入频道所需的密码"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="primary-btn"
            disabled={!name.trim() || (passwordEnabled && !password.trim())}
          >
            创建并加入
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function RoomSettingsModal({
  channel,
  channels,
  memberCount,
  canManage,
  onSave,
  onDelete,
  onClose,
}: {
  channel: VoiceChannel
  channels: VoiceChannel[]
  memberCount: number
  canManage: boolean
  onSave: (patch: Partial<VoiceChannel>, password: string | null) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(channel.name)
  const [description, setDescription] = useState(channel.description ?? '')
  const [maxClients, setMaxClients] = useState(channel.maxClients ?? 32)
  const [codec, setCodec] = useState(channel.codec)
  const [bitrate, setBitrate] = useState(channel.bitrate)
  const [passwordEnabled, setPasswordEnabled] = useState(Boolean(channel.password))
  const [newPassword, setNewPassword] = useState('')
  const [parentId, setParentId] = useState(channel.parentId ?? '')
  const parents = channels.filter(
    (item) => item.kind === 'voice' && item.id !== channel.id,
  )
  const passwordInvalid =
    passwordEnabled && !channel.password && !newPassword.trim()

  return (
    <Modal
      title="房间设置"
      subtitle={`${stripTsTags(channel.name)} · 修改会通过原始命令提交到服务器`}
      onClose={onClose}
      wide
    >
      <form
        className="channel-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!name.trim() || !canManage || passwordInvalid) return
          let password: string | null = null
          if (newPassword.trim()) password = newPassword.trim()
          else if (channel.password && !passwordEnabled) password = ''
          onSave(
            {
              name: name.trim(),
              description: description.trim(),
              maxClients,
              codec,
              bitrate,
              password: passwordEnabled,
              parentId: parentId || null,
            },
            password,
          )
          onClose()
        }}
      >
        <div className="room-meta-strip">
          <span>频道 ID <code>{channel.id}</code></span>
          <span>图标 ID <code>{channel.iconId ?? '无'}</code></span>
          <span>成员 <code>{memberCount}/{maxClients}</code></span>
        </div>

        <div className="form-grid">
          <label className="form-field span-2">
            <span>频道名称</span>
            <input
              className="text-input"
              value={name}
              maxLength={40}
              disabled={!canManage}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="form-field span-2">
            <span>频道描述</span>
            <input
              className="text-input"
              value={description}
              maxLength={120}
              disabled={!canManage}
              placeholder="显示在房间信息中"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>父频道</span>
            <div className="select-wrap">
              <select
                value={parentId}
                disabled={!canManage || channel.id === 'hall'}
                onChange={(event) => setParentId(event.target.value)}
              >
                <option value="">无（顶层频道）</option>
                {parents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {stripTsTags(item.name)}
                  </option>
                ))}
              </select>
            </div>
          </label>
          <label className="form-field">
            <span>人数上限</span>
            <input
              className="text-input number"
              type="number"
              min={1}
              max={512}
              value={maxClients}
              disabled={!canManage}
              onChange={(event) => setMaxClients(Number(event.target.value))}
            />
          </label>
          <label className="form-field">
            <span>编解码</span>
            <div className="select-wrap">
              <select
                value={codec}
                disabled={!canManage}
                onChange={(event) => setCodec(event.target.value)}
              >
                <option value="Opus">Opus</option>
                <option value="Opus Music">Opus Music</option>
              </select>
            </div>
          </label>
          <label className="form-field">
            <span>码率 · {bitrate} kbps</span>
            <input
              type="range"
              className="form-range"
              min={16}
              max={128}
              step={8}
              value={bitrate}
              disabled={!canManage}
              onChange={(event) => setBitrate(Number(event.target.value))}
            />
          </label>
        </div>

        <label className="form-check">
          <input
            type="checkbox"
            checked={passwordEnabled}
            disabled={!canManage}
            onChange={(event) => setPasswordEnabled(event.target.checked)}
          />
          <span>
            频道需要密码
            {channel.password ? '（当前已设置，留空则保持不变）' : ''}
          </span>
        </label>

        {passwordEnabled && (
          <label className="form-field">
            <span>{channel.password ? '设置新密码（可选）' : '频道密码'}</span>
            <input
              className="text-input"
              value={newPassword}
              maxLength={32}
              disabled={!canManage}
              placeholder={channel.password ? '留空保持当前密码' : '输入加入频道所需的密码'}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
        )}
        {passwordInvalid && <p className="set-note">请输入频道密码后再保存。</p>}

        {!canManage && (
          <p className="set-note">当前账号没有管理频道的权限，字段只读。</p>
        )}

        <div className="modal-actions split">
          <button
            type="button"
            className="danger-btn ghost"
            disabled={channel.id === 'hall' || !canManage}
            onClick={onDelete}
          >
            <Trash2 size={14} strokeWidth={2} />
            删除频道
          </button>
          <div className="modal-actions-right">
            <button type="button" className="ghost-btn" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="primary-btn" disabled={!canManage || !name.trim() || passwordInvalid}>
              保存修改
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

function fileIcon(kind: FileItem['kind']) {
  if (kind === 'image') return <ImageIcon size={17} strokeWidth={1.8} />
  if (kind === 'audio') return <Music2 size={17} strokeWidth={1.8} />
  if (kind === 'video') return <Video size={17} strokeWidth={1.8} />
  if (kind === 'archive') return <Archive size={17} strokeWidth={1.8} />
  return <FileText size={17} strokeWidth={1.8} />
}

export function FilePanelModal({
  channel,
  files,
  canUpload,
  onUpload,
  onDownload,
  onDelete,
  onClose,
}: {
  channel: VoiceChannel
  files: FileItem[]
  canUpload: boolean
  onUpload: () => void
  onDownload: (file: FileItem) => void
  onDelete: (file: FileItem) => void
  onClose: () => void
}) {
  return (
    <Modal
      title="频道文件"
      subtitle={`${stripTsTags(channel.name)} · TeamSpeak 文件传输`}
      onClose={onClose}
      wide
    >
      <button
        className={`file-drop ${canUpload ? '' : 'disabled'}`}
        disabled={!canUpload}
        onClick={onUpload}
      >
        <span className="file-drop-icon">
          <UploadCloud size={22} strokeWidth={1.7} />
        </span>
        <span>
          <strong>{canUpload ? '上传文件到当前频道' : '文件传输已在设置中关闭'}</strong>
          <em>选择本地文件后直接上传到服务器</em>
        </span>
      </button>

      <div className="file-list">
        <div className="file-list-head">
          <span>文件</span>
          <span>{files.length} 个</span>
        </div>
        {files.map((file) => (
          <div className="file-row" key={file.id}>
            <span className={`file-kind ${file.kind}`}>{fileIcon(file.kind)}</span>
            <div className="file-copy">
              <strong>{file.name}</strong>
              <span>
                {file.size} · {file.uploader} · {file.time}
              </span>
            </div>
            <button className="icon-btn" title="下载" onClick={() => onDownload(file)}>
              <Download size={15} strokeWidth={2} />
            </button>
            <button className="icon-btn danger" title="删除" onClick={() => onDelete(file)}>
              <Trash2 size={15} strokeWidth={2} />
            </button>
          </div>
        ))}
        {files.length === 0 && (
          <div className="file-empty">
            <FileText size={20} strokeWidth={1.6} />
            <span>这个频道还没有文件</span>
          </div>
        )}
      </div>
    </Modal>
  )
}

export function ScreenShareModal({
  channel,
  sharing,
  mock,
  stream,
  onStart,
  onStop,
  onClose,
  onToast,
}: {
  channel: VoiceChannel
  sharing: boolean
  mock: boolean
  stream: MediaStream | null
  onStart: (stream: MediaStream | null, mock: boolean) => void
  onStop: () => void
  onClose: () => void
  onToast: (message: string) => void
}) {
  const [quality, setQuality] = useState<'720p' | '1080p'>('1080p')
  const [fps, setFps] = useState<30 | 60>(30)
  const [withAudio, setWithAudio] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream
  }, [stream, sharing])

  const start = async () => {
    try {
      const next = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: fps },
        audio: withAudio,
      })
      onStart(next, false)
      onToast('屏幕共享已开始（本地预览，语音频道不受影响）')
      next.getVideoTracks()[0]?.addEventListener('ended', onStop)
    } catch {
      onStart(null, true)
      onToast('已进入演示共享画面（未获取到屏幕源）')
    }
  }

  return (
    <Modal
      title="屏幕共享"
      subtitle={`${stripTsTags(channel.name)} · TS6 信令由 tsclient-rs 插件命令承载`}
      onClose={onClose}
      wide
    >
      <div className={`share-stage ${sharing ? 'live' : ''} ${mock ? 'mock' : ''}`}>
        {sharing && !mock ? (
          <video ref={videoRef} autoPlay muted playsInline className="share-video" />
        ) : (
          <div className="share-preview">
            <span className="share-orb one" />
            <span className="share-orb two" />
            <span className="share-preview-window">
              <i />
              <i />
              <i />
            </span>
            <div className="share-preview-copy">
              <MonitorUp size={22} strokeWidth={1.7} />
              <strong>{sharing ? '本地共享预览' : '共享你的屏幕'}</strong>
              <span>
                {sharing
                  ? 'TeamSpeak 协议不传输视频，当前画面只在本机预览'
                  : '开始后可以在本机预览采集画面，不会发送到频道'}
              </span>
            </div>
          </div>
        )}
        {sharing && (
          <span className="share-live-pill">
            <span className="share-dot" /> 本地预览 · {quality} · {fps}fps
          </span>
        )}
      </div>

      <div className="share-controls">
        <div className="share-control-block">
          <span>分辨率</span>
          <div className="share-seg">
            {(['720p', '1080p'] as const).map((value) => (
              <button
                key={value}
                className={quality === value ? 'active' : ''}
                disabled={sharing}
                onClick={() => setQuality(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <div className="share-control-block">
          <span>帧率</span>
          <div className="share-seg">
            {([30, 60] as const).map((value) => (
              <button
                key={value}
                className={fps === value ? 'active' : ''}
                disabled={sharing}
                onClick={() => setFps(value)}
              >
                {value} fps
              </button>
            ))}
          </div>
        </div>
        <label className="share-toggle">
          <input
            type="checkbox"
            checked={withAudio}
            disabled={sharing}
            onChange={(event) => setWithAudio(event.target.checked)}
          />
          <span>共享系统声音</span>
        </label>
      </div>

      <div className="share-meta">
        <div>
          <span>传输方式</span>
          <strong><Radio size={12} strokeWidth={2} /> 仅本地预览</strong>
        </div>
        <div>
          <span>视频协议</span>
          <strong><MonitorUp size={12} strokeWidth={2} /> TeamSpeak 不支持</strong>
        </div>
        <div>
          <span>观看人数</span>
          <strong>{sharing ? '仅本机' : '—'}</strong>
        </div>
      </div>

      <div className="modal-actions">
        <button className="ghost-btn" onClick={onClose}>
          关闭
        </button>
        {sharing ? (
          <button className="danger-btn" onClick={onStop}>
            <Trash2 size={14} strokeWidth={2} />
            停止共享
          </button>
        ) : (
          <button className="primary-btn" onClick={start}>
            <MonitorUp size={14} strokeWidth={2} />
            开始共享
          </button>
        )}
      </div>
    </Modal>
  )
}
