---
name: xai-voice-agent
description: Build a production-quality realtime voice agent with xAI's Grok Voice API — browser mic to speech-to-speech WebSocket with function calling and optional transcript persistence. Use this whenever the user wants to add voice to an app - "voice agent", "voice assistant", "talk to my app", "speech-to-speech", "realtime voice", "voice AI", "let users call/speak to the AI" — or mentions xAI/Grok voice, wss://api.x.ai, grok-voice, or ephemeral realtime tokens. Use it even when the user doesn't name xAI but wants a realtime conversational voice agent built, and even if they only want a piece of it (mic streaming, voice function calling, keeping the API key off the client).
---

# Build an xAI Grok Voice Agent

You are guiding the user through building a **realtime speech-to-speech voice agent** on xAI's Grok Voice API. This knowledge comes from a production integration — xAI publishes no end-to-end guide, and several parts (WebSocket subprotocol auth, the function-call sequencing rule) are effectively unguessable, so trust these instructions over intuition from other providers' APIs.

## The architecture in one paragraph

The browser connects **directly** to `wss://api.x.ai/v1/realtime` — serverless hosts can't proxy WebSockets, and it's lower latency anyway. Your server's only realtime jobs: mint a short-lived **ephemeral token** (so `XAI_API_KEY` never reaches the client) and **execute tool calls** behind normal session auth. Audio is PCM16 mono 24kHz base64 both ways. The token rides as a WebSocket **subprotocol** (`xai-client-secret.<token>`) because browsers can't set headers on WebSockets.

```
Browser ──POST /api/voice/token──▶ Server (XAI_API_KEY) ──▶ xAI client_secrets
   │◀── { token, url, session } ──┘
   ├── WebSocket(url, ['xai-client-secret.' + token]) ◀──speech-to-speech──▶ xAI
   └──POST /api/voice/tools {name, args}──▶ Server (session auth + your DB)
```

## Resources

| File | What's in it | Read when |
|---|---|---|
| `references/pitfalls.md` | All 16 gotchas we hit, with fixes | **Before writing any code**, and first stop when debugging |
| `references/xai-realtime-api.md` | Endpoints, token mint, subprotocol auth, session.update, full event catalog | Phases 2–3 |
| `references/audio-pipeline.md` | AudioWorklet capture, PCM16 encode/decode, gapless playback, barge-in | Phase 3 |
| `references/function-calling.md` | Tool schemas, Zod bridge, the execution loop, error contract | Phase 5 |
| `references/persistence-supabase.md` | Transcript save-at-call-end, keepalive flush, RLS, calls dashboard | Phase 6 |
| `assets/templates/*.ts(x)` | Drop-in TypeScript: token route, tools route, hook, audio helpers, dialog UI | Copy + adapt per phase |

