# xai-voice-agent — a Claude Code skill built with Fable 5

**Talk to your app.** This skill teaches Claude Code how to build a production-quality realtime voice agent on [xAI's Grok Voice API](https://console.x.ai) — browser microphone → speech-to-speech WebSocket → function calling → optional transcript persistence.


## Why this exists

xAI's realtime voice API is powerful but has **no end-to-end guide**, and several parts are unguessable:

- The ephemeral token rides as a **WebSocket subprotocol** (`xai-client-secret.<token>`) — browsers can't set auth headers on WebSockets.
- After tool calls: **every** call gets a `function_call_output`, then **exactly one** `response.create` — get this wrong and the call goes permanently silent with no error.
- `btoa` on unchunked audio overflows the JS call stack — but only on buffers long enough that casual testing misses it.
- Browsers may silently ignore your requested 24kHz sample rate.

This skill packages a working production integration — the protocol, the audio pipeline, drop-in TypeScript templates, and all 16 pitfalls we hit so you don't have to.

## What you get

```
xai-voice-agent/
├── SKILL.md                     # interactive guided build (interview → 7 phases → test checklist)
├── references/
│   ├── xai-realtime-api.md      # endpoints, token mint, subprotocol auth, full event catalog
│   ├── audio-pipeline.md        # AudioWorklet capture, PCM16@24kHz, gapless playback, barge-in
│   ├── function-calling.md      # tool schemas, Zod bridge, the execution loop, error contract
│   ├── persistence-supabase.md  # optional: save transcripts + calls dashboard + RLS notes
│   └── pitfalls.md              # 16 real failure modes with fixes
└── assets/templates/            # drop-in TypeScript (Next.js App Router + React)
    ├── token-route.ts           # ephemeral token mint endpoint
    ├── tools-route.ts           # server-side tool executor (sample bookAppointment tool)
    ├── use-voice-agent.ts       # the full client hook (WS, audio, barge-in, tool loop)
    ├── voice-audio.ts           # pure audio/protocol helpers (unit-testable)
    └── voice-dialog.tsx         # minimal call UI (orb + transcript + mute/end)
```

Next.js-first (the proven path), with enough conceptual grounding that Claude adapts it to other stacks.

## Install

**Claude Code (as a personal skill):**

```bash
git clone https://github.com/spadev2015/xai-voice-agent ~/.claude/skills/xai-voice-agent
```

**Or as a project skill** (shared with your team via the repo):

```bash
git clone https://github.com/spadev2015/xai-voice-agent .claude/skills/xai-voice-agent
```

**Or the packaged `.skill` file:** download `xai-voice-agent.skill` from [Releases](../../releases) and install it via your Claude client's skill installer.

Then just ask Claude:

> "Add a voice assistant to my app so users can talk to it"

Claude will interview you (existing app? function calling? transcripts?) and walk the build phase by phase.

## Prerequisites

- An xAI API key from [console.x.ai](https://console.x.ai) (`XAI_API_KEY`, server-side only)
- A web app (templates target Next.js App Router + React; the architecture ports anywhere)
- ~30 minutes for the core build

## Architecture

```
Browser ──POST /api/voice/token──▶ Your server (XAI_API_KEY) ──▶ xAI client_secrets
   │◀── { token, url, session } ──┘
   ├── WebSocket(url, ['xai-client-secret.' + token]) ◀──speech-to-speech──▶ xAI
   └──POST /api/voice/tools {name, args}──▶ Your server (session auth + your DB)
```

The browser talks to xAI directly (serverless can't hold WebSockets; it's lower latency anyway). Your server only mints short-lived tokens and executes tools behind your normal auth — the API key never leaves the server, and a malicious client can only do what the signed-in user could already do.

## Credits

Extracted from a real production integration. MIT licensed — use it, fork it, ship voice agents.
