import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { VoiceInputSettings } from '../types/settings'

interface VoiceInputControllerProps {
  masterPassword: string
}

export default function VoiceInputController({ masterPassword }: VoiceInputControllerProps) {
  const [settings, setSettings] = useState<VoiceInputSettings | null>(null)
  const settingsRef = useRef<VoiceInputSettings | null>(null)
  settingsRef.current = settings

  useEffect(() => {
    if (!masterPassword) {
      setSettings(null)
      return
    }
    let cancelled = false
    const load = () => {
      invoke<VoiceInputSettings>('get_voice_input_settings', { masterPassword })
        .then((value) => {
          if (!cancelled) setSettings(value)
        })
        .catch(() => {
          if (!cancelled) setSettings(null)
        })
    }
    load()
    const timer = window.setInterval(load, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [masterPassword])

  useEffect(() => {
    if (!masterPassword) return
    if (!settings?.voice_input_enabled) return

    invoke<boolean>('initialize_voice_input_listener', { masterPassword }).catch((err) => {
      console.error('initialize_voice_input_listener failed:', err)
    })
  }, [masterPassword, settings?.voice_input_enabled])

  return null
}
