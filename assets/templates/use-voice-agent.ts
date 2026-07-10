'use client'

/**
 * useVoiceAgent — the full client for an xAI realtime voice call.
 *
 * Owns the WebSocket, mic capture, gapless playback, barge-in, the
 * function-call loop, and (optionally) transcript persistence. Pure audio
 * helpers live in voice-audio.ts so they stay unit-testable.
 *
 * Key invariants (each backed by a pitfall — see references/pitfalls.md):
 *   - start() is only ever called from a click handler (#10)
 *   - every function call gets an output; exactly one response.create (#5, #6)
 *   - transcript state is mirrored into a ref for same-tick teardown (#12)
 *   - teardown fires once, from any of its five entry paths (#14)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  float32ToPcm16Base64,
  pcm16Base64ToFloat32,
  downsampleLinear,
  createFunctionCallBuffer,
  RECORDER_WORKLET_SRC,
} from './voice-audio'

export type VoiceAgentState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'tool'
  | 'ended'
  | 'error'

export interface TranscriptEntry {
  role: 'user' | 'assistant'
  text: string
}

export interface VoiceAgentOptions {
  /** Route that mints the ephemeral token. Default: /api/voice/token */
  tokenEndpoint?: string
  /** Route that executes tool calls server-side. Default: /api/voice/tools */
  toolsEndpoint?: string
  /**
   * Optional: route that saves the transcript at call end (see
   * references/persistence-supabase.md). Omit to skip persistence entirely.
   */
  transcriptEndpoint?: string
}

const TARGET_RATE = 24000

interface TokenResponse {
  token: string
  url: string
  session: Record<string, unknown>
}

