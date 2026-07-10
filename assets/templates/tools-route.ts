/**
 * Server-side tool executor — app/api/voice/tools/route.ts (Next.js route handler).
 *
 * Function calls arrive in the browser (it owns the WebSocket), but tools
 * execute HERE: auth is re-derived from the session on every call, so a
 * malicious client can only do what the user could already do.
 *
 * Error contract (references/function-calling.md):
 *   - Tool-level failures return HTTP 200 with { output: { error } } so the
 *     model can recover verbally instead of the call stalling.
 *   - 401/403 are the only hard failures — the client ends the call on those.
 */

import { z } from 'zod'

export const maxDuration = 30

// ── Adapt to your app ────────────────────────────────────────────────────────
async function getAuthenticatedUser(): Promise<{ id: string } | null> {
  // Same auth as token-route.ts — e.g. const session = await auth()
  return { id: 'demo-user' }
}

// One Zod schema per tool: it validates args here AND generates the JSON
// Schema advertised in session.update (via z.toJSONSchema — zod v4).
const bookAppointmentSchema = z.object({
  date: z.string().describe('ISO date, e.g. 2026-03-14'),
  time: z.string().describe('24-hour time, e.g. 14:30'),
  reason: z.string().describe('What the appointment is for'),
})

type ToolHandler = (args: unknown, userId: string) => Promise<Record<string, unknown>>

const tools: Record<string, { schema: z.ZodType; execute: ToolHandler }> = {
  bookAppointment: {
    schema: bookAppointmentSchema,
    execute: async (args, userId) => {
      const { date, time, reason } = args as z.infer<typeof bookAppointmentSchema>
      // Replace with your real write (database insert, calendar API, ...).
      // Return compact, speakable JSON — the model narrates this out loud.
      const confirmationCode = `A-${Math.floor(100 + Math.random() * 900)}`
      console.log('bookAppointment', { userId, date, time, reason })
      return { booked: true, date, time, reason, confirmationCode }
    },
  },
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a tool call from raw JSON args. Every failure path returns an
 * { error } payload — a dropped output stalls the conversation permanently,
 * so the model must always receive SOMETHING to respond to.
 */
async function executeVoiceTool(
  name: string,
  rawArgsJson: string,
  userId: string
): Promise<Record<string, unknown>> {
  const tool = tools[name]
  if (!tool) return { error: `Unknown tool: ${name}` }

  let args: unknown
  try {
    args = rawArgsJson.trim() === '' ? {} : JSON.parse(rawArgsJson)
  } catch {
    return { error: 'Tool arguments were not valid JSON' }
  }

  // The model occasionally sends schema-violating args; returning the
  // validation message lets it read the error and retry corrected.
  const parsed = tool.schema.safeParse(args)
  if (!parsed.success) {
    return {
      error: `Invalid tool arguments: ${parsed.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    }
  }

  try {
    return await tool.execute(parsed.data, userId)
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Tool execution failed' }
  }
}

export async function POST(req: Request) {
  const user = await getAuthenticatedUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { name, arguments: rawArgs } = await req.json() as { name?: string; arguments?: string }

  const output = await executeVoiceTool(
    name ?? '',
    typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {}),
    user.id
  )

  return Response.json({ output })
}
