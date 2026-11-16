// 下载并校验屏幕共享所需的 EasyTier 内核（Windows x86_64）。
// 产物写入 src-tauri/resources/easytier/，该目录不入库。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '2.6.4'
const ASSET = `easytier-windows-x86_64-v${VERSION}.zip`
const SHA256 = '27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84'
const FILES = ['easytier-core.exe', 'easytier-cli.exe', 'wintun.dll', 'Packet.dll']

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'src-tauri', 'resources', 'easytier')

if (FILES.every((name) => existsSync(join(target, name)))) {
  console.log(`EasyTier ${VERSION} 已就绪: ${target}`)
  process.exit(0)
}

mkdirSync(target, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'rayspeak-easytier-'))
const zipPath = join(work, ASSET)

const headers = { 'User-Agent': 'rayspeak-build', Accept: 'application/vnd.github+json' }
const release = await fetch(`https://api.github.com/repos/EasyTier/EasyTier/releases/tags/v${VERSION}`, {
  headers,
}).then((res) => {
  if (!res.ok) throw new Error(`查询 EasyTier release 失败: HTTP ${res.status}`)
  return res.json()
})
const asset = release.assets?.find((item) => item.name === ASSET)
if (!asset) throw new Error(`release v${VERSION} 中找不到 ${ASSET}`)

console.log(`下载 ${ASSET} (${(asset.size / 1048576).toFixed(1)} MB) ...`)
const download = await fetch(asset.url, {
  headers: { ...headers, Accept: 'application/octet-stream' },
  redirect: 'follow',
})
if (!download.ok) throw new Error(`下载失败: HTTP ${download.status}`)
const bytes = Buffer.from(await download.arrayBuffer())
writeFileSync(zipPath, bytes)

const digest = createHash('sha256').update(bytes).digest('hex')
if (digest !== SHA256) {
  throw new Error(`SHA-256 不匹配: 期望 ${SHA256}，实际 ${digest}`)
}

execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${work.replace(/'/g, "''")}' -Force`,
  ],
  { stdio: 'inherit' },
)

const extracted = join(work, `easytier-windows-x86_64`)
for (const name of FILES) {
  const source = join(extracted, name)
  if (!existsSync(source)) throw new Error(`压缩包中缺少 ${name}`)
  copyFileSync(source, join(target, name))
  console.log(`已写入 ${name}`)
}
rmSync(work, { recursive: true, force: true })
console.log('EasyTier 内核准备完成。')
