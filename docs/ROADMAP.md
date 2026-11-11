# 路线图与已知缺口

本文件列出当前实现边界和建议的后续任务。接手时优先处理与真实协议相关、
可验证的问题，不要把“协议做不到”的功能做成假数据。

## 1. 当前确定做不到 / 不伪造

| 项 | 原因 |
| --- | --- |
| 消息历史 | TeamSpeak 3 服务器不提供历史消息接口 |
| 好友系统 / 好友在线状态 | TS 协议没有好友模型 |
| 屏幕共享视频 | TS3 不传输视频，当前仅本地预览 |
| 服务器管理后台 | 受权限限制，访客可用命令很少；无 ServerQuery 登录 |
| 跨服务器 | 客户端只连接单一固定服务器 |
| 消息已读回执 / 输入状态 | 协议不提供 |

这些功能如要做，只能明确标注为本地能力（如本地屏幕预览），不能伪装成服务器同步。

## 2. 高优先级

### 2.1 自动化测试

当前没有测试套件，至少补充纯函数单测：

- `avatar_file_name()`：UID → a-p 文件名（固定向量）
- `parseRayLink()` / `rayInviteLink()`：编码、非法链接、中文频道名
- `utils/tsText`：颜色、粗体、spacer、URL、转义
- `utils/live.toClient/toChannel`：组命名空间、头像 hash 变化时清空 avatarUrl
- 快照去重与消息去重逻辑（建议先抽成纯函数）

Rust 侧可为 `build_snapshot`、`server_info_from_properties`、
`avatar_mime` 增加单测。

### 2.2 头像与离线/历史展示

- 头像缓存目前只在内存，离线联系人、历史私聊消息不会显示头像
- 建议按 UID 持久化头像 data URL（限制大小/数量/LRU），重连后先读缓存再刷新
- 历史消息没有 `avatarUrl`；可在渲染时按 clientId 动态查表，而不是发送时快照

### 2.3 大服务器性能

`applySnapshot()` 会为每个新客户端调用 `clientinfo`。人数多时会瞬时产生大量请求：

- 增加并发上限或队列
- 失败退避，不要每个快照重试
- 头像下载同样限流，仅对可见频道或当前布局加载

### 2.4 资料实时性

简介、平台、版本、频道组只在首次出现或打开资料卡时拉取。
可监听 `notifyclientupdated` 中的相关字段，或对已缓存客户端做低频刷新。

### 2.5 频道目录强制刷新

`refresh_directory` 复用 crate 目录缓存，仅刷新组与 codec quality。
若怀疑错过 `server/channel` 通知，当前没有“强制重拉 channellist”的公开 API。
可在 vendor 中增加安全的目录重建入口，或在刷新时提示用户重连。

## 3. 中优先级

- **消息体验**：时间分组、复制多条、链接跳转、未读定位、发送失败重试 UI
- **文件面板**：上传/下载进度、取消、失败重试、拖拽上传
- **头像设置体验**：上传进度、大小/格式提示、裁剪预览、权限不足的明确文案
- **设备管理**：设备热插拔、输出设备切换、PTT 按键冲突检测
- **设置导入/导出**：主题、快捷键、屏蔽名单；身份文件已有导出
- **错误分类**：把服务器错误 ID 映射为用户可理解文案，区分权限/网络/协议错误
- **无障碍与键盘操作**：频道树、成员卡、右键菜单的完整键盘导航
- **国际化**：当前文案为中文，可抽 i18n 资源

## 4. 工程化

- 增加 GitHub Actions：`npm ci` + `typecheck` + `cargo check` + `vite build`
- 发布流程：版本号三处同步、打 tag、上传 NSIS 安装包
- 依赖升级：tsclient-rs vendor 补丁需要按 `docs/PROTOCOL.md` 重新应用
- `App.tsx` 体量较大，建议按领域拆 hooks：
  `useConnection`、`useDirectory`、`useMessages`、`useDeepLink`、`useAvatars`
- 为协议命令建立统一错误类型，避免 `String` 到处透传

## 5. 低优先级 / 设计向

- 成员列表虚拟滚动（大频道）
- 频道拖拽排序（需写 `channeledit channel_order` predecessor）
- 频道权限/组管理 UI（先确认当前身份权限）
- 消息中的 `[url]...[/url]` 更细粒度渲染
- 深链支持 `ray://join/<id>` 以外的动作前，先补协议白名单与安全校验

## 6. 验收要求

任何新功能提交前至少满足：

1. `npm run typecheck` 通过
2. `cargo check` 通过
3. `npm run app:build` 成功
4. 真实窗口手工验证主路径和失败路径
5. 不泄露服务器地址/密码/解析后主机
6. 不修改真实用户资料用于测试（头像等使用一次性身份）
7. 更新对应文档（AGENTS / ARCHITECTURE / PROTOCOL）
