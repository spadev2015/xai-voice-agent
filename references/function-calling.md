# Function calling — tools the voice agent can invoke

The realtime API supports function calling, but the execution loop is *yours* to run: the model asks for calls over the socket, your client executes them (via your server), and you feed results back. Getting the sequencing right is the difference between a working agent and one that goes permanently silent.

## Contents

1. [Architecture: where tools execute](#architecture)
2. [Tool definitions in session.update](#tool-definitions)
3. [Zod → JSON Schema](#zod--json-schema)
4. [The execution loop](#the-execution-loop)
5. [Error contract](#error-contract)
6. [Voice-specific tool design](#voice-specific-tool-design)

## Architecture

Function call events arrive **in the browser** (it owns the socket), but tools must execute **on your server** — that's where your database, secrets, and authorization live. The pattern:

```
xAI ──(function_call_arguments.done)──▶ Browser
Browser ──POST /api/voice/tools {name, arguments}──▶ Your server
                                                       │ auth from session cookies
                                                       │ validate args, execute
Browser ◀──────────── { output } ──────────────────────┘
Browser ──(function_call_output ×N, then response.create ×1)──▶ xAI
```

Security property worth stating in your head: **a malicious client can only do what the user could already do.** The tools route re-derives identity from the session cookie on every call and executes with the user's own database permissions (RLS if you're on Supabase). The browser never holds credentials beyond its own session; the tool names/args it can send are just another API surface with normal auth.

## Tool definitions

Tools go in the `session.update` payload as flat function definitions (note: **not** nested under a `function` key like OpenAI chat completions):

```jsonc
"tools": [
  {
    "type": "function",
    "name": "bookAppointment",
    "description": "Book an appointment for the caller. Confirm date and time with them before calling this.",
    "parameters": {
      "type": "object",
      "properties": {
        "date": { "type": "string", "description": "ISO date, e.g. 2026-03-14" },
        "time": { "type": "string", "description": "24h time, e.g. 14:30" },
        "reason": { "type": "string" }
      },
      "required": ["date", "time", "reason"]
    }
  }
]
```

`parameters` is standard JSON Schema. Build the definitions server-side and ship them to the client inside the `session` payload from your token route — the client shouldn't know or care what the tools are.

## Zod → JSON Schema

If your server already defines tools with Zod schemas (e.g. AI SDK tools), bridge them instead of hand-writing JSON Schema twice. Zod v4 has this built in:

```ts
import { z } from 'zod'  // zod ^4

export function toToolDefinitions(tools: Record<string, { description?: string; inputSchema: z.ZodType }>) {
  return Object.entries(tools).map(([name, t]) => {
    const parameters = z.toJSONSchema(t.inputSchema, { io: 'input' }) as Record<string, unknown>
    delete parameters.$schema   // xAI doesn't need the meta-field
    return { type: 'function' as const, name, description: t.description ?? '', parameters }
  })
}
```

This gives you one source of truth: the same Zod schema validates args at execution time (see below) and advertises the shape to the model.

## The execution loop

The sequencing rule that everything hinges on:

> Buffer calls as they arrive. Execute on `response.done`. Send **every** output. Send **exactly one** `response.create`.

Why buffered: a single model response can contain **multiple** function calls (parallel tool use). `response.function_call_arguments.done` fires once per call; `response.done` is the barrier that says the set is complete. Executing eagerly per-call and sending `response.create` per-output makes the model start talking after the first result (`pitfalls.md` #5).

The buffer is a trivial, unit-testable state machine (in `assets/templates/voice-audio.ts`):

```ts
export function createFunctionCallBuffer() {
  let pending: PendingFunctionCall[] = []
  return {
    add(call: PendingFunctionCall) { pending.push(call) },
    flush(): PendingFunctionCall[] { const calls = pending; pending = []; return calls },
  }
}
```

And the loop (from the hook template, simplified):

```ts
case 'response.function_call_arguments.done':
  buffer.add({ callId: event.call_id, name: event.name, arguments: event.arguments ?? '{}' })
  break

case 'response.done': {
  const calls = buffer.flush()
  if (calls.length === 0) { setState('listening'); break }
  setState('tool')
  const outputs = await Promise.all(calls.map(execute))   // every promise resolves — no rejections
  if (ws.readyState !== WebSocket.OPEN) return            // call ended mid-flight: drop silently
  for (const { call, output } of outputs) {
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: call.callId, output: JSON.stringify(output) },
    }))
  }
  ws.send(JSON.stringify({ type: 'response.create' }))    // exactly one
}
```

Note `output` is a **JSON string**, not an object.

## Error contract

The iron rule: **every `call_id` gets an output, no matter what.** A dropped output stalls the conversation permanently with no visible error (`pitfalls.md` #6). So design errors in layers:

| Layer | Failure | Response |
|---|---|---|
| Server tool execution | Unknown tool, invalid args, thrown error, DB error | HTTP **200** with `{ output: { error: "human-readable reason" } }` |
| Client fetch | Network failure, non-OK status | Synthesize `{ error: "Tool request failed" }` as the output |
| Auth | 401/403 from the tools route | The one hard failure: end the call (the session is dead anyway) |

`{ error }` outputs let the model recover *verbally* — it will say something like "I'm having trouble booking that right now" and the conversation continues. That's strictly better than a stalled call.

Server-side, validate args yourself (the model *does* occasionally send malformed or schema-violating JSON):

```ts
let args: unknown
try { args = rawArgsJson.trim() === '' ? {} : JSON.parse(rawArgsJson) }
catch { return { error: 'Tool arguments were not valid JSON' } }

const parsed = tool.inputSchema.safeParse(args)
if (!parsed.success) return { error: `Invalid tool arguments: ${summarize(parsed.error)}` }
```

Returning the validation message to the model is deliberate — it reads the error and retries with corrected args.

## Voice-specific tool design

- **Few tools, prefetched context.** Every tool round-trip is dead air in a live call. If context (the user's name, their recent records) can be fetched once at session start and baked into `instructions`, do that instead of giving the model a `getContext` tool. Two or three tools is a good ceiling.
- **Confirm before writes.** Instruct the model (in the system prompt) to verbally confirm the details before calling any tool that creates or changes data. Voice recognition mishears; a confirmation turn is cheap insurance.
- **Return speakable results.** Tool outputs get narrated. Return compact JSON with human-meaningful fields (`{ confirmationNumber: "A-1-4-2" }`), not deep nested records — and prompt the model to read identifiers slowly, character by character.
