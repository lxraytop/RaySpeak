import { useState } from 'react'
import {
  ArrowRight,
  FolderUp,
  Loader2,
  LockKeyhole,
  MessagesSquare,
  ShieldCheck,
  Wifi,
  Zap,
} from 'lucide-react'

interface Props {
  connecting: boolean
  error: string | null
  initialNickname: string
  onConnect: (nickname: string, password: string) => void
}

const features = [
  { icon: Wifi, title: '低延迟语音', text: 'Opus 编解码，按频道自动切换码率' },
  { icon: MessagesSquare, title: '频道与私聊', text: '服务器消息、频道消息与一对一私聊' },
  { icon: FolderUp, title: '频道文件', text: '直接上传与下载频道文件' },
]

export function LoginScreen({ connecting, error, initialNickname, onConnect }: Props) {
  const [nickname, setNickname] = useState(initialNickname)
  const [password, setPassword] = useState('')
  const canSubmit = nickname.trim().length > 0 && !connecting

  return (
    <div className="login-screen">
      <div className="login-aurora" aria-hidden="true" />
      <div className="login-grid" aria-hidden="true" />

      <section className="login-hero">
        <div className="login-brand">
          <span className="login-logo">
            <img src="/logo.png" alt="" draggable={false} />
          </span>
          <span>
            <strong>RaySpeak</strong>
            <em>TeamSpeak 兼容语音客户端</em>
          </span>
        </div>
        <h1>
          和你的队伍
          <br />
          随时开聊
        </h1>
        <p className="login-lead">
          自带加密握手、频道图标、成员权限与文件传输。输入昵称和访问密码即可加入。
        </p>
        <ul className="login-features">
          {features.map(({ icon: Icon, title, text }) => (
            <li key={title}>
              <span className="login-feature-icon">
                <Icon size={17} strokeWidth={1.9} />
              </span>
              <span>
                <strong>{title}</strong>
                <em>{text}</em>
              </span>
            </li>
          ))}
        </ul>
        <div className="login-legal">
          <ShieldCheck size={14} strokeWidth={1.9} />
          ECDH + AES 加密握手 · 身份密钥保存在本机
        </div>
      </section>

      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit) onConnect(nickname.trim(), password)
        }}
      >
        <header>
          <span className="login-lock">
            <LockKeyhole size={18} strokeWidth={1.9} />
          </span>
          <span>
            <h2>进入服务器</h2>
            <p>输入昵称即可进入，需要密码时再填写</p>
          </span>
        </header>

        <label className="login-field">
          <span>昵称</span>
          <input
            autoFocus
            value={nickname}
            maxLength={30}
            disabled={connecting}
            placeholder="服务器里显示的名字"
            autoComplete="nickname"
            onChange={(event) => setNickname(event.target.value)}
          />
        </label>

        <label className="login-field">
          <span>服务器密码（可留空）</span>
          <input
            type="password"
            value={password}
            disabled={connecting}
            placeholder="服务器未设置密码可留空"
            autoComplete="off"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}

        <button type="submit" className="login-submit" disabled={!canSubmit}>
          {connecting ? (
            <>
              <Loader2 size={17} strokeWidth={2} className="spin" />
              正在建立加密连接…
            </>
          ) : (
            <>
              进入语音
              <ArrowRight size={17} strokeWidth={2.1} />
            </>
          )}
        </button>

        <p className="login-note">
          <Zap size={13} strokeWidth={2} />
          密码留空将以无密码方式连接；密码不会被保存或写入日志
        </p>
      </form>
    </div>
  )
}
