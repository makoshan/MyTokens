export interface WavRecordingResult {
  wavBytes: Uint8Array
  sampleRate: number
  durationMs: number
}

export interface WavRecorder {
  start: () => Promise<void>
  stop: () => Promise<WavRecordingResult>
  isRecording: () => boolean
}

function floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    output.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i) & 0xff)
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM
  view.setUint16(20, 1, true) // format
  view.setUint16(22, 1, true) // channels
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate (mono 16-bit)
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  floatTo16BitPCM(view, 44, samples)
  return new Uint8Array(buffer)
}

function trimSilence(
  samples: Float32Array,
  sampleRate: number,
  opts?: {
    threshold?: number
    minSilenceMs?: number
    padMs?: number
  }
): Float32Array {
  const threshold = opts?.threshold ?? 0.008
  const minSilenceMs = opts?.minSilenceMs ?? 400
  const padMs = opts?.padMs ?? 120

  const minSilenceSamples = Math.floor((sampleRate * minSilenceMs) / 1000)
  const padSamples = Math.floor((sampleRate * padMs) / 1000)

  const abs = (v: number) => (v < 0 ? -v : v)

  // Find first "active" sample.
  let start = 0
  while (start < samples.length && abs(samples[start]) < threshold) start++
  start = Math.max(0, start - padSamples)

  // Find last "active" sample.
  let end = samples.length - 1
  while (end >= 0 && abs(samples[end]) < threshold) end--
  end = Math.min(samples.length, end + 1 + padSamples)

  if (end <= start) return samples

  // If tail silence is long, hard-cut it.
  // This helps reduce Whisper hallucinations on long silence tails.
  let lastActive = end - 1
  let tail = 0
  while (lastActive >= start && abs(samples[lastActive]) < threshold) {
    tail++
    lastActive--
    if (tail >= minSilenceSamples) break
  }
  if (tail >= minSilenceSamples) {
    end = Math.min(end, lastActive + 1 + padSamples)
    if (end <= start) end = start + 1
  }

  return samples.slice(start, end)
}

function resampleLinear(samples: Float32Array, inRate: number, outRate: number): Float32Array {
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate) || inRate <= 0 || outRate <= 0) {
    return samples
  }
  if (inRate === outRate) return samples

  const ratio = inRate / outRate
  const outLen = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Float32Array(outLen)

  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = samples[idx] ?? 0
    const b = samples[Math.min(idx + 1, samples.length - 1)] ?? 0
    out[i] = a + (b - a) * frac
  }
  return out
}

export function createWavRecorder(): WavRecorder {
  let recording = false
  let audioCtx: AudioContext | null = null
  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  let silentGain: GainNode | null = null
  let chunks: Float32Array[] = []
  let startedAt = 0

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

  // WebKit (Tauri macOS) sometimes hangs forever on AudioContext.close().
  // Never let that block the recording pipeline.
  const safeCloseAudioContext = async (ctx: AudioContext | null, timeoutMs = 200) => {
    if (!ctx) return
    try {
      await Promise.race([ctx.close().catch(() => undefined), sleep(timeoutMs)])
    } catch {
      // ignore
    }
  }

  const start = async () => {
    if (recording) return
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前环境不支持麦克风录音（mediaDevices.getUserMedia 不可用）')
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })

    // Safari/WebKit: ScriptProcessor is deprecated but still the most compatible for Tauri macOS.
    audioCtx = new AudioContext()
    source = audioCtx.createMediaStreamSource(stream)
    processor = audioCtx.createScriptProcessor(4096, 1, 1)
    silentGain = audioCtx.createGain()
    silentGain.gain.value = 0
    chunks = []
    startedAt = Date.now()

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      chunks.push(new Float32Array(input))
    }

    source.connect(processor)
    // Keep the graph alive without audible output.
    processor.connect(silentGain)
    silentGain.connect(audioCtx.destination)

    recording = true
  }

  const stop = async () => {
    if (!recording) {
      throw new Error('Recorder is not recording')
    }
    recording = false

    const durationMs = Math.max(0, Date.now() - startedAt)
    const sampleRate = audioCtx?.sampleRate || 44100

    try {
      if (processor) processor.onaudioprocess = null
      processor?.disconnect()
      source?.disconnect()
      silentGain?.disconnect()
    } catch {
      // ignore
    }

    try {
      stream?.getTracks().forEach((t) => t.stop())
    } catch {
      // ignore
    }

    await safeCloseAudioContext(audioCtx)

    audioCtx = null
    stream = null
    source = null
    processor = null
    silentGain = null

    const total = chunks.reduce((acc, cur) => acc + cur.length, 0)
    const merged = new Float32Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    const trimmed = trimSilence(merged, sampleRate)
    const resampled = resampleLinear(trimmed, sampleRate, 16000)
    const wavBytes = encodeWav(resampled, 16000)
    chunks = []
    return { wavBytes, sampleRate: 16000, durationMs }
  }

  const isRecording = () => recording

  return { start, stop, isRecording }
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid call stack limits.
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}
