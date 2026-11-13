// Wraps the Tauri CLI so native audio dependencies (libopus) can find CMake.
// Visual Studio Build Tools ships CMake, but not on PATH; locate it via vswhere.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate))
}

function findCmake() {
  const candidates = [process.env.CMAKE]
  const vswhere =
    'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe'
  if (existsSync(vswhere)) {
    try {
      const root = execFileSync(
        vswhere,
        ['-latest', '-products', '*', '-property', 'installationPath'],
        { encoding: 'utf8' },
      ).trim()
      if (root) {
        candidates.push(
          path.join(
            root,
            'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe',
          ),
        )
      }
    } catch {
      /* vswhere unavailable */
    }
  }
  candidates.push('C:/Program Files/CMake/bin/cmake.exe')
  try {
    const found = execFileSync('where', ['cmake'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    candidates.push(...found)
  } catch {
    /* cmake not on PATH */
  }
  return firstExisting(candidates)
}

const env = {
  ...process.env,
  // CMake 4 rejects opus' `cmake_minimum_required(VERSION 3.1)`.
  CMAKE_POLICY_VERSION_MINIMUM: process.env.CMAKE_POLICY_VERSION_MINIMUM ?? '3.5',
}
const cmake = findCmake()
if (cmake) env.CMAKE = cmake
else console.warn('[rayspeak] CMake not found; native audio may fail to build')

// SpeexDSP bindings (aec-rs-sys) run bindgen at build time. pip's libclang
// wheel keeps libclang.dll outside PATH, so point bindgen at it explicitly.
function findLibclang() {
  const candidates = [process.env.LIBCLANG_PATH]
  const roaming = process.env.APPDATA
  if (roaming) {
    for (const version of ['Python310', 'Python311', 'Python312', 'Python313']) {
      candidates.push(
        path.join(roaming, 'Python', version, 'site-packages', 'clang', 'native'),
      )
    }
  }
  return candidates.find(
    (candidate) => candidate && existsSync(path.join(candidate, 'libclang.dll')),
  )
}
const libclang = findLibclang()
if (libclang) env.LIBCLANG_PATH = libclang
else
  console.warn(
    '[rayspeak] libclang not found; native mic may fail to build (pip install libclang)',
  )

const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  cwd: root,
})
child.on('exit', (code) => process.exit(code ?? 0))
