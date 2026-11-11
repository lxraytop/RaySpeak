import { Activity, RefreshCw, Users } from 'lucide-react'
import type { Client } from '../types'
import { MemberCard } from './MemberCard'

interface Props {
  members: Client[]
  limit: number
  onOpenProfile: (id: string) => void
  onVolume: (id: string, volume: number) => void
  onToggleLocalMute: (id: string) => void
  onQueue: () => void
  onRefresh: () => void
}

export function MemberGrid({
  members,
  limit,
  onOpenProfile,
  onVolume,
  onToggleLocalMute,
  onQueue,
  onRefresh,
}: Props) {
  return (
    <section className="card members-card">
      <div className="card-head">
        <div className="card-title">
          <Users size={15} strokeWidth={1.9} className="card-title-icon" />
          房间成员
          <span className="count-badge">{members.length}</span>
          <span className="card-hint">
            {limit > 0 ? `上限 ${limit} 人` : '无人数上限'}
          </span>
        </div>
        <div className="card-tools">
          <button className="pill-btn" onClick={onQueue}>
            <Activity size={13} strokeWidth={2} />
            频道动态
          </button>
          <button className="icon-btn" title="刷新成员" onClick={onRefresh}>
            <RefreshCw size={15} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="member-grid">
        {members.map((member) => (
          <MemberCard
            key={member.id}
            client={member}
            variant="grid"
            onOpen={onOpenProfile}
            onVolume={onVolume}
            onToggleLocalMute={onToggleLocalMute}
          />
        ))}

        {members.length === 0 && (
          <div className="empty-room">
            <span>频道里还没有人</span>
            <small>拉上朋友一起进来吧</small>
          </div>
        )}
      </div>
    </section>
  )
}

export function MemberPanel({
  members,
  limit,
  onOpenProfile,
  onVolume,
  onToggleLocalMute,
  onQueue,
  onRefresh,
}: Props) {
  return (
    <section className="card member-panel">
      <div className="card-head">
        <div className="card-title">
          <Users size={15} strokeWidth={1.9} className="card-title-icon" />
          房间成员
          <span className="count-badge">{members.length}</span>
        </div>
        <div className="card-tools">
          <button className="icon-btn" title="频道动态" onClick={onQueue}>
            <Activity size={16} strokeWidth={2} />
          </button>
          <button className="icon-btn" title="刷新成员" onClick={onRefresh}>
            <RefreshCw size={15} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="member-list">
        {members.map((member) => (
          <MemberCard
            key={member.id}
            client={member}
            variant="panel"
            onOpen={onOpenProfile}
            onVolume={onVolume}
            onToggleLocalMute={onToggleLocalMute}
          />
        ))}

        {members.length === 0 && (
          <div className="empty-room">
            <span>频道里还没有人</span>
            <small>拉上朋友一起进来吧</small>
          </div>
        )}
      </div>

      <footer className="member-panel-foot">
        <span>{limit > 0 ? `可容纳 ${limit} 人` : '无人数上限'}</span>
        <span className="member-panel-hint">点击卡片查看资料 · 拖动滑块调整收音</span>
      </footer>
    </section>
  )
}
