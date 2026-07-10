# Pitfalls — every gotcha we hit building a production xAI voice agent

Read this before debugging anything. Each entry is a real failure mode, why it happens, and the fix. The templates in `assets/templates/` already contain all of these fixes — this file explains *why* they're there so you don't "simplify" them away.

## Contents

1. [Token mint response shape drift](#1-token-mint-response-shape-drift)
2. [btoa call-stack overflow on large audio buffers](#2-btoa-call-stack-overflow)
3. [Browser ignores the requested sample rate](#3-browser-ignores-requested-sample-rate)
4. [Missing echo cancellation → agent interrupts itself](#4-missing-echo-cancellation)
5. [Exactly ONE `response.create` after ALL tool outputs](#5-exactly-one-responsecreate)
6. [A dropped `function_call_output` stalls the conversation forever](#6-dropped-function_call_output)
7. [300-second token covers the handshake only](#7-token-ttl-is-handshake-only)
8. [Transcript flush on tab close: `pagehide` + `keepalive`](#8-transcript-flush-on-tab-close)
9. [RLS scoping: org-wide vs per-user](#9-rls-scoping-org-vs-user)
10. [start() must be called from a click handler](#10-start-from-a-click-handler)
11. [AudioWorklet can't import app modules — load via Blob URL](#11-audioworklet-via-blob-url)
12. [React state isn't there at teardown time — mirror to a ref](#12-state-vs-ref-at-teardown)
13. [Barge-in must kill *scheduled* playback, not just current](#13-barge-in-kills-scheduled-playback)
14. [Single-fire teardown guard](#14-single-fire-teardown)
15. [Non-JSON frames on the socket](#15-non-json-frames)
16. [Mic permission prompt ordering](#16-mic-prompt-after-auth)

---

## 1. Token mint response shape drift

`POST https://api.x.ai/v1/realtime/client_secrets` has returned the ephemeral token both as a top-level `value` field and nested under `client_secret.value` at different times. If you destructure only one shape, the other silently yields `undefined` and the WebSocket handshake fails with an opaque auth error.

**Fix — parse defensively:**

```ts
const json = await res.json() as { value?: string; client_secret?: { value?: string } }
const token = json.value ?? json.client_secret?.value
if (!token) {
  console.error('client_secrets: unexpected response shape', Object.keys(json))
  return Response.json({ error: 'Failed to start voice session' }, { status: 502 })
}
```

Log `Object.keys(json)` (never the values — the token is a secret) so shape drift shows up in logs immediately.

## 2. btoa call-stack overflow

The obvious way to base64-encode PCM bytes is:

```ts
btoa(String.fromCharCode(...new Uint8Array(buffer)))  // ❌ blows up
```

`String.fromCharCode(...spread)` passes every byte as a function argument. Around ~100KB of audio (a few seconds), you exceed the JS engine's max argument count and get `RangeError: Maximum call stack size exceeded` — but only on longer buffers, so it passes casual testing and fails in real calls.

**Fix — encode in ~8KB chunks:**

```ts
const CHUNK_SIZE = 8192
let binary = ''
for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
  binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE))
}
return btoa(binary)
```

Write a unit test with a buffer larger than 8192 samples — it's the only way to catch a regression here.

## 3. Browser ignores requested sample rate

You ask for `new AudioContext({ sampleRate: 24000 })`, but browsers are allowed to ignore the hint (some hardware/OS combos lock the context to 44100 or 48000). If you then send that audio labeled as 24kHz, the agent hears you slowed down / pitched — speech recognition quality collapses.

**Fix — check `ctx.sampleRate` at runtime and resample when it differs:**

```ts
const resampled = captureRate === TARGET_RATE
  ? batch
  : downsampleLinear(batch, captureRate, TARGET_RATE)
```

A simple linear-interpolation resampler is fine for speech (see `assets/templates/voice-audio.ts`). For **playback** the reverse problem is free: create each `AudioBuffer` with an explicit 24000 rate and the context resamples on output automatically.

## 4. Missing echo cancellation

Without echo cancellation, the agent's own voice comes out of the speakers, back into the mic, and the server's voice-activity detection treats it as the user speaking — the agent barge-ins *itself*, constantly, mid-sentence. Looks exactly like a flaky VAD config; it isn't.

**Fix — request all three processing constraints:**

```ts
navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
})
```

## 5. Exactly ONE `response.create`

The model can emit several function calls in a single response (parallel tool calls). The protocol contract is: send a `function_call_output` conversation item for **every** call, then **exactly one** `response.create`. Sending `response.create` per output makes the model start responding after the first result and either talk over itself or error on the later `response.create` frames.

**Fix — accumulate calls, flush once.** Buffer `response.function_call_arguments.done` events; on `response.done`, execute all calls (e.g. `Promise.all`), send all outputs, then one `response.create`. The `createFunctionCallBuffer()` helper in `assets/templates/voice-audio.ts` is this state machine, and it's unit-testable.

## 6. Dropped `function_call_output`

If a tool call fails (network error, server 500, thrown exception) and you don't send a `function_call_output` for its `call_id`, the model waits for it **forever**. The call doesn't error — it just goes permanently silent. This is the single worst failure mode in the whole system because there's no visible error anywhere.

**Fix — failures become outputs.** Every execution path must resolve to *something* to send:

```ts
try {
  const res = await fetch('/api/voice/tools', { ... })
  if (!res.ok) return { call, output: { error: `Tool request failed (${res.status})` } }
  return { call, output: (await res.json()).output ?? { error: 'Empty tool output' } }
} catch {
  return { call, output: { error: 'Tool request failed' } }
}
```

An `{ error: "..." }` output lets the model recover verbally ("I'm having trouble with that right now"). Server-side, mirror the same rule: tool-level failures return HTTP 200 with `{ output: { error } }`; reserve 401/403 for auth (where the client should end the call).

## 7. Token TTL is handshake-only

The ephemeral token (`expires_after: { seconds: 300 }`) authenticates the WebSocket **handshake**. Once the socket is open, the call can run past the 5-minute mark with no problem — mid-session expiry is a non-event. Don't build token-refresh machinery for a live call. Reconnects (new call, network drop) simply mint a fresh token via your token route.

## 8. Transcript flush on tab close

If you persist transcripts at call end, the user closing the tab mid-call skips your teardown path entirely. `beforeunload` fetches get killed; `visibilitychange` fires too often.

**Fix — `pagehide` listener + `fetch(..., { keepalive: true })`:**

- Register `window.addEventListener('pagehide', flush)` when the call starts; remove it in teardown.
- `keepalive: true` lets the browser finish the POST after the page is gone.
- **Caveat:** keepalive bodies are capped at **64KB**. Cap your transcript payload (e.g. max 500 entries) so the flush never silently exceeds it.
- Guard against double-send: both teardown and pagehide call the same flush function, gated by a `flushed` ref that starts `true` (so stray teardowns before the first call never flush) and is set `false` in `start()`.

## 9. RLS scoping: org vs user

If you persist transcripts to a multi-tenant database (e.g. Supabase with row-level security), think about *who can read a voice transcript*. An org-scoped `FOR ALL` policy means any user in the org — including *other end-users* — can read everyone's call transcripts through the raw REST API, even if your UI never shows them. Voice transcripts are conversational and personal; scope reads to `user_id = auth.uid()` for end-users, with a separate policy for staff roles.

Related: never trust IDs the client sends alongside a transcript (e.g. "this call created record X"). Verify the ID is visible through the caller's own RLS-scoped client before linking it; if not visible, save unlinked rather than failing.

## 10. start() from a click handler

Two independent browser rules both require the call to start from a user gesture:

1. **Autoplay policy** — an `AudioContext` created/resumed outside a user gesture starts `suspended` and plays nothing. The agent "connects" but you hear silence.
2. **React strict mode** — starting the connection in `useEffect` double-connects in development (mount → unmount → mount). Starting from the click handler sidesteps this entirely; the unmount cleanup only needs to tear down a call that actually started.

So: `start()` is invoked only from `onClick`, creates and `resume()`s the `AudioContext` inside the handler, and the `useEffect` cleanup guards on state (`if (state !== 'idle') teardown()`).

## 11. AudioWorklet via Blob URL

`AudioWorklet` code runs in a separate global scope and **cannot import your app's modules** — and bundlers (Next.js/webpack/Turbopack) don't give you a stable URL for a worklet file. The portable trick: keep the processor source as a string constant and load it through a Blob URL:

```ts
const url = URL.createObjectURL(new Blob([RECORDER_WORKLET_SRC], { type: 'application/javascript' }))
await ctx.audioWorklet.addModule(url)
// remember to URL.revokeObjectURL(url) in teardown
```

The worklet should do the minimum (post raw Float32 frames, transferring the buffer); do the batching/encoding on the main thread where you can test it.

## 12. State vs ref at teardown

Teardown (socket close, tab hide) can fire in the **same tick** as the last transcript event — before React has committed the `setState`. If your flush reads the `transcript` state, it silently loses the last utterance(s).

**Fix:** route every transcript write through one updater that writes a ref first, then state:

```ts
const updateTranscript = (updater) => {
  transcriptRef.current = updater(transcriptRef.current)
  setTranscript(transcriptRef.current)
}
```

Flush reads `transcriptRef.current`. Same reasoning applies to any value teardown needs (call start time, created-record IDs): refs, not state. Also keep the updater pure — don't mutate other refs inside a `setState` callback.

## 13. Barge-in kills *scheduled* playback

Gapless playback works by scheduling each audio chunk at `nextPlayTime` in the future. When the user interrupts (`input_audio_buffer.speech_started`), stopping "the current source" isn't enough — chunks already scheduled seconds ahead will still play. Track **every** live `AudioBufferSourceNode` in a `Set`, and on barge-in stop them all and reset `nextPlayTime` to 0.

## 14. Single-fire teardown

Teardown is reachable from at least five paths: user clicks End, dialog closes, WebSocket `onclose`, WebSocket `onerror`, component unmount — and several of these cascade into each other (closing the WS fires `onclose`). Guard with a `stopped` ref set at the top of teardown, and null the WS event handlers before closing so the close you initiated doesn't re-enter teardown.

## 15. Non-JSON frames

Wrap `JSON.parse(msg.data)` in try/catch and ignore failures. The server occasionally sends frames you don't expect; one unparseable frame must not kill the event loop. Similarly, `switch` on `event.type` and ignore unknown types — the event catalog grows.

## 16. Mic prompt after auth

Order the `start()` sequence: **token fetch first, `getUserMedia` second**. If you prompt for the mic before your server authorizes the session, users grant mic permission and *then* see an error — the worst UX order. Also check a `stopped` ref after every `await` in `start()`: the user may hang up while the token fetch or mic prompt is still pending, and the late-resolving promise must not resurrect the call (stop the just-granted tracks and return).
