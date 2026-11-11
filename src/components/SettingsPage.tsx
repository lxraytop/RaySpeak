import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  AudioLines,
  Bell,
  Check,
  CircleUserRound,
  Columns2,
  Copy,
  Info,
  Keyboard,
  LayoutGrid,
  LockKeyhole,
  Monitor,
  Moon,
  Palette,
  Play,
  Plus,
  RotateCcw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import type { Client } from '../types'
import {
  accentPresets,
  backgroundPresets,
  defaultSettings,
  isDark,
  safeImage,
  type Settings,
} from '../settings'
import { groupMap } from '../data/mock'
import { protocol, errorText, pickSavePath } from '../protocol'
import {
  ensureNotifyPermission,
  playNotifyTone,
  showDesktopNotification,
} from '../notify'
import { stripClientTags } from '../utils/tsText'
import { clearLocalStore } from '../utils/localStore'
import {
  HotkeyInput,
  Segmented,
  Select,
  SetCard,
  SettingRow,
  Slider,
  Switch,
  TextInput,
} from './ui'

export type SettingsSection =
  | 'account'
  | 'audio'
  | 'appearance'
  | 'hotkeys'
  | 'notify'
  | 'privacy'
  | 'advanced'
  | 'about'

interface Props {
  settings: Settings
  clients: Client[]
  section: SettingsSection
  connected: boolean
  latency: number
  permissions: string[]
  demoMode: boolean
  onSection: (section: SettingsSection) => void
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
  onClose: () => void
  onToast: (message: string) => void
}

const navItems: Array<{
  id: SettingsSection
  label: string
  desc: string
  icon: typeof CircleUserRound
}> = [
  { id: 'account', label: '我的账号', desc: '昵称、身份与在线状态', icon: CircleUserRound },
  { id: 'audio', label: '语音与音频', desc: '设备、处理与编码质量', icon: AudioLines },
  { id: 'appearance', label: '外观', desc: '主题、布局与背景', icon: Palette },
  { id: 'hotkeys', label: '快捷键', desc: '按键说话与应用内热键', icon: Keyboard },
  { id: 'notify', label: '通知', desc: '桌面提醒与勿扰模式', icon: Bell },
  { id: 'privacy', label: '隐私与安全', desc: '身份级别、屏蔽与在线状态', icon: ShieldCheck },
  { id: 'advanced', label: '网络与高级', desc: '连接、文件传输与诊断', icon: SlidersHorizontal },
  { id: 'about', label: '关于 RaySpeak', desc: '版本、技术栈与协议规划', icon: Info },
]

const protocolRows = [
  ['连接与身份', 'ECDH / RSA 谜题 / EAX 加密，身份导入导出，SRV·TSDNS', '内核已支持'],
  ['频道目录', '频道树、父子关系、icon_id、密码/人数/编解码、描述', '内核已支持'],
  ['成员与状态', '在线列表、静音/离开/频道指挥、服务器组名称、事件流', '内核已支持'],
  ['文字消息', '私聊 / 频道 / 服务器消息，Unicode 与事件回调', '内核已支持'],
  ['语音收发', 'Opus 原始包收发（codec 4/5），说话状态可由收包推导', '内核已支持'],
  ['文件与图标', '上传 / 下载 / 删除，频道、服务器组与虚拟服务器图标（明文 TCP）', '内核已支持'],
  ['服务器管理', '踢人/封禁/移动/频道创建编辑删除/自身资料已封装，其余走原始命令', '内核已支持'],
  ['频道组与资料', '频道组、客户端描述、平台与数据库 ID 通过 clientinfo 查询', '内核已支持'],
  ['音频处理', 'WebCodecs Opus、抖动缓冲、AEC/降噪、VAD、立体声与音乐模式', '内核已支持'],
  ['屏幕共享', '仅有插件命令与 WebRTC 信令通道，媒体传输需自建；当前仅本地预览', '需应用层'],
  ['ServerQuery', '内核不使用 10011 查询端口，管理命令走客户端连接', '内核不提供'],
  ['好友与头像', 'TS 协议无好友在线态与服务器头像，只能本地存储或生成', '内核不提供'],
] as const

const permissionChecks = [
  ['移动成员', ['i_client_move_power']],
  ['踢出成员', ['i_client_kick_power']],
  ['封禁成员', ['i_client_ban_power']],
  ['创建与编辑频道', ['b_channel_create_permanent', 'i_channel_create_modify_with_codec_opusvoice']],
  ['上传频道文件', ['b_filetransfer_upload']],
  ['删除频道', ['i_channel_delete_power', 'b_channel_delete_flag_force']],
] as const

const hotkeyRows = [
  ['ptt', '按键说话'],
  ['mute', '切换麦克风静音'],
  ['deafen', '切换扬声器闭麦'],
  ['settings', '打开设置'],
  ['disconnect', '断开语音连接'],
  ['layout', '切换房间布局'],
] as const

function AboutRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="about-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export function SettingsPage({
  settings,
  clients,
  section,
  connected,
  latency,
  permissions,
  demoMode,
  onSection,
  onChange,
  onReset,
  onClose,
  onToast,
}: Props) {
  const [testing, setTesting] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceNote, setDeviceNote] = useState(
    '点击「刷新设备」授予麦克风权限后可显示完整设备名称',
  )
  const [appInfo, setAppInfo] = useState<{ version: string; dataDir: string } | null>(null)

  useEffect(() => {
    if (demoMode) return
    protocol
      .getAppInfo()
      .then(setAppInfo)
      .catch(() => {})
  }, [demoMode])

  const enumerateDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceNote('当前系统不支持音频设备枚举')
      return
    }
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices(list)
      if (list.length > 0 && list.every((device) => !device.label)) {
        setDeviceNote('设备名称需要授予麦克风权限后才会显示')
      } else {
        setDeviceNote(`已找到 ${list.filter((d) => d.kind !== 'videoinput').length} 个音频设备`)
      }
    } catch {
      setDeviceNote('无法读取音频设备列表')
    }
  }, [])

  useEffect(() => {
    if (section !== 'audio') return
    void enumerateDevices()
    const handler = () => void enumerateDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', handler)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handler)
  }, [section, enumerateDevices])

  const refreshDevices = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
    } catch {
      onToast('麦克风权限被拒绝，仅能显示默认设备')
    }
    await enumerateDevices()
  }

  useEffect(() => {
    if (!testing) {
      setMicLevel(0)
      return
    }
    let disposed = false
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let frame = 0
    const run = async () => {
      try {
        const constraints: MediaStreamConstraints = {
          audio: settings.inputDevice
            ? {
                deviceId: { exact: settings.inputDevice },
                echoCancellation: settings.echoCancel,
                noiseSuppression: settings.noiseSuppress,
                autoGainControl: settings.autoGain,
              }
            : {
                echoCancellation: settings.echoCancel,
                noiseSuppression: settings.noiseSuppress,
                autoGainControl: settings.autoGain,
              },
          video: false,
        }
        stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        context = new AudioContext()
        const source = context.createMediaStreamSource(stream)
        const gain = context.createGain()
        gain.gain.value = Math.max(0, Math.min(2, settings.inputVolume / 100))
        const analyser = context.createAnalyser()
        analyser.fftSize = 512
        source.connect(gain)
        gain.connect(analyser)
        const data = new Uint8Array(analyser.fftSize)
        const tick = () => {
          if (disposed) return
          analyser.getByteTimeDomainData(data)
          let energy = 0
          for (let index = 0; index < data.length; index += 1) {
            const value = (data[index] - 128) / 128
            energy += value * value
          }
          setMicLevel(Math.min(1, Math.sqrt(energy / data.length) * 3))
          frame = requestAnimationFrame(tick)
        }
        tick()
      } catch {
        onToast('无法打开麦克风，请检查设备与系统权限')
        setTesting(false)
      }
    }
    void run()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((track) => track.stop())
      if (context) void context.close()
    }
  }, [
    testing,
    settings.inputDevice,
    settings.inputVolume,
    settings.echoCancel,
    settings.noiseSuppress,
    settings.autoGain,
    onToast,
  ])

  const deviceOptions = (kind: MediaDeviceKind) => {
    const inputs = devices
      .filter((device) => device.kind === kind)
      .map((device, index) => ({
        value: device.deviceId,
        label: device.label || `${kind === 'audioinput' ? '麦克风' : '扬声器'} ${index + 1}`,
      }))
    return [{ value: '', label: '系统默认' }, ...inputs]
  }

  const inputOptions = deviceOptions('audioinput')
  if (settings.inputDevice && !inputOptions.some((item) => item.value === settings.inputDevice)) {
    inputOptions.push({ value: settings.inputDevice, label: '已保存的麦克风' })
  }
  const outputOptions = deviceOptions('audiooutput')
  if (
    settings.outputDevice &&
    !outputOptions.some((item) => item.value === settings.outputDevice)
  ) {
    outputOptions.push({ value: settings.outputDevice, label: '已保存的扬声器' })
  }

  const testNotification = async () => {
    if (settings.notifySound) playNotifyTone(settings.notifyTone)
    const granted = await showDesktopNotification(
      'RaySpeak',
      '这是一条测试通知，桌面提醒工作正常。',
    )
    if (!granted) {
      onToast('系统通知权限未授予，已播放本地提示音')
      return
    }
    onToast('测试通知已发送')
  }

  const copyDiagnostics = async () => {
    const payload = {
      app: `RaySpeak ${appInfo?.version ?? '0.2.0'}`,
      dataDir: appInfo?.dataDir ?? 'unknown',
      connected,
      latency,
      clients: clients.length,
      permissions: permissions.length,
      microphone: settings.inputDevice || 'system-default',
      speaker: settings.outputDevice || 'system-default',
      platform: navigator.userAgent,
      time: new Date().toISOString(),
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      onToast('诊断信息已复制')
    } catch {
      onToast('剪贴板不可用')
    }
  }

  const active = navItems.find((item) => item.id === section) ?? navItems[0]
  const dark = isDark(settings.theme)
  const themeLabel = { light: '浅色', dark: '深色', system: '跟随系统' }[settings.theme]
  const layoutLabel = settings.layout === 'cards' ? '成员卡片' : '网格式'
  const densityLabel = { compact: '紧凑', cozy: '舒适', spacious: '宽松' }[settings.density]
  const accentName =
    accentPresets.find((preset) => preset.value.toLowerCase() === settings.accent.toLowerCase())
      ?.name ?? '自定义'
  const customBackground = safeImage(settings.backgroundImage)
  const blocked = settings.blocked
    .map((id) => clients.find((client) => client.id === id))
    .filter((client): client is Client => Boolean(client))

  const copyIdentity = async () => {
    let identity = ''
    try {
      identity = await protocol.getIdentity()
    } catch {
      identity = 'rayspeak:identity-unavailable'
    }
    try {
      await navigator.clipboard.writeText(identity)
    } catch {
      /* clipboard unavailable */
    }
    onToast(demoMode ? '演示模式：未连接服务器，身份不可用' : '身份字符串已复制')
  }

  const exportIdentity = async () => {
    const destination = await pickSavePath('rayspeak-identity.dat')
    if (!destination) return
    try {
      await protocol.exportIdentity(destination)
      onToast('身份文件已导出')
    } catch (error) {
      onToast(demoMode ? '身份导出仅在桌面应用连接后可用' : errorText(error))
    }
  }

  const syncIdentity = () => {
    if (demoMode) {
      onToast('演示模式：昵称未同步')
      return
    }
    protocol
      .updateSelf(settings.nickname.trim(), settings.description || null)
      .then(() => onToast('昵称与描述已同步到服务器'))
      .catch((error) => onToast(errorText(error)))
  }

  const selfClient = clients.find((client) => client.self)
  const selfGroups = selfClient?.serverGroups.filter((id) => groupMap.has(id)) ?? []
  const identityShort = selfClient?.uid
    ? `${selfClient.uid.slice(0, 18)}…`
    : '连接后生成'

  const permissionRows = permissionChecks.map(([label, names]) => {
    const granted = demoMode
      ? true
      : names.some((name) => permissions.includes(name))
    return [label, granted ? 'granted' : 'denied'] as const
  })

  return (
    <div className="settings-screen">
      <aside className="settings-nav">
        <div className="settings-nav-head">
          <span className="settings-logo">
            <img src="/logo.png" alt="" draggable={false} />
          </span>
          <div>
            <strong>设置</strong>
            <span>所有修改即时生效</span>
          </div>
          <button className="icon-btn" title="返回语音界面" onClick={onClose}>
            <X size={16} strokeWidth={2.2} />
          </button>
        </div>

        <nav className="settings-nav-list">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={`settings-nav-item ${item.id === section ? 'active' : ''}`}
                onClick={() => onSection(item.id)}
              >
                <Icon size={17} strokeWidth={1.9} />
                <span>
                  <strong>{item.label}</strong>
                  <em>{item.desc}</em>
                </span>
              </button>
            )
          })}
        </nav>

        <footer className="settings-nav-foot">
          <span className="version-pill">
            v{appInfo?.version ?? '0.2.0'} · 协议接入
          </span>
          <span>协议内核 tsclient-rs</span>
        </footer>
      </aside>

      <div className="settings-main">
        <header className="settings-main-head">
          <div>
            <h1>{active.label}</h1>
            <p>{active.desc}</p>
          </div>
          <div className="settings-head-actions">
            <span className="autosave">
              <Check size={12} strokeWidth={2.6} />
              自动保存到本机
            </span>
            <button className="ghost-btn" onClick={onClose}>
              返回语音
            </button>
          </div>
        </header>

        <div className="settings-scroll">
          {section === 'account' && (
            <>
              <SetCard
                title="个人资料"
                desc="展示在频道成员列表与用户资料卡中；可在资料卡或右键菜单设置头像，未设置时显示昵称首字"
              >
                <div className="account-hero">
                  <span className="account-avatar">
                    {selfClient?.avatarUrl ? (
                      <img src={selfClient.avatarUrl} alt="" draggable={false} />
                    ) : (
                      settings.nickname.slice(0, 1) || 'R'
                    )}
                  </span>
                  <div className="account-copy">
                    <strong>{settings.nickname || '未命名'}</strong>
                    <span>{settings.description || '还没有填写个人描述'}</span>
                  </div>
                </div>
                <SettingRow title="昵称" desc="最多 30 个字符，支持 TeamSpeak 格式文本">
                  <TextInput
                    value={settings.nickname}
                    maxLength={30}
                    placeholder="输入昵称"
                    onChange={(value) => onChange({ nickname: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="个人描述"
                  desc="显示在资料卡片的简介区域，连接后会自动同步到服务器，无需手动保存"
                  vertical
                >
                  <textarea
                    className="text-area"
                    value={settings.description}
                    maxLength={200}
                    placeholder="介绍一下自己"
                    onChange={(event) => onChange({ description: event.target.value })}
                  />
                </SettingRow>
                <p className="set-note">
                  昵称与个人描述会在停止输入约 1 秒后自动同步到服务器，其他成员通过资料卡即可看到；
                  未连接时修改只保存在本机。
                </p>
              </SetCard>

              <SetCard title="身份与安全" desc="TeamSpeak 使用身份密钥对识别用户，等级越高越难被冒充">
                <div className="identity-box">
                  <div>
                    <span>服务器</span>
                    <code>已固定配置</code>
                  </div>
                  <div>
                    <span>身份标识</span>
                    <code>{identityShort}</code>
                  </div>
                  <span className="identity-badge">
                    <LockKeyhole size={12} strokeWidth={2.2} />
                    已加密
                  </span>
                </div>
                <SettingRow
                  title="身份安全级别"
                  desc="当前身份由应用在首次启动时生成并保存在本机"
                >
                  <span className="status-chip online">10 级</span>
                </SettingRow>
                <div className="inline-actions">
                  <button className="small-btn" onClick={copyIdentity}>
                    <Copy size={13} strokeWidth={2} />
                    复制身份
                  </button>
                  <button className="small-btn ghost" onClick={exportIdentity}>
                    导出身份文件
                  </button>
                  <button className="small-btn ghost" onClick={syncIdentity}>
                    同步到服务器
                  </button>
                </div>
              </SetCard>

              <SetCard title="连接状态" desc="数据来自当前服务器会话">
                <SettingRow title="语音连接" desc="Opus 48kHz · UDP · WebView2 麦克风采集">
                  <span className={`status-chip ${connected ? 'online' : 'unsupported'}`}>
                    {connected ? `已连接 · ${latency}ms` : '未连接'}
                  </span>
                </SettingRow>
                <SettingRow title="服务器组" desc="你在本服务器中拥有的服务器组">
                  <span className="inline-chips">
                    {selfGroups.length === 0 && <span className="set-note">暂无可见服务器组</span>}
                    {selfGroups.map((id) => (
                      <span className="mini-group" key={id}>
                        {groupMap.get(id)?.name}
                      </span>
                    ))}
                  </span>
                </SettingRow>
              </SetCard>

              <SetCard
                title="服务器权限"
                desc="对应 tsclient-rs 的 permission_value / permissionlist，管理按钮据此启用或禁用"
              >
                <div className="perm-list">
                  {permissionRows.map(([label, state]) => (
                    <div className="perm-row" key={label}>
                      <span>{label}</span>
                      <span
                        className={`status-chip ${
                          state === 'granted' ? 'online' : 'unsupported'
                        }`}
                      >
                        {state === 'granted' ? '已授予' : '未授予'}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="set-note">
                  最终操作仍由服务器校验；连接后会用 permissionlist 返回的真实权限 id 刷新此列表。
                </p>
              </SetCard>
            </>
          )}

          {section === 'audio' && (
            <>
              <SetCard title="设备" desc="读取系统音频设备，切换后立即重连采集">
                <SettingRow title="麦克风" desc="用于语音采集，浏览器将请求设备权限">
                  <Select
                    value={settings.inputDevice}
                    options={inputOptions}
                    onChange={(value) => onChange({ inputDevice: value })}
                  />
                </SettingRow>
                <SettingRow title="扬声器" desc="语音播放设备，切换后立即生效">
                  <Select
                    value={settings.outputDevice}
                    options={outputOptions}
                    onChange={(value) => onChange({ outputDevice: value })}
                  />
                </SettingRow>
                <div className="inline-actions">
                  <button className="small-btn" onClick={() => void refreshDevices()}>
                    <RotateCcw size={13} strokeWidth={2} />
                    刷新设备
                  </button>
                  <span className="set-note">{deviceNote}</span>
                </div>
              </SetCard>

              <SetCard title="音量" desc="输入增益对应 getUserMedia 采集，输出音量影响所有远端语音">
                <SettingRow title="麦克风增益" desc="过高的增益会引入底噪">
                  <Slider
                    value={settings.inputVolume}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(value) => onChange({ inputVolume: value })}
                  />
                </SettingRow>
                <div className={`mic-meter ${testing ? 'real' : ''}`} aria-hidden="true">
                  {Array.from({ length: 24 }).map((_, index) => (
                    <i
                      key={index}
                      style={
                        testing
                          ? {
                              height: `${
                                4 +
                                micLevel *
                                  26 *
                                  (0.45 + 0.55 * Math.abs(Math.sin(index * 1.3)))
                              }px`,
                              opacity: micLevel * 24 > index ? 1 : 0.16,
                            }
                          : undefined
                      }
                    />
                  ))}
                  <button className="mic-test" onClick={() => setTesting((value) => !value)}>
                    <Play size={12} strokeWidth={2.2} />
                    {testing ? '停止测试' : '测试麦克风'}
                  </button>
                </div>
                <p className="set-note">
                  {testing
                    ? '正在显示当前麦克风的实时电平，松开按钮停止。'
                    : '点击测试可直接打开所选麦克风并查看实时电平。'}
                </p>
                <SettingRow title="扬声器音量" desc="仅影响本机播放，不改变他人音量">
                  <Slider
                    value={settings.outputVolume}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(value) => onChange({ outputVolume: value })}
                  />
                </SettingRow>
              </SetCard>

              <SetCard title="输入方式" desc="VAD 自动检测人声，PTT 按下按键才发送">
                <SettingRow title="模式">
                  <Segmented
                    value={settings.inputMode}
                    options={[
                      { value: 'vad', label: '自动检测' },
                      { value: 'ptt', label: '按键说话' },
                    ]}
                    onChange={(value) => onChange({ inputMode: value })}
                  />
                </SettingRow>
                {settings.inputMode === 'vad' ? (
                  <SettingRow title="触发阈值" desc="低于阈值的环境音将被忽略，单位 dBFS">
                    <Slider
                      value={settings.vadThreshold}
                      min={-60}
                      max={-10}
                      step={1}
                      suffix=" dB"
                      onChange={(value) => onChange({ vadThreshold: value })}
                    />
                  </SettingRow>
                ) : (
                  <SettingRow title="按键" desc="按住该键时发送语音，松开停止">
                    <HotkeyInput
                      value={settings.hotkeys.ptt}
                      onChange={(value) =>
                        onChange({ hotkeys: { ...settings.hotkeys, ptt: value } })
                      }
                    />
                  </SettingRow>
                )}
              </SetCard>

              <SetCard title="语音处理" desc="WebView2 采集参数，可显著改善回声与键盘噪声">
                <SettingRow title="回声消除" desc="扬声器外放时抑制回流">
                  <Switch
                    checked={settings.echoCancel}
                    onChange={(value) => onChange({ echoCancel: value })}
                  />
                </SettingRow>
                <SettingRow title="噪声抑制" desc="压低风扇、键盘与空调噪声">
                  <Switch
                    checked={settings.noiseSuppress}
                    onChange={(value) => onChange({ noiseSuppress: value })}
                  />
                </SettingRow>
                <SettingRow title="自动增益" desc="自动拉平音量差异">
                  <Switch
                    checked={settings.autoGain}
                    onChange={(value) => onChange({ autoGain: value })}
                  />
                </SettingRow>
              </SetCard>

              <SetCard title="编码质量" desc="对应 Opus 编码器参数，音乐模式将启用立体声">
                <SettingRow title="音乐模式" desc="高码率、立体声，适合放歌或看片">
                  <Switch
                    checked={settings.musicMode}
                    onChange={(value) => onChange({ musicMode: value })}
                  />
                </SettingRow>
                <SettingRow title="语音码率" desc="上行带宽占用，频道上限以服务器为准">
                  <Slider
                    value={settings.bitrate}
                    min={16}
                    max={128}
                    step={8}
                    suffix=" kbps"
                    onChange={(value) => onChange({ bitrate: value })}
                  />
                </SettingRow>
                <SettingRow title="帧长" desc="更短的帧降低延迟，但增加带宽">
                  <Segmented
                    value={String(settings.frameSize)}
                    options={[
                      { value: '10', label: '10 ms' },
                      { value: '20', label: '20 ms' },
                      { value: '40', label: '40 ms' },
                      { value: '60', label: '60 ms' },
                    ]}
                    onChange={(value) => onChange({ frameSize: Number(value) })}
                  />
                </SettingRow>
                <SettingRow title="立体声" desc="仅音乐模式推荐开启">
                  <Switch
                    checked={settings.stereo}
                    onChange={(value) => onChange({ stereo: value })}
                  />
                </SettingRow>
                <SettingRow title="抖动缓冲" desc="网络波动大时增大缓冲以减少断音">
                  <Slider
                    value={settings.jitterBuffer}
                    min={20}
                    max={200}
                    step={10}
                    suffix=" ms"
                    onChange={(value) => onChange({ jitterBuffer: value })}
                  />
                </SettingRow>
                <SettingRow title="延迟策略" desc="低延迟优先 / 均衡 / 稳定优先">
                  <Segmented
                    value={settings.latencyMode}
                    options={[
                      { value: 'low', label: '低延迟' },
                      { value: 'balanced', label: '均衡' },
                      { value: 'stable', label: '稳定' },
                    ]}
                    onChange={(value) => onChange({ latencyMode: value })}
                  />
                </SettingRow>
              </SetCard>
            </>
          )}

          {section === 'appearance' && (
            <>
              <section className={`appearance-hero layout-${settings.layout}`}>
                <div className="mini-app" aria-hidden="true">
                  <div className="ma-bar">
                    <span className="ma-logo">
                      <img src="/logo.png" alt="" draggable={false} />
                    </span>
                    <em>RaySpeak</em>
                    <span className="ma-live" />
                    <span className="ma-win" />
                  </div>
                  <div className="ma-body">
                    <div className="ma-rail">
                      <span className="ma-rail-item active" />
                      <span className="ma-rail-item" />
                      <span className="ma-rail-item" />
                    </div>
                    <div className="ma-side">
                      <span className="ma-server" />
                      <span className="ma-search" />
                      <span className="ma-ch active"><i /><b /></span>
                      <span className="ma-ch"><i /><b /></span>
                      <span className="ma-ch indent"><i /><b /></span>
                      <span className="ma-ch"><i /><b /></span>
                      <span className="ma-ch"><i /><b /></span>
                    </div>
                    <div className="ma-room">
                      <div className="ma-room-head"><i /><b /><span /></div>
                      <div className="ma-layout">
                        <div className="ma-members">
                          <span className="ma-member speaking"><i /><b /></span>
                          <span className="ma-member"><i /><b /></span>
                          <span className="ma-member"><i /><b /></span>
                        </div>
                        <div className="ma-chat">
                          <span className="ma-msg"><i /><b /><b className="short" /></span>
                          <span className="ma-msg self"><i /><b /></span>
                          <span className="ma-msg"><i /><b /><b className="short" /></span>
                          <span className="ma-composer" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="ah-copy">
                  <span className="ah-kicker"><Sparkles size={12} strokeWidth={2.2} /> 实时预览</span>
                  <h2>把客户端调成你的样子</h2>
                  <p>主题、强调色、圆角、密度与背景会即时作用于整个界面，所有修改仅保存在本机。</p>
                  <div className="ah-tags">
                    <span>主题 · {themeLabel}</span>
                    <span>布局 · {layoutLabel}</span>
                    <span>密度 · {densityLabel}</span>
                    <span>圆角 · {settings.radius}px</span>
                  </div>
                </div>
              </section>

              <SetCard title="主题" desc="浅色、深色或跟随系统，强调色贯穿按钮与选中态">
                <div className="theme-options">
                  {([
                    { id: 'light', label: '浅色', hint: '明亮清爽', icon: Sun },
                    { id: 'dark', label: '深色', hint: '夜间护眼', icon: Moon },
                    { id: 'system', label: '跟随系统', hint: '自动切换', icon: Monitor },
                  ] as const).map(({ id, label, hint, icon: Icon }) => (
                    <button
                      key={id}
                      className={`theme-option ${settings.theme === id ? 'active' : ''}`}
                      onClick={() => onChange({ theme: id })}
                    >
                      <span className={`theme-thumb ${id}`}>
                        <i className="tt-rail" />
                        <i className="tt-panel" />
                        <i className="tt-dot" />
                      </span>
                      <span className="theme-meta">
                        <strong><Icon size={12} strokeWidth={2} /> {label}</strong>
                        <em>{hint}</em>
                      </span>
                      {settings.theme === id && (
                        <span className="theme-check"><Check size={11} strokeWidth={3} /></span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="accent-block">
                  <div className="accent-head">
                    <div>
                      <strong>强调色</strong>
                      <span>当前为「{accentName}」，点击色块即时切换</span>
                    </div>
                    <code>{settings.accent.toUpperCase()}</code>
                  </div>
                  <div className="accent-grid">
                    {accentPresets.map((preset) => (
                      <button
                        key={preset.value}
                        className={`accent-swatch ${
                          settings.accent.toLowerCase() === preset.value.toLowerCase() ? 'active' : ''
                        }`}
                        style={{ background: preset.value }}
                        title={preset.name}
                        aria-label={preset.name}
                        onClick={() => onChange({ accent: preset.value })}
                      >
                        {settings.accent.toLowerCase() === preset.value.toLowerCase() && (
                          <Check size={12} strokeWidth={3} />
                        )}
                      </button>
                    ))}
                    <label className="accent-swatch custom" title="自定义颜色">
                      <Plus size={12} strokeWidth={2.6} />
                      <input
                        type="color"
                        value={settings.accent}
                        onChange={(event) => onChange({ accent: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
              </SetCard>

              <SetCard title="布局" desc="房间成员区块的两种排布，可在房间头部随时切换">
                <div className="layout-preview">
                  <button
                    className={`layout-option ${settings.layout === 'cards' ? 'active' : ''}`}
                    onClick={() => onChange({ layout: 'cards' })}
                  >
                    <span className="layout-thumb cards">
                      <i className="lt-rail" />
                      <span className="lt-side">
                        <b /><b className="speaking" /><b />
                      </span>
                      <span className="lt-main">
                        <b className="lt-title" />
                        <b className="lt-line" />
                        <b className="lt-bubble self" />
                        <b className="lt-line short" />
                      </span>
                    </span>
                    <span className="layout-meta">
                      <strong>左侧成员栏</strong>
                      <em>卡片 + 大聊天区</em>
                    </span>
                    {settings.layout === 'cards' && (
                      <span className="layout-check"><Check size={11} strokeWidth={3} /></span>
                    )}
                  </button>
                  <button
                    className={`layout-option ${settings.layout === 'grid' ? 'active' : ''}`}
                    onClick={() => onChange({ layout: 'grid' })}
                  >
                    <span className="layout-thumb grid">
                      <i className="lt-rail" />
                      <span className="lt-main">
                        <span className="lt-cards">
                          <b /><b className="speaking" /><b /><b />
                        </span>
                        <b className="lt-line" />
                        <b className="lt-bubble self" />
                      </span>
                    </span>
                    <span className="layout-meta">
                      <strong>顶部成员墙</strong>
                      <em>网格 + 下方聊天</em>
                    </span>
                    {settings.layout === 'grid' && (
                      <span className="layout-check"><Check size={11} strokeWidth={3} /></span>
                    )}
                  </button>
                </div>
                <div className="card-style-block">
                  <div className="card-style-head">
                    <strong>卡片风格</strong>
                    <span>影响成员卡片与面板的质感</span>
                  </div>
                  <div className="card-style-grid">
                    {([
                      { id: 'flat', label: '扁平' },
                      { id: 'raised', label: '浮起' },
                      { id: 'outline', label: '描边' },
                    ] as const).map(({ id, label }) => (
                      <button
                        key={id}
                        className={`card-style-option ${settings.cardStyle === id ? 'active' : ''}`}
                        onClick={() => onChange({ cardStyle: id })}
                      >
                        <span className={`cs-sample ${id}`}>
                          <i className="cs-avatar" />
                          <i className="cs-line" />
                          <i className="cs-line short" />
                        </span>
                        <strong>{label}</strong>
                        {settings.cardStyle === id && (
                          <span className="cs-check"><Check size={10} strokeWidth={3} /></span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </SetCard>

              <SetCard title="质感" desc="密度、圆角与毛玻璃强度会作用于所有面板">
                <SettingRow title="界面密度">
                  <Segmented
                    value={settings.density}
                    options={[
                      { value: 'compact', label: '紧凑' },
                      { value: 'cozy', label: '舒适' },
                      { value: 'spacious', label: '宽松' },
                    ]}
                    onChange={(value) => onChange({ density: value })}
                  />
                </SettingRow>
                <SettingRow title="圆角" desc="0 更硬朗，22 更圆润">
                  <Slider
                    value={settings.radius}
                    min={6}
                    max={22}
                    suffix=" px"
                    onChange={(value) => onChange({ radius: value })}
                  />
                </SettingRow>
                <SettingRow title="背景模糊" desc="毛玻璃强度，过高会影响低端设备性能">
                  <Slider
                    value={settings.blur}
                    min={0}
                    max={40}
                    suffix=" px"
                    onChange={(value) => onChange({ blur: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="纯色区域不透明度"
                  desc="统一调整卡片、侧栏、面板等纯色区域，默认 80%；100% 完全不透明"
                >
                  <Slider
                    value={settings.panelOpacity}
                    min={30}
                    max={100}
                    step={5}
                    suffix="%"
                    onChange={(value) => onChange({ panelOpacity: value })}
                  />
                </SettingRow>
                <SettingRow title="界面动画" desc="关闭后取消过渡与说话光效">
                  <Switch
                    checked={settings.animations}
                    onChange={(value) => onChange({ animations: value })}
                  />
                </SettingRow>
              </SetCard>

              <SetCard title="背景" desc="预设渐变或自定义图片，遮罩强度保证内容可读">
                <div className="bg-grid">
                  {(Object.keys(backgroundPresets) as Array<keyof typeof backgroundPresets>).map(
                    (id) => (
                      <button
                        key={id}
                        className={`bg-option ${settings.background === id ? 'active' : ''}`}
                        onClick={() => onChange({ background: id })}
                      >
                        <span
                          className="bg-preview"
                          style={{ background: dark ? backgroundPresets[id].dark : backgroundPresets[id].light }}
                        />
                        <span className="bg-name">{backgroundPresets[id].name}</span>
                        {settings.background === id && (
                          <span className="bg-check"><Check size={10} strokeWidth={3} /></span>
                        )}
                      </button>
                    ),
                  )}
                </div>
                <div className="bg-custom">
                  <SettingRow title="自定义背景图" desc="HTTPS 图片地址，留空则使用预设">
                    <div className="inline-field">
                      <TextInput
                        value={settings.backgroundImage}
                        placeholder="https://…"
                        onChange={(value) => onChange({ backgroundImage: value })}
                      />
                      {settings.backgroundImage && (
                        <button
                          className="icon-btn"
                          title="清除图片"
                          onClick={() => onChange({ backgroundImage: '' })}
                        >
                          <Trash2 size={14} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  </SettingRow>
                  {customBackground && (
                    <div className="bg-custom-card">
                      <span
                        className="bg-custom-thumb"
                        style={{ backgroundImage: `url(${JSON.stringify(customBackground)})` }}
                      />
                      <div>
                        <strong>已应用自定义背景</strong>
                        <em>调整下方遮罩强度，保证面板与文字清晰</em>
                      </div>
                    </div>
                  )}
                  <SettingRow title="背景遮罩" desc="数值越高背景越暗，文字对比更清晰">
                    <Slider
                      value={settings.backgroundDim}
                      min={0}
                      max={90}
                      step={5}
                      suffix=" %"
                      onChange={(value) => onChange({ backgroundDim: value })}
                    />
                  </SettingRow>
                </div>
              </SetCard>

              <SetCard title="内容显示" desc="消息与成员状态的细节开关">
                <SettingRow title="消息气泡" desc="关闭后使用紧凑的纯文本样式">
                  <Switch
                    checked={settings.chatBubbles}
                    onChange={(value) => onChange({ chatBubbles: value })}
                  />
                </SettingRow>
                <SettingRow title="显示时间戳">
                  <Switch
                    checked={settings.showTimestamps}
                    onChange={(value) => onChange({ showTimestamps: value })}
                  />
                </SettingRow>
                <SettingRow title="成员状态图标" desc="麦克风、扬声器、手机端与离开状态">
                  <Switch
                    checked={settings.showMemberState}
                    onChange={(value) => onChange({ showMemberState: value })}
                  />
                </SettingRow>
                <SettingRow title="频道自定义图标" desc="读取 TeamSpeak 频道的 icon_id">
                  <Switch
                    checked={settings.showChannelIcons}
                    onChange={(value) => onChange({ showChannelIcons: value })}
                  />
                </SettingRow>
                <SettingRow title="服务器组标签" desc="在成员卡片上显示服务器组徽标">
                  <Switch
                    checked={settings.showGroupChips}
                    onChange={(value) => onChange({ showGroupChips: value })}
                  />
                </SettingRow>
                <SettingRow title="频道成员数" desc="在频道树右侧显示在线人数">
                  <Switch
                    checked={settings.showChannelCounts}
                    onChange={(value) => onChange({ showChannelCounts: value })}
                  />
                </SettingRow>
              </SetCard>
            </>
          )}

          {section === 'hotkeys' && (
            <SetCard title="快捷键" desc="点击按键框后按下组合键即可录制，Esc 取消">
              {hotkeyRows.map(([key, label]) => (
                <SettingRow
                  key={key}
                  title={label}
                  desc={key === 'ptt' ? '按住说话，松开即停' : '窗口聚焦时生效'}
                >
                  <HotkeyInput
                    value={settings.hotkeys[key]}
                    onChange={(value) =>
                      onChange({ hotkeys: { ...settings.hotkeys, [key]: value } })
                    }
                  />
                </SettingRow>
              ))}
              <div className="inline-actions">
                <button
                  className="small-btn ghost"
                  onClick={() => onChange({ hotkeys: defaultSettings.hotkeys })}
                >
                  <RotateCcw size={13} strokeWidth={2} />
                  恢复默认快捷键
                </button>
              </div>
              <p className="set-note">
                快捷键在 RaySpeak 窗口聚焦时生效；在输入框、搜索框内不会触发。
                按键说话与「语音与音频」中的 PTT 按键共用同一组合。
              </p>
            </SetCard>
          )}

          {section === 'notify' && (
            <>
              <SetCard title="桌面通知" desc="对应 TeamSpeak 文本消息与被提及提醒">
                <SettingRow title="启用桌面通知" desc="窗口在后台时弹出系统通知">
                  <Switch
                    checked={settings.desktopNotify}
                    onChange={(value) => {
                      onChange({ desktopNotify: value })
                      if (value) {
                        void ensureNotifyPermission().then((granted) => {
                          if (!granted) onToast('系统通知权限未授予，仍会显示应用内提示')
                        })
                      }
                    }}
                  />
                </SettingRow>
                <SettingRow title="通知声音">
                  <Switch
                    checked={settings.notifySound}
                    onChange={(value) => onChange({ notifySound: value })}
                  />
                </SettingRow>
                <SettingRow title="仅提醒被提及" desc="频道消息只在 @我 时提醒；私聊与戳一戳仍会提醒">
                  <Switch
                    checked={settings.mentionOnly}
                    onChange={(value) => onChange({ mentionOnly: value })}
                  />
                </SettingRow>
                <SettingRow title="勿扰模式" desc="静音所有提醒，连接状态显示为勿扰">
                  <Switch
                    checked={settings.dnd}
                    onChange={(value) => onChange({ dnd: value })}
                  />
                </SettingRow>
                <SettingRow title="提示音" desc="选择通知音色">
                  <Select
                    value={settings.notifyTone}
                    options={['叮咚', '轻铃', '水滴', '木鱼']}
                    onChange={(value) => onChange({ notifyTone: value })}
                  />
                </SettingRow>
                <div className="inline-actions">
                  <button className="small-btn" onClick={() => void testNotification()}>
                    <Bell size={13} strokeWidth={2} />
                    发送测试通知
                  </button>
                </div>
              </SetCard>

              <SetCard title="频道提醒" desc="成员进出频道时写入本地聊天记录，并可播放提示音">
                <SettingRow title="成员进出提醒" desc="在消息区显示加入/离开/移动记录">
                  <Switch
                    checked={settings.notifyJoinLeave}
                    onChange={(value) => onChange({ notifyJoinLeave: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="进出提示音"
                  desc="有人（包括你自己）进出频道时播放短提示音，勿扰模式下自动静音"
                >
                  <Switch
                    checked={settings.joinLeaveSound}
                    onChange={(value) => onChange({ joinLeaveSound: value })}
                  />
                </SettingRow>
              </SetCard>
            </>
          )}

          {section === 'privacy' && (
            <>
              <SetCard title="隐私" desc="控制本机如何显示与接收消息">
                <SettingRow
                  title="允许接收私聊"
                  desc="关闭后本机会忽略其他人的私聊消息与戳一戳"
                >
                  <Switch
                    checked={settings.allowDm}
                    onChange={(value) => onChange({ allowDm: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="显示在线状态"
                  desc="关闭后本机界面隐藏在线状态标记，不会改动服务器数据"
                >
                  <Switch
                    checked={settings.showPresence}
                    onChange={(value) => onChange({ showPresence: value })}
                  />
                </SettingRow>
              </SetCard>

              <SetCard title="我的状态" desc="离开状态会同步到服务器，其他成员可以看到">
                <SettingRow title="状态">
                  <Segmented
                    value={settings.presenceStatus}
                    options={[
                      { value: 'online', label: '在线' },
                      { value: 'away', label: '离开' },
                    ]}
                    onChange={(value) =>
                      onChange({ presenceStatus: value as 'online' | 'away' })
                    }
                  />
                </SettingRow>
                {settings.presenceStatus === 'away' && (
                  <SettingRow title="离开说明" desc="显示给其他成员">
                    <TextInput
                      value={settings.awayMessage}
                      maxLength={80}
                      placeholder="暂时离开"
                      onChange={(value) => onChange({ awayMessage: value })}
                    />
                  </SettingRow>
                )}
                {settings.dnd && (
                  <p className="set-note">勿扰模式已开启，服务器状态会显示为「勿扰模式」。</p>
                )}
              </SetCard>

              <SetCard title="身份安全" desc="身份密钥由应用首次启动时生成并保存在本机">
                <SettingRow title="当前安全级别" desc="RSA 谜题计算出的身份等级">
                  <span className="status-chip online">10 级</span>
                </SettingRow>
                <div className="security-meter">
                  <span style={{ width: '33%' }} />
                </div>
                <p className="set-note">
                  更换或提升身份会改变 UID，现有服务器组与权限将失效，因此当前版本保持固定身份。
                </p>
              </SetCard>

              <SetCard title="屏蔽列表" desc="被屏蔽用户的消息、戳一戳与本机语音输出会被过滤">
                {blocked.length === 0 && (
                  <div className="blocked-empty">
                    <ShieldCheck size={18} strokeWidth={1.8} />
                    <span>还没有屏蔽任何人</span>
                  </div>
                )}
                {blocked.map((client) => (
                  <div className="blocked-row" key={client.id}>
                    <span>{stripClientTags(client.name)}</span>
                    <button
                      className="small-btn ghost"
                      onClick={() =>
                        onChange({ blocked: settings.blocked.filter((id) => id !== client.id) })
                      }
                    >
                      解除屏蔽
                    </button>
                  </div>
                ))}
                {blocked.length > 0 && (
                  <div className="inline-actions">
                    <button
                      className="small-btn ghost"
                      onClick={() => onChange({ blocked: [] })}
                    >
                      清空屏蔽列表
                    </button>
                  </div>
                )}
              </SetCard>
            </>
          )}

          {section === 'advanced' && (
            <>
              <SetCard title="连接" desc="连接超时与断线行为">
                <SettingRow title="允许文件传输" desc="用于频道图标与文件，图标下载为明文 TCP">
                  <Switch
                    checked={settings.fileTransfer}
                    onChange={(value) => onChange({ fileTransfer: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="自动重连"
                  desc="网络中断后用本次会话凭据自动重试最多 3 次"
                >
                  <Switch
                    checked={settings.autoReconnect}
                    onChange={(value) => onChange({ autoReconnect: value })}
                  />
                </SettingRow>
                <SettingRow title="连接超时" desc="等待握手与频道目录的秒数">
                  <Slider
                    value={settings.timeout}
                    min={5}
                    max={60}
                    step={5}
                    suffix=" 秒"
                    onChange={(value) => onChange({ timeout: value })}
                  />
                </SettingRow>
              </SetCard>

              <SetCard title="预览与诊断" desc="演示事件只在浏览器预览模式生效">
                <SettingRow
                  title="演示事件"
                  desc="每 7 秒让一名成员切换频道，用于验证动态成员列表"
                >
                  <Switch
                    checked={settings.demoEvents}
                    onChange={(value) => onChange({ demoEvents: value })}
                  />
                </SettingRow>
                <div className="inline-actions">
                  <button className="small-btn" onClick={() => void copyDiagnostics()}>
                    <Copy size={13} strokeWidth={2} />
                    复制诊断信息
                  </button>
                </div>
              </SetCard>

              <SetCard
                title="协议能力对照"
                desc="基于 tsclient-rs 当前实现；共享与文件面板已具备，但入口暂时隐藏"
              >
                <div className="protocol-list">
                  {protocolRows.map(([name, detail, status]) => (
                    <div className="protocol-row" key={name}>
                      <span className="protocol-icon">
                        <Server size={14} strokeWidth={1.9} />
                      </span>
                      <div>
                        <strong>{name}</strong>
                        <em>{detail}</em>
                      </div>
                      <span
                        className={`status-chip ${
                          status === '内核已支持' ? 'online' : status === '需应用层' ? 'pending' : 'unsupported'
                        }`}
                      >
                        {status}
                      </span>
                    </div>
                  ))}
                </div>
              </SetCard>

              <SetCard title="危险操作" desc="仅影响本机设置，不影响服务器">
                <div className="inline-actions">
                  <button className="small-btn danger" onClick={onReset}>
                    <RotateCcw size={13} strokeWidth={2} />
                    恢复全部默认设置
                  </button>
                  <button
                    className="small-btn ghost"
                    onClick={() => {
                      let removed = 0
                      try {
                        const keys = Object.keys(localStorage).filter(
                          (key) =>
                            key.startsWith('rayspeak.volumes') ||
                            key.startsWith('rayspeak.nickname') ||
                            key.startsWith('rayspeak.dm.') ||
                            key.startsWith('rayspeak.avatars') ||
                            key.startsWith('rayspeak.contacts'),
                        )
                        keys.forEach((key) => localStorage.removeItem(key))
                        removed = keys.length
                      } catch {
                        onToast('本地存储不可用')
                        return
                      }
                      clearLocalStore()
                      onToast(`已清理 ${removed} 项本地缓存（含头像与联系人目录）`)
                    }}
                  >
                    <Trash2 size={13} strokeWidth={2} />
                    清理本地缓存
                  </button>
                </div>
              </SetCard>
            </>
          )}

          {section === 'about' && (
            <>
              <section className="about-hero">
                <span className="about-logo">
                  <img src="/logo.png" alt="" draggable={false} />
                </span>
                <div>
                  <h2>RaySpeak</h2>
                  <p>为 TeamSpeak 打造的现代第三方桌面客户端</p>
                  <span className="version-pill">
            v{appInfo?.version ?? '0.2.0'} · 协议接入
          </span>
                </div>
              </section>

              <SetCard title="技术栈" desc="低占用、可打包为单个 Windows 安装包">
                <AboutRow label="界面" value="React 19 + TypeScript 5.6 + Vite 6" />
                <AboutRow label="桌面容器" value="Tauri 2 · WebView2 · NSIS 安装包" />
                <AboutRow label="协议内核" value="tsclient-rs（Rust）" />
                <AboutRow label="音频" value="Opus 48kHz · WebView2 采集 · WebAudio" />
                <AboutRow label="界面语言" value="简体中文" />
                <AboutRow label="数据目录" value={appInfo?.dataDir ?? '连接后读取'} />
              </SetCard>

              <SetCard title="当前状态" desc="协议与音频已接入，持续在真实服务器上调优">
                <div className="about-status">
                  <div>
                    <span className="status-dot done" />
                    <strong>UI 与交互</strong>
                    <em>私聊、频道管理、资料卡与通知已完成（共享与文件入口暂缓展示）</em>
                  </div>
                  <div>
                    <span className="status-dot done" />
                    <strong>协议接入</strong>
                    <em>连接、频道、消息、权限、图标与文件链路已接入 tsclient-rs</em>
                  </div>
                  <div>
                    <span className="status-dot done" />
                    <strong>音频与设备</strong>
                    <em>WebCodecs Opus 收发、抖动缓冲、降噪与回声消除</em>
                  </div>
                </div>
              </SetCard>

              <SetCard title="说明" desc="非官方客户端">
                <p className="about-text">
                  RaySpeak 是社区项目，与 TeamSpeak Systems GmbH 无关联。桌面应用中频道、成员、图标与身份均由服务器实时下发；
                  浏览器预览使用内置演示数据。服务器地址只保留在应用配置中，不会显示在界面或错误信息里。
                </p>
                <div className="inline-actions">
                  <button
                    className="small-btn"
                    onClick={() => {
                      if (demoMode) {
                        onToast('仅桌面应用可打开数据目录')
                        return
                      }
                      protocol
                        .openDataDir()
                        .then(() => onToast('已打开应用数据目录'))
                        .catch((error) => onToast(errorText(error)))
                    }}
                  >
                    打开数据目录
                  </button>
                  <button className="small-btn ghost" onClick={copyDiagnostics}>
                    复制调试信息
                  </button>
                </div>
              </SetCard>
            </>
          )}

          <footer className="settings-footer">
            <Columns2 size={13} strokeWidth={2} />
            <span>提示：房间头部可随时切换布局、在线状态与深/浅色模式</span>
            <LayoutGrid size={13} strokeWidth={2} />
          </footer>
        </div>
      </div>
    </div>
  )
}
