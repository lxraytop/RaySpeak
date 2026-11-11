import type { CSSProperties } from 'react'
import {
  ArrowRightLeft,
  Ban,
  Copy,
  Hand,
  ImagePlus,
  MessageSquare,
  Mic,
  Radio,
  ShieldAlert,
  Trash2,
  UserMinus,
  UserPlus,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { Client } from '../types'
import { groupMap } from '../data/mock'
import { stripTsTags } from '../utils/tsText'
import { Avatar } from './Avatar'
import { GroupChip, VolumeControl, clientStateText } from './memberBits'
import { Modal } from './Modal'

interface Props {
  client: Client
  channelName: string
  onClose: () => void
  onVolume: (volume: number) => void
  onToggleLocalMute: () => void
  onInvite: () => void
  onDm: () => void
  onBlock: () => void
  onPoke: () => void
  onMove: () => void
  onKick: () => void
  onBan: () => void
  onCopyUid: () => void
  onSetAvatar?: () => void
  onRemoveAvatar?: () => void
  hasAvatar?: boolean
  canModerate: boolean
  blocked: boolean
}

function GroupSection({ title, ids }: { title: string; ids: string[] }) {
  return (
    <div className="profile-group-block">
      <span className="profile-group-title">{title}</span>
      <div className="profile-group-list">
        {ids.map((id) => {
          const group = groupMap.get(id)
          if (!group) return null
          return (
            <span className="profile-group-pill" key={id}>
              <GroupChip id={id} size={18} />
              <span>{group.name}</span>
              {typeof group.power === 'number' && <em>{group.power}</em>}
            </span>
          )
        })}
        {ids.length === 0 && <span className="profile-group-empty">未分配</span>}
      </div>
    </div>
  )
}

export function ProfileModal({
  client,
  channelName,
  onClose,
  onVolume,
  onToggleLocalMute,
  onInvite,
  onDm,
  onBlock,
  onPoke,
  onMove,
  onKick,
  onBan,
  onCopyUid,
  onSetAvatar,
  onRemoveAvatar,
  hasAvatar = false,
  canModerate,
  blocked,
}: Props) {
  const coverStyle = {
    '--h': client.hue,
  } as CSSProperties

  return (
    <Modal onClose={onClose} wide>
      <div className="profile-cover" style={coverStyle}>
        <button className="profile-close" onClick={onClose} title="关闭">
          ×
        </button>
        <span className="profile-cover-glow" />
      </div>

      <div className="profile-body">
        <div className={`profile-avatar ${client.talking ? 'speaking' : ''}`}>
          <Avatar letter={client.letter} hue={client.hue} size={72} src={client.avatarUrl} />
          <span className={`presence lg ${client.presence}`} />
        </div>

        <div className="profile-id">
          <h2>
            {client.name}
            {client.self && <em className="mc-you">你</em>}
          </h2>
          <span className={`profile-state ${client.talking ? 'live' : ''}`}>
            {clientStateText(client)} · {client.device === 'mobile' ? '手机端' : '桌面端'}
          </span>
        </div>

        <p className={`profile-desc ${client.description ? '' : 'empty'}`}>
          {client.description || '未填写个人简介'}
        </p>

        <div className="profile-volume">
          <span className="profile-volume-label">
            <Volume2 size={14} strokeWidth={2} />
            我对 {client.name} 的收音音量
          </span>
          <VolumeControl
            value={client.volume}
            muted={client.localMuted}
            onChange={onVolume}
            onToggleMute={onToggleLocalMute}
          />
        </div>

        <div className="profile-groups">
          <GroupSection title="服务器组" ids={client.serverGroups} />
          <GroupSection title="频道组" ids={client.channelGroups} />
        </div>

        <div className="profile-meta">
          <div>
            <span>当前频道</span>
            <strong>
              <Radio size={12} strokeWidth={2} />
              {stripTsTags(channelName)}
            </strong>
          </div>
          <div>
            <span>连接时间</span>
            <strong>{client.connectedAt}</strong>
          </div>
          <div>
            <span>麦克风</span>
            <strong>{client.micMuted ? '已静音' : '开启'}</strong>
          </div>
          <div>
            <span>扬声器</span>
            <strong>{client.outputMuted ? '已关闭' : '开启'}</strong>
          </div>
          <div>
            <span>平台</span>
            <strong>{client.platform ?? '未知'}</strong>
          </div>
          <div>
            <span>客户端</span>
            <strong>{client.version ?? 'TeamSpeak'}</strong>
          </div>
          <div>
            <span>数据库 ID</span>
            <strong>{client.dbId ?? '—'}</strong>
          </div>
          <div>
            <span>唯一标识</span>
            <strong className="profile-uid" title={client.uid}>
              {client.uid ?? '—'}
            </strong>
          </div>
        </div>

        {!client.self && (
          <>
            <div className="profile-actions">
              <button className="profile-btn primary" onClick={onDm}>
                <MessageSquare size={15} strokeWidth={2} />
                私聊
              </button>
              <button className="profile-btn" onClick={onInvite}>
                <UserPlus size={15} strokeWidth={2} />
                邀请到我的频道
              </button>
              <button className="profile-btn" onClick={onPoke}>
                <Hand size={15} strokeWidth={2} />
                戳一戳
              </button>
              <button
                className={`profile-btn ${client.localMuted ? 'active' : ''}`}
                onClick={onToggleLocalMute}
              >
                {client.localMuted ? (
                  <VolumeX size={15} strokeWidth={2} />
                ) : (
                  <Volume2 size={15} strokeWidth={2} />
                )}
                {client.localMuted ? '取消本地静音' : '本地静音'}
              </button>
              <button className="profile-btn" onClick={onMove} disabled={!canModerate}>
                <ArrowRightLeft size={15} strokeWidth={2} />
                移动频道
              </button>
              <button className="profile-btn" onClick={onCopyUid}>
                <Copy size={15} strokeWidth={2} />
                复制 UID
              </button>
              <button className="profile-btn" onClick={onBlock}>
                <Ban size={15} strokeWidth={2} />
                {blocked ? '解除屏蔽' : '屏蔽'}
              </button>
            </div>

            <div className="profile-danger-row">
              <span className="profile-danger-title">
                <ShieldAlert size={13} strokeWidth={2} />
                管理操作
                {!canModerate && <em>需要服务器管理员权限</em>}
              </span>
              <div>
                <button className="profile-btn" onClick={onKick} disabled={!canModerate}>
                  <UserMinus size={14} strokeWidth={2} />
                  踢出服务器
                </button>
                <button className="profile-btn danger" onClick={onBan} disabled={!canModerate}>
                  <Ban size={14} strokeWidth={2} />
                  封禁
                </button>
              </div>
            </div>
          </>
        )}

        {client.self && (
          <div className="profile-actions">
            <button className="profile-btn primary" onClick={onDm}>
              <Mic size={15} strokeWidth={2} />
              麦克风设置
            </button>
            <button className="profile-btn" onClick={onSetAvatar}>
              <ImagePlus size={15} strokeWidth={2} />
              设置头像
            </button>
            <button className="profile-btn" onClick={onRemoveAvatar} disabled={!hasAvatar}>
              <Trash2 size={15} strokeWidth={2} />
              删除头像
            </button>
            <button className="profile-btn" onClick={onCopyUid}>
              <Copy size={15} strokeWidth={2} />
              复制我的 UID
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