The templates are written for **Next.js App Router + React**. For other stacks, keep the architecture and the pitfalls (they're browser/protocol facts, not framework facts) and translate: the token route is any authenticated server endpoint, the tools route likewise, the hook becomes your framework's stateful client component.

## Step 0 — Interview the user

Before building, ask these three questions (in one message, concisely). The answers select which phases below you run:

1. **Existing app or fresh scaffold?** If existing: which framework, and how is auth done? If fresh: offer to scaffold Next.js.
2. **Should the agent be able to *do* things** (function calling — book, create, look up records), or just talk?
3. **Do transcripts need to be saved** (dashboard, audit, analytics)? If yes: do they have Supabase/Postgres or another store?

Also confirm they have (or can create) an xAI account — the API key is the only hard prerequisite.

Then run: Phases 1–4 always; Phase 5 if function calling; Phase 6 if persistence; Phase 7 always.

## Phase 1 — Prerequisites

1. User creates an API key at [console.x.ai](https://console.x.ai).
2. Set it as `XAI_API_KEY` in the server environment (`.env.local` for Next.js dev; hosting provider env vars for prod). **Server-only — never `NEXT_PUBLIC_`**, never imported in client code. Don't read or print the user's `.env.local` contents; just tell them what to put there.
3. Optional: `XAI_VOICE_AGENT_ID` if they built an agent in the xAI console (see `references/xai-realtime-api.md` → agent_id mode).

## Phase 2 — Token endpoint

Copy `assets/templates/token-route.ts` → `app/api/voice/token/route.ts` and adapt the marked block:

- Wire `getAuthenticatedUser()` to their real auth. If the app has open access, say so explicitly and rate-limit instead — an unauthenticated token mint is a way for strangers to spend the user's xAI credits.
- Have the route return `{ token, url, session }` — build the **complete `session.update` server-side** so instructions and tool schemas never depend on the client. The template's session shape (voice `ara`, `server_vad`, PCM 24kHz in/out, `transcription.language_hint`) is known-good; explain that changing audio format keys is the #1 way to get silent failures.
- Keep the defensive token parse (`json.value ?? json.client_secret?.value`) — the response shape has drifted before.

Verify: `curl -X POST localhost:3000/api/voice/token` (with a session cookie if authed) returns a token and a session payload.

## Phase 3 — Voice client

Copy `assets/templates/voice-audio.ts` (pure helpers — usually zero changes) and `assets/templates/use-voice-agent.ts` (the hook) into the app, then `assets/templates/voice-dialog.tsx` for UI (or adapt to their design system).

Explain the invariants they must not "clean up" later:

- `start()` is only ever called from a click handler (autoplay policy + React strict mode).
- Token fetch **before** mic prompt (never ask for the mic and then fail auth).
- `session.update` is the **first frame** sent after `onopen`, before any audio.
- Barge-in stops **all** scheduled audio sources, not just the current one.
- Teardown is single-fire and reachable from five paths.

Verify with a **hello round-trip**: run the app, click Start, say "hello", hear the agent respond, watch the transcript render, then end the call and confirm the browser's mic indicator goes away. If anything fails, go straight to `references/pitfalls.md`.

## Phase 4 — Persona / system prompt

Voice prompts are different from chat prompts — everything the model outputs is read aloud. Rewrite the template's `buildVoiceInstructions()` with the user for their domain, keeping these rules in the prompt:

- Reply in **1–3 short sentences** of plain spoken prose.
- **No markdown, lists, emojis, or formatting** — it all gets spoken literally.
- **One question at a time.**
- **Spell IDs/codes character by character**, slowly ("A dash one four two").
- **Confirm before any write**: verbally restate the details and wait for agreement before calling a tool that creates or changes data (speech recognition mishears; confirmation is cheap).
- Name a narrow capability set and a polite redirect for everything else — voice agents that try to do everything ramble.

## Phase 5 — Function calling (if the agent does things)

Read `references/function-calling.md`, then copy `assets/templates/tools-route.ts` → `app/api/voice/tools/route.ts` and replace the demo `bookAppointment` tool with their real tools (same auth as the token route).

The two rules that are genuinely load-bearing — state them to the user:

1. **Every function call gets a `function_call_output`, no matter what.** A dropped output stalls the call permanently with no error. Failures become `{ error: "..." }` outputs the model recovers from verbally.
2. **Exactly one `response.create` after ALL outputs** for a response — the model can make parallel calls; buffer until `response.done` (the hook + `createFunctionCallBuffer` already do this).

If their server tools use Zod, bridge schemas with `z.toJSONSchema` (zod v4) so one schema both validates args and advertises the tool.

Verify: a call where the user asks for the tool's action end-to-end — the agent confirms verbally, the server executes (check the record/log), and the agent speaks the result.

## Phase 6 — Transcript persistence (if wanted)

Read `references/persistence-supabase.md` and follow it: schema (or a `channel` column on existing chat tables), the save endpoint, and the client flush (already in the hook — just pass `transcriptEndpoint` in the hook options). The critical details: flush once at call end gated by a ref, `pagehide` + `keepalive: true` for tab close (64KB body cap), never trust client-sent record IDs, and scope end-user read policies to the individual, not the org.

## Phase 7 — Test checklist

Walk the user through this before calling it done:

- [ ] Mic permission: prompt appears only after token auth; denying it lands in a clean error state.
- [ ] Hello round-trip: speak → agent answers audibly → transcript shows both sides.
- [ ] **Barge-in**: interrupt the agent mid-sentence — its audio stops within ~100ms.
- [ ] Mute: agent stops hearing you; unmute resumes.
- [ ] End call / close dialog: browser mic indicator disappears immediately.
- [ ] (Phase 5) Tool round-trip: request the action → verbal confirmation → record created → result spoken; and a forced tool failure gets a spoken recovery, not silence.
- [ ] (Phase 6) Transcript row appears after hangup; closing the tab mid-call still saves (pagehide flush); instant hangup creates nothing.
- [ ] Idle timeout: stay silent past `idle_timeout_ms` — the call ends cleanly rather than hanging.
- [ ] `XAI_API_KEY` appears nowhere in client bundles (`grep -r XAI_API_KEY` outside server routes finds nothing).
- [ ] Test in Chrome **and** Safari (Safari is where sample-rate and autoplay differences bite); deploy to a preview environment to validate env vars and the no-server-WebSocket assumption.

## Debugging quick map

| Symptom | Likely cause | Pitfall # |
|---|---|---|
| WS closes immediately after connect | Token not in subprotocol, or expired/unparsed token | 1 |
| `RangeError: Maximum call stack size exceeded` | Unchunked btoa | 2 |
| Agent hears you slow/pitched, poor recognition | Context sample rate ≠ 24k, no resample | 3 |
| Agent keeps interrupting itself | Missing echoCancellation | 4 |
| Agent talks over itself after tools | `response.create` per output | 5 |
| Call goes permanently silent after a tool call | Dropped `function_call_output` | 6 |
| Connects but silence, no audio ever | AudioContext suspended (not started from click) | 10 |
| Last thing the user said missing from saved transcript | Flushed from state, not ref | 12 |
