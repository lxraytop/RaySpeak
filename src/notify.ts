import { isTauri } from './protocol'

let toneContext: AudioContext | null = null

function audioContext() {
  if (!toneContext) {
    try {
      toneContext = new AudioContext()
    } catch {
      return null
    }
  }
  if (toneContext.state === 'suspended') void toneContext.resume().catch(() => {})
  return toneContext
}

const tones: Record<string, Array<[number, number, number]>> = {
  叮咚: [
    [880, 0, 0.16],
    [660, 0.14, 0.24],
  ],
  轻铃: [
    [1046, 0, 0.18],
    [1318, 0.12, 0.26],
  ],
  水滴: [
    [740, 0, 0.1],
    [988, 0.08, 0.16],
  ],
  木鱼: [[320, 0, 0.12]],
}

export function playNotifyTone(name: string) {
  const context = audioContext()
  if (!context) return
  const notes = tones[name] ?? tones['叮咚']
  const start = context.currentTime + 0.01
  for (const [frequency, offset, duration] of notes) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = name === '木鱼' ? 'triangle' : 'sine'
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(0.0001, start + offset)
    gain.gain.exponentialRampToValueAtTime(0.16, start + offset + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(start + offset)
    oscillator.stop(start + offset + duration + 0.02)
  }
}

export async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (isTauri) {
      const { isPermissionGranted, requestPermission } = await import(
        '@tauri-apps/plugin-notification'
      )
      if (await isPermissionGranted()) return true
      return (await requestPermission()) === 'granted'
    }
    if (typeof Notification === 'undefined') return false
    if (Notification.permission === 'granted') return true
    if (Notification.permission === 'denied') return false
    return (await Notification.requestPermission()) === 'granted'
  } catch {
    return false
  }
}

export async function showDesktopNotification(title: string, body: string): Promise<boolean> {
  if (!(await ensureNotifyPermission())) return false
  try {
    if (isTauri) {
      const { sendNotification } = await import('@tauri-apps/plugin-notification')
      sendNotification({ title, body })
      return true
    }
    new Notification(title, { body, silent: true, tag: 'rayspeak' })
    return true
  } catch {
    return false
  }
}