export function useVoiceAgent(options: VoiceAgentOptions = {}) {
  const {
    tokenEndpoint = '/api/voice/token',
    toolsEndpoint = '/api/voice/tools',
    transcriptEndpoint,
  } = options

  const [state, setState] = useState<VoiceAgentState>('idle')
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stateRef = useRef<VoiceAgentState>('idle')
  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workletUrlRef = useRef<string | null>(null)
  const liveSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set())
  const nextPlayTimeRef = useRef(0)
  const callBufferRef = useRef(createFunctionCallBuffer())
  const stoppedRef = useRef(false)
  // Assistant transcript deltas stream in; this tracks whether the latest
  // assistant entry is still receiving deltas or a new one should open.
  const assistantOpenRef = useRef(false)
  // Ref mirror of `transcript` — teardown can fire in the same tick as the
  // last transcript event, before React state has committed.
  const transcriptRef = useRef<TranscriptEntry[]>([])
  const callStartedAtRef = useRef<number | null>(null)
  // Starts true so stray teardowns before the first start() never flush.
  const flushedRef = useRef(true)

  const updateState = useCallback((next: VoiceAgentState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const stopPlayback = useCallback(() => {
    for (const source of liveSourcesRef.current) {
      try {
        source.stop()
      } catch {
        // already stopped
      }
    }
    liveSourcesRef.current.clear()
    nextPlayTimeRef.current = 0
  }, [])

  // All transcript writes go through here so the ref stays in lockstep with
  // state; the updater runs exactly once (setTranscript receives a value).
  const updateTranscript = useCallback(
    (updater: (prev: TranscriptEntry[]) => TranscriptEntry[]) => {
      transcriptRef.current = updater(transcriptRef.current)
      setTranscript(transcriptRef.current)
    },
    []
  )

  // Fire-and-forget persistence of the finished call. `flushedRef` funnels
  // the teardown and pagehide paths into a single POST; `keepalive` lets the
  // request outlive a closing tab. No-op when persistence isn't configured.
  const flushTranscript = useCallback(() => {
    if (!transcriptEndpoint) return
    if (flushedRef.current) return
    flushedRef.current = true

    const entries = transcriptRef.current.filter(e => e.text.trim().length > 0)
    if (entries.length === 0) return

    const durationSecs = callStartedAtRef.current !== null
      ? Math.max(0, Math.round((Date.now() - callStartedAtRef.current) / 1000))
      : undefined

    void fetch(transcriptEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ entries, durationSecs }),
    }).catch(() => {})
  }, [transcriptEndpoint])

  const teardown = useCallback((finalState: 'ended' | 'error') => {
    if (stoppedRef.current) return
    stoppedRef.current = true

    flushTranscript()
    window.removeEventListener('pagehide', flushTranscript)

    const ws = wsRef.current
    wsRef.current = null
    if (ws) {
      // Null the handlers first so the close we initiate can't re-enter here.
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }

    stopPlayback()

    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null

    const ctx = audioContextRef.current
    audioContextRef.current = null
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => {})
    }

    if (workletUrlRef.current) {
      URL.revokeObjectURL(workletUrlRef.current)
      workletUrlRef.current = null
    }

    callBufferRef.current.flush()
    assistantOpenRef.current = false
    updateState(finalState)
  }, [flushTranscript, stopPlayback, updateState])

  const teardownRef = useRef(teardown)
  teardownRef.current = teardown

  const appendAssistantDelta = useCallback((delta: string) => {
    const wasOpen = assistantOpenRef.current
    assistantOpenRef.current = true
    updateTranscript(prev => {
      if (wasOpen && prev.length > 0 && prev[prev.length - 1].role === 'assistant') {
        const last = prev[prev.length - 1]
        return [...prev.slice(0, -1), { role: 'assistant', text: last.text + delta }]
      }
      return [...prev, { role: 'assistant', text: delta }]
    })
  }, [updateTranscript])

  const playAudioDelta = useCallback((base64: string) => {
    const ctx = audioContextRef.current
    if (!ctx) return
    const samples = pcm16Base64ToFloat32(base64)
    if (samples.length === 0) return
    // Buffers are tagged 24k regardless of the context rate; the context
    // resamples on playback.
    const buffer = ctx.createBuffer(1, samples.length, TARGET_RATE)
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const startAt = Math.max(ctx.currentTime, nextPlayTimeRef.current)
    source.start(startAt)
    nextPlayTimeRef.current = startAt + buffer.duration
    liveSourcesRef.current.add(source)
    source.onended = () => liveSourcesRef.current.delete(source)
  }, [])

  const runFunctionCalls = useCallback(async () => {
    const calls = callBufferRef.current.flush()
    if (calls.length === 0) {
      if (stateRef.current === 'speaking' || stateRef.current === 'tool') {
        updateState('listening')
      }
      return
    }

    updateState('tool')

    // Every call must produce an output — a dropped output stalls the
    // conversation permanently — so fetch failures become {error} payloads.
    const outputs = await Promise.all(
      calls.map(async call => {
        try {
          const res = await fetch(toolsEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: call.name, arguments: call.arguments }),
          })
          if (res.status === 401 || res.status === 403) {
            return { call, output: { error: 'Not authorized' }, fatal: true }
          }
          if (!res.ok) {
            return { call, output: { error: `Tool request failed (${res.status})` }, fatal: false }
          }
          const json = await res.json() as { output?: Record<string, unknown> }
          return { call, output: json.output ?? { error: 'Empty tool output' }, fatal: false }
        } catch {
          return { call, output: { error: 'Tool request failed' }, fatal: false }
        }
      })
    )

    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return // call ended mid-flight

    if (outputs.some(o => o.fatal)) {
      setError('Voice session is no longer authorized')
      teardownRef.current('error')
      return
    }

    for (const { call, output } of outputs) {
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.callId,
          output: JSON.stringify(output),
        },
      }))
    }
    ws.send(JSON.stringify({ type: 'response.create' }))
  }, [toolsEndpoint, updateState])

  const handleServerEvent = useCallback((event: Record<string, unknown>) => {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        // Barge-in: kill scheduled playback immediately.
        stopPlayback()
        assistantOpenRef.current = false
        updateState('listening')
        break

      case 'response.output_audio.delta':
        if (typeof event.delta === 'string') {
          playAudioDelta(event.delta)
          if (stateRef.current === 'listening' || stateRef.current === 'tool') {
            updateState('speaking')
          }
        }
        break

      case 'response.output_audio_transcript.delta':
        if (typeof event.delta === 'string') {
          appendAssistantDelta(event.delta)
        }
        break

      case 'conversation.item.input_audio_transcription.completed':
        if (typeof event.transcript === 'string' && event.transcript.trim()) {
          assistantOpenRef.current = false
          updateTranscript(prev => [...prev, { role: 'user', text: (event.transcript as string).trim() }])
        }
        break

      case 'response.function_call_arguments.done':
        if (typeof event.call_id === 'string' && typeof event.name === 'string') {
          callBufferRef.current.add({
            callId: event.call_id,
            name: event.name,
            arguments: typeof event.arguments === 'string' ? event.arguments : '{}',
          })
        }
        break

      case 'response.done':
        assistantOpenRef.current = false
        void runFunctionCalls()
        break

      case 'error':
        console.error('xAI realtime error:', event)
        break
    }
  }, [appendAssistantDelta, playAudioDelta, runFunctionCalls, stopPlayback, updateState, updateTranscript])

  const beginCapture = useCallback((ctx: AudioContext, stream: MediaStream, ws: WebSocket) => {
    const source = ctx.createMediaStreamSource(stream)
    const worklet = new AudioWorkletNode(ctx, 'pcm-recorder')
    source.connect(worklet)
    worklet.connect(ctx.destination) // worklet outputs silence; keeps the graph pulled

    const captureRate = ctx.sampleRate
    const batchSamples = Math.round(captureRate / 10) // ~100ms at native rate
    let pending: Float32Array[] = []
    let pendingLength = 0

    worklet.port.onmessage = (msg: MessageEvent<Float32Array>) => {
      if (ws.readyState !== WebSocket.OPEN) return
      pending.push(msg.data)
      pendingLength += msg.data.length
      if (pendingLength < batchSamples) return

      const batch = new Float32Array(pendingLength)
      let offset = 0
      for (const frame of pending) {
        batch.set(frame, offset)
        offset += frame.length
      }
      pending = []
      pendingLength = 0

      const resampled = captureRate === TARGET_RATE
        ? batch
        : downsampleLinear(batch, captureRate, TARGET_RATE)
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: float32ToPcm16Base64(resampled),
      }))
    }
  }, [])

  // MUST be called from a click handler: satisfies autoplay policy and
  // neutralizes strict-mode double-connect (no useEffect connections).
  const start = useCallback(async () => {
    if (stateRef.current === 'connecting' || stateRef.current === 'listening'
      || stateRef.current === 'speaking' || stateRef.current === 'tool') return

    stoppedRef.current = false
    setError(null)
    transcriptRef.current = []
    setTranscript([])
    callStartedAtRef.current = null
    flushedRef.current = false
    setMuted(false)
    callBufferRef.current.flush()
    updateState('connecting')

    try {
      const tokenRes = await fetch(tokenEndpoint, { method: 'POST' })
      if (!tokenRes.ok) {
        throw new Error(tokenRes.status === 500
          ? 'Voice assistant is not configured'
          : 'Could not start the voice session')
      }
      const { token, url, session } = await tokenRes.json() as TokenResponse
      if (stoppedRef.current) return

      // Mic prompt only after auth succeeded.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      if (stoppedRef.current) {
        stream.getTracks().forEach(t => t.stop())
        return
      }
      streamRef.current = stream

      const ctx = new AudioContext({ sampleRate: TARGET_RATE })
      audioContextRef.current = ctx
      await ctx.resume()

      const workletUrl = URL.createObjectURL(
        new Blob([RECORDER_WORKLET_SRC], { type: 'application/javascript' })
      )
      workletUrlRef.current = workletUrl
      await ctx.audioWorklet.addModule(workletUrl)
      if (stoppedRef.current) return

      // Browsers can't set headers on a WebSocket — the ephemeral token rides
      // as a subprotocol instead.
      const ws = new WebSocket(url, [`xai-client-secret.${token}`])
      wsRef.current = ws

      ws.onopen = () => {
        ws.send(JSON.stringify(session)) // session config first, before any audio
        callStartedAtRef.current = Date.now()
        // Tab close skips teardown; pagehide is the best-effort flush signal.
        window.addEventListener('pagehide', flushTranscript)
        beginCapture(ctx, stream, ws)
        updateState('listening')
      }
      ws.onmessage = (msg: MessageEvent) => {
        try {
          handleServerEvent(JSON.parse(msg.data as string) as Record<string, unknown>)
        } catch {
          // non-JSON frame — ignore
        }
      }
      ws.onerror = () => {
        if (stateRef.current === 'connecting') {
          setError('Could not connect to the voice service')
        }
        teardownRef.current(stateRef.current === 'connecting' ? 'error' : 'ended')
      }
      ws.onclose = () => {
        teardownRef.current('ended')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the voice session')
      teardownRef.current('error')
    }
  }, [beginCapture, flushTranscript, handleServerEvent, tokenEndpoint, updateState])

  const stop = useCallback(() => {
    teardownRef.current('ended')
  }, [])

  const toggleMute = useCallback(() => {
    setMuted(prev => {
      const next = !prev
      streamRef.current?.getAudioTracks().forEach(track => {
        track.enabled = !next
      })
      return next
    })
  }, [])

  useEffect(() => {
    return () => {
      // Strict-mode remounts run this on a hook that never started; only
      // tear down once a call actually holds resources.
      if (stateRef.current !== 'idle') {
        teardownRef.current('ended')
      }
    }
  }, [])

  return { state, transcript, start, stop, muted, toggleMute, error }
}
