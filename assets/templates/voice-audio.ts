/**
 * Pure audio + protocol helpers for an xAI realtime voice agent.
 * Everything here is browser-API-light so it stays unit-testable; the
 * WebSocket/AudioContext wiring lives in use-voice-agent.ts.
 *
 * See references/audio-pipeline.md for the why behind each function.
 */

// btoa on a single huge string built via String.fromCharCode(...spread)
// overflows the call stack; encode in ~8k chunks.
const CHUNK_SIZE = 8192

export function float32ToPcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const bytes = new Uint8Array(pcm.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE))
  }
  return btoa(binary)
}

export function pcm16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  const pcm = new Int16Array(bytes.buffer)
  const samples = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    samples[i] = pcm[i] < 0 ? pcm[i] / 0x8000 : pcm[i] / 0x7fff
  }
  return samples
}

/** Fallback for browsers that ignore AudioContext({sampleRate: 24000}). */
export function downsampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const output = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < output.length; i++) {
    const pos = i * ratio
    const left = Math.floor(pos)
    const right = Math.min(left + 1, input.length - 1)
    const frac = pos - left
    output[i] = input[left] * (1 - frac) + input[right] * frac
  }
  return output
}

export interface PendingFunctionCall {
  callId: string
  name: string
  arguments: string
}

/**
 * Accumulates function calls from response.function_call_arguments.done
 * events. flush() drains the buffer, so the caller sends every output and
 * then exactly one response.create per response.done — never one per call.
 */
export function createFunctionCallBuffer() {
  let pending: PendingFunctionCall[] = []
  return {
    add(call: PendingFunctionCall) {
      pending.push(call)
    },
    flush(): PendingFunctionCall[] {
      const calls = pending
      pending = []
      return calls
    },
  }
}

/**
 * AudioWorkletProcessor source, loaded via a Blob URL (worklets can't import
 * app modules). Posts raw Float32 mic frames; the main thread batches them
 * into ~100ms chunks before encoding.
 */
export const RECORDER_WORKLET_SRC = `
class PcmRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length > 0) {
      const frame = new Float32Array(channel.length)
      frame.set(channel)
      this.port.postMessage(frame, [frame.buffer])
    }
    return true
  }
}
registerProcessor('pcm-recorder', PcmRecorderProcessor)
`
