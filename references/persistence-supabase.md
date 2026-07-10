# Optional module: transcript persistence with Supabase

Skip this file entirely if the user doesn't need call transcripts saved. If they do — for a staff dashboard, audit trail, or analytics — this is a proven design: save the whole transcript **once, at call end**, with a tab-close safety net.

The concepts (flush-at-end, `pagehide` + `keepalive`, ref-mirroring, don't-trust-client-IDs) apply to any backend; the schema and RLS specifics are Supabase/Postgres.

## Contents

1. [Design decisions](#design-decisions)
2. [Schema](#schema)
3. [Client: flush at call end](#client-flush)
4. [Server: save endpoint](#server-save-endpoint)
5. [AI summaries](#ai-summaries)
6. [RLS notes — the per-user hardening lesson](#rls-notes)
7. [Calls dashboard sketch](#calls-dashboard-sketch)

## Design decisions

- **Save once at call end**, not incrementally. Voice calls are short (minutes); a single POST is simpler and the failure window is small. The trade-off: a hard browser crash loses the transcript. If that matters, upgrade to incremental saves later.
- **Persist even when the call "did nothing".** A call that created no records is still worth reading — it shows intent and failures. Make any linked-record FK nullable.
- **Sessions + messages, two tables.** One row per call with metadata; one row per utterance. If you already have chat persistence, reuse those tables with a `channel` discriminator instead of new ones.

## Schema

```sql
CREATE TABLE voice_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id),
  channel       TEXT NOT NULL DEFAULT 'voice',
  duration_secs INT,
  summary       TEXT,                    -- AI-generated, filled after insert
  linked_record_id UUID,                 -- nullable: whatever the call created, if anything
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ              -- set at insert for voice (call is over when we save)
);

CREATE TABLE voice_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_voice_sessions_user_created ON voice_sessions(user_id, created_at DESC);
```

If reusing an existing chat-sessions table, the migration is just: add `channel TEXT NOT NULL DEFAULT 'text' CHECK (channel IN ('text','voice'))`, add `duration_secs INT`, and make any request/record FK nullable.

## Client: flush at call end

Three client-side subtleties, all in `assets/templates/use-voice-agent.ts`:

1. **Mirror transcript state into a ref.** Teardown can fire in the same tick as the last transcript event, before React commits state — flushing from state loses the final utterances (`pitfalls.md` #12). Route all writes through one updater that writes the ref, then state.

2. **One flush function, two triggers, single-fire guard.** Both `teardown()` and a `pagehide` listener call `flushTranscript()`; a `flushed` ref ensures only the first one sends. Initialize the ref to `true` so teardowns before the first call never flush; set it `false` in `start()`.

3. **`keepalive: true`** lets the POST survive the tab closing:

```ts
void fetch('/api/voice/transcript', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  keepalive: true,
  body: JSON.stringify({ entries, durationSecs, linkedRecordId }),
}).catch(() => {})
```

Keepalive bodies are capped at **64KB** — enforce a max entry count server-side (500 entries is far under the cap for voice) and filter empty entries before sending (zero entries → skip the POST; never create empty sessions).

Register `window.addEventListener('pagehide', flushTranscript)` when the socket opens; remove it in teardown.

## Server: save endpoint

A route handler (not a server action — `keepalive` fetch needs a plain endpoint). Auth from session cookies, Zod-validate the body, insert session then messages:

```ts
const bodySchema = z.object({
  entries: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })).min(1).max(500),
  linkedRecordId: z.string().uuid().optional(),
  durationSecs: z.number().int().min(0).optional(),
})
```

**Don't trust client-sent record IDs.** If the client says "this call created record X", verify X is visible through the caller's own RLS-scoped client before linking; if it isn't, save the transcript **unlinked** rather than failing:

```ts
let linkedId: string | null = null
if (linkedRecordId) {
  const { data } = await supabase.from('records').select('id').eq('id', linkedRecordId).maybeSingle()
  linkedId = data ? linkedRecordId : null
}
```

Insert order: session row first (get its id), then batch-insert messages. Voice sessions are inserted with `closed_at: now()` — the call is already over.

## AI summaries

A one-line summary makes a calls dashboard scannable. Generate it **after** the transcript is saved, best-effort — a summary failure must never lose a transcript:

```ts
try {
  const summary = await summarize(messages)   // any cheap LLM call: "summarize this call in one sentence"
  if (summary) await supabase.from('voice_sessions').update({ summary }).eq('id', sessionId)
} catch { /* transcript is already safe */ }
```

Inject `summarize` as a parameter of your save function — it keeps the persistence logic unit-testable without mocking an LLM.

## RLS notes

Policies you want:

- **Insert:** users insert only their own sessions/messages (`user_id = auth.uid()`, and messages only into their own sessions).
- **Select for end-users:** `user_id = auth.uid()` — *not* a broader tenant/org scope.
- **Select for staff:** a separate policy keyed on role (e.g. staff of the same org can read all sessions).

**The hardening lesson we learned:** reusing a chat table whose policy was org-scoped `FOR ALL` meant *any user in the org* — including other end-users — could read everyone's voice transcripts through the auto-generated REST API, even though no UI exposed them. RLS is your only real perimeter with client-side database SDKs; the UI hides nothing. Voice transcripts are people talking about their homes, health, schedules — scope end-user reads to the individual, always.

## Calls dashboard sketch

A staff-facing list of calls, sorted newest-first:

- **Query:** sessions where `channel = 'voice'`, limit ~200, then batch-lookup caller display names in one `IN` query (avoid N+1; if your sessions table has no FK to profiles, embedded joins won't work — manual batch lookups are fine).
- **Table columns:** Date, Caller, Summary (`line-clamp-1`), Duration (`m:ss`), linked record badge.
- **Row click → detail sheet:** fetch that session's messages on open, render chat-style bubbles (user right-aligned, assistant left), header with date/duration/summary, and a link to the created record when present.
- `formatDuration(secs)` → `m:ss` is worth a 3-line pure function and a unit test.
