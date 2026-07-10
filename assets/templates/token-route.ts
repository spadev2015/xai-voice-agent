/**
 * Ephemeral token mint — app/api/voice/token/route.ts (Next.js route handler).
 *
 * The browser can't hold XAI_API_KEY, and serverless can't host WebSockets,
 * so this route mints a short-lived client token and returns the complete
 * session.update payload the client will forward verbatim as its first frame.
 * Building the session server-side keeps instructions, tools, and any
 * per-user context authorized and out of client hands.
 *
 * See references/xai-realtime-api.md for the full protocol.
 */

export const maxDuration = 30

// ── Adapt to your app ────────────────────────────────────────────────────────
// Replace with your real auth (NextAuth, Supabase, Clerk, ...). Returning null
// yields a 401 before any xAI call is made.
async function getAuthenticatedUser(): Promise<{ id: string; name: string } | null> {
  // e.g. const session = await auth(); return session?.user ?? null
  return { id: 'demo-user', name: 'there' }
}

// Voice-specific system prompt. See SKILL.md phase 4 for the rules that make
// prompts work well when spoken aloud.
function buildVoiceInstructions(userName: string): string {
  return `You are a friendly voice assistant for Acme Scheduling. You are on a live voice call with ${userName}.

## Voice Rules
- This is a spoken conversation. Reply in 1-3 short sentences of plain spoken prose.
- Never use markdown, lists, emojis, or any formatting — everything you say is read aloud.
- Ask one question at a time.
- Spell confirmation codes out slowly, character by character, for example "A dash one four two".

## Your Capabilities
You can book appointments for the caller. For anything else, politely say it is outside what you can help with on this call.

## Booking
1. Ask what the appointment is for, then the preferred date and time, one question at a time.
2. Before booking, verbally confirm the date, time, and reason with the caller and wait for their agreement.
3. After booking, read the confirmation code slowly.

## Personality
- Warm but efficient. Acknowledge the caller, don't ramble.
- Never reveal internal tool names or implementation details.`
}

// Tool definitions advertised to the model. Keep these in one place with the
// server-side executors (see tools-route.ts); if you define tools with Zod,
// bridge via z.toJSONSchema — see references/function-calling.md.
function voiceToolDefinitions() {
  return [
    {
      type: 'function',
      name: 'bookAppointment',
      description:
        'Book an appointment for the caller. Confirm date, time, and reason with the caller before calling this.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'ISO date, e.g. 2026-03-14' },
          time: { type: 'string', description: '24-hour time, e.g. 14:30' },
          reason: { type: 'string', description: 'What the appointment is for' },
        },
        required: ['date', 'time', 'reason'],
        additionalProperties: false,
      },
    },
  ]
}
// ─────────────────────────────────────────────────────────────────────────────

export async function POST() {
  const user = await getAuthenticatedUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const apiKey = process.env.XAI_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'Voice assistant is not configured' }, { status: 500 })
  }

  const tokenRes = await fetch('https://api.x.ai/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    // 300s only needs to cover the WebSocket handshake — an open call
    // outlives its token. Reconnects mint a fresh one.
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
  })

  if (!tokenRes.ok) {
    console.error('xAI client_secrets failed:', tokenRes.status, await tokenRes.text())
    return Response.json({ error: 'Failed to start voice session' }, { status: 502 })
  }

  // The token has appeared both top-level and nested — parse defensively and
  // log key names (never values) so shape drift is visible in logs.
  const tokenJson = await tokenRes.json() as { value?: string; client_secret?: { value?: string } }
  const token = tokenJson.value ?? tokenJson.client_secret?.value
  if (!token) {
    console.error('xAI client_secrets: unexpected response shape', Object.keys(tokenJson))
    return Response.json({ error: 'Failed to start voice session' }, { status: 502 })
  }

  // Optional: an agent built in the xAI console. session.update below is sent
  // either way — per-user instructions and client-executed tools come from us.
  const agentId = process.env.XAI_VOICE_AGENT_ID
  const url = agentId
    ? `wss://api.x.ai/v1/realtime?agent_id=${agentId}`
    : 'wss://api.x.ai/v1/realtime?model=grok-voice-latest'

  const session = {
    type: 'session.update',
    session: {
      voice: 'ara',
      instructions: buildVoiceInstructions(user.name),
      turn_detection: { type: 'server_vad', silence_duration_ms: 600, idle_timeout_ms: 30000 },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { language_hint: 'en' },
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
        },
      },
      tools: voiceToolDefinitions(),
    },
  }

  return Response.json({ token, url, session })
}
