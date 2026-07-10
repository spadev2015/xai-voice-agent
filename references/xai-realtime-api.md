# xAI Realtime Voice API — protocol reference

Everything here was verified against a working production integration. xAI's realtime API closely resembles the OpenAI Realtime API event protocol, but the **authentication mechanism and session shape are xAI-specific** — don't assume OpenAI docs transfer 1:1.

## Contents

1. [Endpoints & models](#endpoints--models)
2. [Ephemeral token mint](#ephemeral-token-mint)
3. [WebSocket auth via subprotocol](#websocket-auth-via-subprotocol)
4. [session.update — the first client frame](#sessionupdate)
5. [Event catalog: client → server](#events-client--server)
6. [Event catalog: server → client](#events-server--client)
7. [Console-built agents (agent_id mode)](#agent_id-mode)
8. [Voices](#voices)

## Endpoints & models

| Purpose | Endpoint |
|---|---|
| Mint ephemeral client token | `POST https://api.x.ai/v1/realtime/client_secrets` |
| Realtime WebSocket (model mode) | `wss://api.x.ai/v1/realtime?model=grok-voice-latest` |
| Realtime WebSocket (console agent) | `wss://api.x.ai/v1/realtime?agent_id=agent_...` |

`grok-voice-latest` is the rolling alias for the current speech-to-speech model — prefer it unless you need to pin a version. Get an API key at [console.x.ai](https://console.x.ai); store it as a server-side env var (e.g. `XAI_API_KEY`). It must never reach the browser — see the token flow below.

## Ephemeral token mint

Serverless platforms (Vercel etc.) can't host long-lived WebSocket servers, and the API key can't ship to the client. The solution: the browser connects **directly** to xAI, authenticated with a short-lived token your server mints.

```
Browser ── POST /api/voice/token ──▶ Your server (has XAI_API_KEY)
                                        │ POST https://api.x.ai/v1/realtime/client_secrets
                                        ▼
Browser ◀── { token, url, session } ────┘
   │
   └── new WebSocket(url, ['xai-client-secret.' + token]) ──▶ wss://api.x.ai/v1/realtime
```

Request:

```http
POST https://api.x.ai/v1/realtime/client_secrets
Authorization: Bearer <XAI_API_KEY>
Content-Type: application/json

{ "expires_after": { "seconds": 300 } }
```

Response: the token has appeared both as top-level `value` and as `client_secret.value` — parse both (see `pitfalls.md` #1):

```ts
const token = json.value ?? json.client_secret?.value
```

The TTL only needs to cover the WebSocket **handshake** — an open call outlives the token with no issue. 300s is generous; don't build refresh machinery.

**Best practice:** have the token route return `{ token, url, session }` — the full `session.update` payload built server-side. The client forwards `session` verbatim. This keeps instructions, tool schemas, and per-user context on the server where they're authorized and versioned, and the client stays a dumb pipe.

## WebSocket auth via subprotocol

Browsers can't set an `Authorization` header on `new WebSocket()`. xAI accepts the token as a **WebSocket subprotocol**:

```ts
const ws = new WebSocket(url, [`xai-client-secret.${token}`])
```

That second argument is the subprotocol list; the token rides inside the `Sec-WebSocket-Protocol` header during the handshake. If the token is invalid/expired, the handshake fails (surfaces as `onerror` then `onclose` — you never get a readable HTTP status from browser JS, so map "error while connecting" to a friendly message).

## session.update

Send this as the **first frame** after `onopen`, before any audio:

```jsonc
{
  "type": "session.update",
  "session": {
    "voice": "ara",
    "instructions": "<your system prompt — see SKILL.md phase 4>",
    "turn_detection": {
      "type": "server_vad",          // server-side voice activity detection
      "silence_duration_ms": 600,     // how long a pause ends the user's turn
      "idle_timeout_ms": 30000        // hang up after 30s of total silence
    },
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "transcription": { "language_hint": "en" }
      },
      "output": {
        "format": { "type": "audio/pcm", "rate": 24000 }
      }
    },
    "tools": [ /* function definitions — see function-calling.md */ ]
  }
}
```

Notes:

- **`server_vad`** means the server decides when the user stopped talking — you just stream mic audio continuously and never send manual commits. This is what you want for natural conversation.
- `silence_duration_ms: 600` is a good conversational default; lower feels snappier but clips slow talkers.
- Include `transcription.language_hint` if you want user-speech transcription events (needed for showing/persisting transcripts).
- PCM at 24000 Hz mono is the native rate; see `audio-pipeline.md` for encode/decode.

## Events: client → server

| Event | When | Shape |
|---|---|---|
| `session.update` | Once, immediately after `onopen` | See above |
| `input_audio_buffer.append` | Continuously (~10×/s) while capturing | `{ "type": "input_audio_buffer.append", "audio": "<base64 pcm16>" }` |
| `conversation.item.create` (function_call_output) | After executing each tool call | `{ "type": "conversation.item.create", "item": { "type": "function_call_output", "call_id": "...", "output": "<JSON string>" } }` |
| `response.create` | Exactly once after ALL outputs for a response are sent | `{ "type": "response.create" }` |

With `server_vad` there is no manual `input_audio_buffer.commit` — the server segments turns itself.

## Events: server → client

Handle these; ignore unknown types (the catalog grows):

| Event | Meaning | What to do |
|---|---|---|
| `input_audio_buffer.speech_started` | User started talking (VAD) | **Barge-in**: stop all scheduled playback, reset play cursor, state → listening |
| `response.output_audio.delta` | Chunk of agent speech | `event.delta` is base64 PCM16@24k — decode and schedule gapless playback |
| `response.output_audio_transcript.delta` | Text of what the agent is saying | Append to the current assistant transcript entry |
| `conversation.item.input_audio_transcription.completed` | Transcription of the user's finished turn | `event.transcript` — append as a user transcript entry |
| `response.function_call_arguments.done` | The model wants a tool call | Buffer `{ call_id, name, arguments }` — do NOT execute yet |
| `response.done` | The model finished its response | Now execute all buffered calls, send outputs + one `response.create`; if no calls, state → listening |
| `error` | Server-side error | Log it; usually non-fatal |

Two subtleties:

- **Function calls execute on `response.done`, not on `arguments.done`.** A response may contain several calls (parallel tools); `response.done` is the barrier that tells you the set is complete. See `function-calling.md`.
- Assistant transcript deltas stream across many events. Track whether an assistant entry is "open" (still receiving deltas); close it on `response.done`, `speech_started`, or when a user transcription arrives, so the next response starts a new entry.

## agent_id mode

If you build an agent in the xAI console (Voice Agent Builder), it's addressable as `wss://api.x.ai/v1/realtime?agent_id=agent_...`. Support it as an optional env var (e.g. `XAI_VOICE_AGENT_ID`).

**Still send your `session.update`** in agent_id mode. Per-user instructions and client-executed tool definitions have to come from your server either way; the session update overrides/merges over the console agent's config. If the API ever rejects overrides for a console agent, fall back to `?model=grok-voice-latest` — the console agent remains useful for xAI's hosted telephony path.

## Voices

`"ara"` is xAI's flagship voice and the one this guide is verified with. The console (console.x.ai) lists the currently available voice ids — check there for alternatives, as the lineup changes; the Grok app's voice names don't all map 1:1 to API voice ids.

## Phone / SIP (future path)

xAI offers native SIP telephony: provision a number in the console, receive a signed `realtime.call.incoming` webhook, and open a server-side control WebSocket (`wss://api.x.ai/v1/realtime?call_id=...`, authenticated with the API key — no ephemeral token needed server-side). That path needs caller identification logic (caller-ID lookup with a verbal fallback) and tiered authorization (unverified callers can *create* things but must not *read* personal data). It's out of scope for the browser walkthrough but the architecture above (server-executed tools, server-built prompts) carries over directly.
