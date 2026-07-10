# Browser audio pipeline — mic capture, PCM16 encoding, gapless playback, barge-in

The realtime API speaks **PCM16, mono, 24000 Hz, base64-encoded** in both directions. The browser gives you Float32 at whatever rate the hardware likes. This file explains the conversion pipeline; `assets/templates/voice-audio.ts` implements it as pure, unit-testable functions.

## Contents

1. [Capture: AudioWorklet](#capture-audioworklet)
2. [Batching](#batching)
3. [Encode: Float32 → PCM16 → base64](#encode)
4. [Resampling fallback](#resampling-fallback)
5. [Playback: gapless scheduling](#playback)
6. [Barge-in](#barge-in)
7. [Mic constraints](#mic-constraints)
8. [Lifecycle & teardown](#lifecycle)

## Capture: AudioWorklet

`ScriptProcessorNode` is deprecated and janky; use an `AudioWorkletNode`. Two constraints shape the design:

1. **Worklets can't import your app modules** and bundlers won't hand you a URL for a worklet file. Keep the processor as a source string and load it via a Blob URL:

```ts
const workletUrl = URL.createObjectURL(
  new Blob([RECORDER_WORKLET_SRC], { type: 'application/javascript' })
)
await ctx.audioWorklet.addModule(workletUrl)
// URL.revokeObjectURL(workletUrl) in teardown
```

2. **Keep the worklet dumb.** It runs on the audio thread; anything complex there is untestable and risky. The processor just copies each ~128-sample Float32 frame and posts it to the main thread, transferring the buffer (zero-copy):

```js
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
```

Wire-up: `mediaStreamSource → workletNode → ctx.destination`. The worklet outputs silence, but connecting it to the destination keeps the audio graph "pulled" so `process()` keeps firing.

## Batching

Worklet frames are ~128 samples (~5ms) — far too chatty to send individually. Accumulate on the main thread into ~100ms batches (`sampleRate / 10` samples) before encoding and sending:

```ts
worklet.port.onmessage = (msg) => {
  if (ws.readyState !== WebSocket.OPEN) return
  pending.push(msg.data); pendingLength += msg.data.length
  if (pendingLength < batchSamples) return
  const batch = concat(pending)            // one Float32Array
  pending = []; pendingLength = 0
  const resampled = captureRate === 24000 ? batch : downsampleLinear(batch, captureRate, 24000)
  ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: float32ToPcm16Base64(resampled) }))
}
```

~100ms is the sweet spot: small enough for sub-second latency, large enough that message overhead is negligible.

## Encode

Float32 samples are in [-1, 1]; PCM16 is little-endian signed 16-bit. Clamp, scale asymmetrically (negative range is 0x8000, positive 0x7FFF), then base64 the bytes:

```ts
const s = Math.max(-1, Math.min(1, samples[i]))
pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
```

**Critical:** encode the bytes to a binary string in ~8KB chunks. The naive `String.fromCharCode(...allBytes)` overflows the call stack on buffers bigger than ~100KB and only fails on longer audio, so it survives casual testing (`pitfalls.md` #2). Decode is the mirror image: `atob` → `Uint8Array` → `Int16Array` view → Float32 divide.

Write a round-trip unit test that uses a buffer **larger than the chunk size** — it's the regression test for the stack-overflow bug.

## Resampling fallback

Ask for the native rate up front — `new AudioContext({ sampleRate: 24000 })` — and most browsers comply, making resampling a no-op. But browsers may ignore the hint (`pitfalls.md` #3), so check `ctx.sampleRate` and fall back to linear interpolation when it differs:

```ts
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
```

Linear interpolation is theoretically inferior to a windowed-sinc filter, but for 48k→24k speech it's perceptually fine and dependency-free.

## Playback

Audio arrives as `response.output_audio.delta` events — each a base64 PCM16 chunk. Play them **gaplessly** by scheduling each chunk to start exactly when the previous one ends:

```ts
const buffer = ctx.createBuffer(1, samples.length, 24000)  // explicit 24k rate
buffer.copyToChannel(samples, 0)
const source = ctx.createBufferSource()
source.buffer = buffer
source.connect(ctx.destination)
const startAt = Math.max(ctx.currentTime, nextPlayTime)
source.start(startAt)
nextPlayTime = startAt + buffer.duration
liveSources.add(source)
source.onended = () => liveSources.delete(source)
```

Two things to notice:

- **Tag buffers with rate 24000 regardless of the context's actual rate** — the context resamples on playback for free. This is why playback needs no resampler even when capture does.
- **Track every live source in a `Set`.** Chunks are scheduled seconds into the future; barge-in must be able to kill all of them, not just the currently audible one.

## Barge-in

On `input_audio_buffer.speech_started` (the user started talking over the agent):

```ts
for (const source of liveSources) {
  try { source.stop() } catch { /* already stopped */ }
}
liveSources.clear()
nextPlayTime = 0
```

This makes interruption feel instant (~100ms). The server stops generating on its side; your job is only to silence what's already been scheduled locally. Also mark the assistant transcript entry closed so the next response opens a fresh one.

## Mic constraints

```ts
navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
})
```

`echoCancellation` is non-negotiable for speakers (vs headphones): without it the agent hears itself and barge-ins itself constantly (`pitfalls.md` #4). Mute is simply `track.enabled = false` on the audio tracks — no need to touch the graph.

## Lifecycle

Create and `resume()` the `AudioContext` inside the click handler that starts the call (autoplay policy — `pitfalls.md` #10). On teardown, in order: null + close the WebSocket, stop all live sources, stop all `MediaStream` tracks (this releases the browser's mic indicator), `ctx.close()`, revoke the worklet Blob URL. Guard teardown so it runs once (`pitfalls.md` #14).
