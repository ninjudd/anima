# Anima Architecture

Status: Draft

## 1. Purpose

Anima transfers a local coding-agent conversation between Claude Code and Codex.
It is designed primarily for recovery: the source provider may be unavailable when
the transfer happens.

The primary interface is:

```text
anima --claude <session-id>
anima --codex <session-id>
```

The option names the source:

- `--claude` reads a Claude Code session, creates a new Codex session, and starts
  Codex.
- `--codex` reads a Codex session, creates a new Claude Code session, and starts
  Claude.

Each transfer creates a new session in the opposite runtime. Anima never resumes
or edits the source session.

## 2. Design principles

### 2.1 Recovery must not require the source runtime

Anima reads the source runtime's durable local session data directly. Transferring
from Claude must not invoke Claude or require Anthropic to be reachable.
Transferring from Codex must not invoke Codex models or require OpenAI to be
reachable.

The target runtime must be locally installed and usable. Creating and launching
the target session may use its local CLI or local app-server, but Anima does not
ask either model to summarize the source conversation.

### 2.2 Anima owns the portable history

Claude and Codex histories are provider-specific projections of an Anima-owned
canonical history. The canonical history is the stable boundary:

```text
Claude session ──> canonical history ──> Codex session
      ^                                      |
      |                                      v
      └──────── Claude session <── canonical history
```

Native history generation is necessarily version-sensitive. Canonical history
must remain readable even when a native encoder needs updating.

### 2.3 Preserve meaning, not provider internals

Visible user and assistant messages should round-trip without rewriting their
text. Tool activity should remain available, but Anima must not recreate old tool
calls as executable pending calls in the target runtime.

The following are deliberately not portable:

- Hidden reasoning or thinking
- Encrypted reasoning and compaction payloads
- Provider system prompts and developer instructions
- Permission decisions, approval state, and sandbox configuration
- In-flight tool approvals
- Provider authentication state
- Model-specific cache state

### 2.4 Never mutate an existing native session

Every target session receives a fresh identifier. Anima writes a new target
history and records its relationship to the source. Original Claude and Codex
session files are read-only inputs.

### 2.5 Round trips must not duplicate imported history

If a conversation moves from Claude A to Codex B and then to Claude C, the history
from A must appear once in C. Anima records an import boundary for B and imports
only work added after that boundary when B becomes a later source.

## 3. Goals

- Work when the source provider is experiencing an outage.
- Locate a native session by its exact session ID.
- Start a new interactive session in the opposite runtime.
- Preserve visible conversational history with stable roles and ordering.
- Preserve useful tool activity without replaying tools.
- Support repeated Claude-to-Codex-to-Claude transfers.
- Keep a durable provider-neutral lineage and deduplicate imported prefixes.
- Tolerate a truncated final JSONL record after a crash.
- Make all writes atomic and recoverable.
- Detect unsupported native history versions before writing.
- Use no third-party runtime dependencies in the initial implementation.

## 4. Non-goals

- Bit-for-bit equivalence between provider histories
- Transferring hidden model reasoning
- Reproducing provider-specific tool widgets exactly
- Replaying commands or tool calls during import
- Continuing the same provider-side conversation or response chain
- Migrating credentials, settings, permissions, hooks, plugins, or MCP servers
- Cross-machine synchronization in the first version
- Replacing Claude Code's or Codex's normal same-provider resume command

## 5. Terminology

**Native session**
: A Claude Code or Codex session persisted in that runtime's local format.

**Source session**
: The native session named on the Anima command line.

**Target session**
: The new native session generated in the opposite runtime.

**Canonical history**
: An ordered, provider-neutral event stream owned by Anima.

**Lineage**
: The logical conversation across one or more native sessions and providers.

**Projection**
: A target-native history generated from canonical history.

**Import boundary**
: The position in a generated target session after the projected history. Events
  after this boundary are new work performed in the target runtime.

**Native cursor**
: A provider-specific durable position, normally a byte offset plus nearby event
  fingerprints, used to identify an import boundary.

## 6. User experience

### 6.1 Claude to Codex

```text
$ anima --claude 6edff1f9-635e-456f-ad74-b7287a7f71eb
Reading Claude session 6edff1f9-635e-456f-ad74-b7287a7f71eb
Created Codex session 019faf85-fda6-7323-9e48-4ecc5e150f35
Starting Codex...
```

Anima then replaces itself with, or starts and waits on, the equivalent of:

```text
codex resume 019faf85-fda6-7323-9e48-4ecc5e150f35
```

### 6.2 Codex to Claude

```text
$ anima --codex 019faf85-fda6-7323-9e48-4ecc5e150f35
Reading Codex session 019faf85-fda6-7323-9e48-4ecc5e150f35
Created Claude session 834b1dad-66f4-4ba2-adca-7e4382709dc5
Starting Claude...
```

Anima then starts the equivalent of:

```text
claude --resume 834b1dad-66f4-4ba2-adca-7e4382709dc5
```

### 6.3 Supporting options

The first version should reserve these options:

```text
--no-launch             Create the target session and print its ID
--dry-run               Read and validate without writing a target session
--cwd <path>            Override the recorded working directory
--data-dir <path>       Override Anima's data directory
--include-tool-output   Project bounded tool output into target history
--force-version         Attempt an encoder not validated for the installed CLI
--verbose               Print discovery and conversion diagnostics
```

Exactly one of `--claude` and `--codex` is required.

## 7. High-level components

```text
┌──────────────┐
│     CLI      │
└──────┬───────┘
       │
┌──────v───────┐     ┌────────────────┐
│ Session      │────>│ Native reader  │
│ discovery    │     │ Claude/Codex   │
└──────────────┘     └───────┬────────┘
                             │
                     ┌───────v────────┐
                     │ Normalizer and │
                     │ lineage store  │
                     └───────┬────────┘
                             │
                     ┌───────v────────┐
                     │ Native encoder │
                     │ Codex/Claude   │
                     └───────┬────────┘
                             │
                     ┌───────v────────┐
                     │ Target launcher│
                     └────────────────┘
```

### 7.1 CLI

The CLI validates arguments, resolves data locations, coordinates the transfer
transaction, prints the new session ID, and launches the target with inherited
terminal input and output.

### 7.2 Session discovery

Discovery resolves an exact native session ID to a transcript and working
directory. It must validate the ID found inside the transcript rather than trust
only a filename match.

### 7.3 Native readers

Readers parse complete durable records and emit provider-neutral candidate
events. They do not write native files and do not invoke a model.

### 7.4 Normalizer and lineage store

The normalizer converts candidate events to canonical events, associates them
with a lineage, removes projected prefixes when applicable, and appends new
events transactionally.

### 7.5 Native encoders

Encoders generate a fresh native target session from canonical events. Encoders
are versioned separately from readers because write compatibility is more
sensitive than read compatibility.

### 7.6 Target launcher

The launcher changes to the session's working directory, inherits the terminal,
and opens the generated session. It does not send a new user message
automatically.

## 8. Native session discovery

### 8.1 Claude Code

Claude Code currently stores project sessions beneath:

```text
~/.claude/projects/<encoded-working-directory>/<session-id>.jsonl
```

The reader should search project roots for an exact filename and then validate
`sessionId` and `cwd` fields from records. Files below a `subagents` directory
are excluded from top-level discovery.

Claude sessions can contain branches and side chains. File order alone may not
represent the active visible branch. The reader should use `uuid`,
`parentUuid`, `isSidechain`, and available leaf metadata to reconstruct the
selected chain. The first version may select the latest non-sidechain leaf, but
the selection rule must be explicit and tested.

### 8.2 Codex

Codex currently stores rollouts beneath:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
```

The reader should locate an exact session ID in rollout filenames and validate it
against the `session_meta` payload. It should not require the Codex SQLite index
for correctness. The index can later be used as an optional discovery
optimization.

Codex event messages and response items may describe the same visible message.
The reader must choose one canonical source for each event type and suppress
wire-level duplicates.

### 8.3 Partial writes

Native session files are append-only in the expected case. A provider outage or
process crash can leave the final line incomplete. Readers:

1. Parse every complete newline-terminated record.
2. If a non-empty final fragment is not newline-terminated, attempt to parse it
   as one complete JSON record.
3. Accept that final record when it is valid JSON.
4. Ignore it and record a warning in transfer metadata only when it is
   incomplete or invalid.
5. Never repair or truncate the native source file.

## 9. Canonical history

### 9.1 Event model

Canonical events are stored as JSON Lines. Each event has a common envelope:

```json
{
  "schema_version": 1,
  "event_id": "evt_...",
  "lineage_id": "lin_...",
  "parent_event_id": "evt_... or null",
  "kind": "message",
  "role": "user",
  "content": [],
  "origin": {
    "provider": "claude",
    "session_id": "...",
    "native_event_id": "...",
    "native_position": {
      "record": 17,
      "block": 0
    },
    "timestamp": "..."
  }
}
```

Initial event kinds:

- `message`
- `tool_call`
- `tool_result`
- `context_note`

Initial content blocks:

- `text`
- `image_reference`
- `tool_activity`

Binary image data is not copied into canonical history in the first version.
Local references may be retained when they are still valid.

### 9.2 Stable event identity

For a native event first seen by Anima, `event_id` is derived from:

- Provider
- Native session ID
- Native message or call ID when present; otherwise a provider-defined stable
  position containing at least the source record ordinal and within-record block
  index
- Native parent ID or branch position when available
- Event kind and role
- A normalized content digest

The stable position is assigned before filtering or deduplicating native
records. This ensures two ID-less events with identical roles and content, such
as repeated `continue` messages, still receive distinct canonical IDs.

Events created from an existing lineage retain their canonical IDs across
projections. The lineage store, not target-native metadata, is the primary
deduplication mechanism.

### 9.3 Message fidelity

Visible message text is preserved exactly after decoding the native container.
Anima does not summarize, paraphrase, or ask a model to rewrite it.

Provider-added UI records, duplicated streaming records, title records, token
counts, and timing events are not canonical messages.

### 9.4 Tool activity

Tool history is useful context but unsafe to inject as live protocol calls.
Canonical tool events preserve:

- Tool name
- Call identifier
- Structured input when it can be decoded
- Result status
- Bounded textual output when allowed by policy

Encoders render tool events as inert imported activity. The target model must
never interpret an imported tool call as awaiting execution or an imported tool
result as satisfying a current native call ID.

By default, tool-result content is bounded in both Anima's local canonical store
and target projections.

The default limits are:

- Canonical storage retains at most 64 KiB of text for each tool result.
- Target projections include at most 8 KiB of text for each tool result.
- Output beyond the applicable limit is represented by its original size,
  SHA-256 digest, and native source location.
- Error output uses the same 64 KiB canonical limit because failures often
  contain the most useful recovery context.

`--include-tool-output` raises the target projection limit to the canonical
64 KiB limit. It never enables unbounded copying.

### 9.5 Context and compaction notes

Plaintext native compaction summaries become `context_note` events only when they
represent the source runtime's effective compaction boundary or when the
uncompacted history would exceed the target context budget. Encrypted compaction
payloads, hidden thinking, and reasoning content are excluded.

An encoder must not inject both a summary and every raw turn covered by that
summary into model-visible target history. Doing so wastes context and can
present conflicting versions of the same conversation.

A context note is never represented as a user instruction. Encoders should use
an inert assistant-visible annotation or provider-supported metadata.

### 9.6 Canonical archive and effective context

Anima distinguishes the complete canonical archive from the effective context
projected into a target:

- The canonical archive retains every canonical event allowed by the local
  storage policy.
- Effective context is a deterministic projection view containing the latest
  applicable compaction summary, events after its boundary, and any earlier
  events that remain within the target budget without duplicating summarized
  material.

Native encoders consume effective context. Round-trip lineage and recovery use
the canonical archive. Building effective context is deterministic and never
requires a model call.

## 10. Lineage and round trips

### 10.1 Lineage graph

A lineage is a directed graph of generated native sessions:

```text
Claude A ──> Codex B ──> Claude C
                 └─────> Claude D
```

Transfers normally extend the current head, but transferring an older session
creates a branch. Each native session node records its canonical parent head.

### 10.2 Projection record

For every generated session, Anima stores:

```json
{
  "projection_id": "prj_...",
  "lineage_id": "lin_...",
  "provider": "codex",
  "native_session_id": "...",
  "native_log_path": "...",
  "cwd": "...",
  "canonical_head_event_id": "evt_...",
  "canonical_event_count": 42,
  "native_cursor": {},
  "status": "projected"
}
```

`canonical_head_event_id` identifies the history imported into the target.
`native_cursor` identifies the durable end of that imported projection.

### 10.3 Importing an Anima-generated session

When a generated target later becomes a source:

1. Resolve its projection record by provider and native session ID.
2. Load the lineage through `canonical_head_event_id`.
3. Read native events after the stored import boundary.
4. Normalize and append only those new events.
5. Project the extended history to a fresh opposite-provider session.

The native cursor should include both a byte offset and nearby normalized event
fingerprints. If a native runtime rewrites or compacts its file, Anima falls back
to a full scan and longest-prefix matching rather than trusting the byte offset.

### 10.4 Sessions not created by Anima

An arbitrary native session starts a new lineage. If it contains history that was
manually copied from another tool, Anima does not attempt semantic deduplication.

## 11. Claude-to-Codex projection

The Codex AppServer supports creating a thread and injecting raw Responses API
items into its model-visible history.

The encoder should:

1. Start a fresh persistent Codex thread with the source working directory.
2. Translate canonical user messages to role-bearing `input_text` items.
3. Translate canonical assistant messages to role-bearing `output_text` items.
4. Render tool activity and context notes as inert imported text or supported
   metadata.
5. Call `thread/inject_items` in bounded batches.
6. Set a descriptive thread name when supported.
7. Read and record the resulting rollout path and native cursor.
8. Close the bootstrap AppServer connection.
9. Launch `codex resume <new-session-id>`.

The new thread must be persistent before Anima reports success. If injection
succeeds only in memory and no durable rollout can be found, the transfer fails
without launching.

Codex history injection is the first compatibility spike and gates this encoder.
For every supported Codex version, tests must verify that injected messages:

- Remain after the bootstrap AppServer exits.
- Are present in the next model request after `codex resume`.
- Render acceptably in the supported interactive client.
- Preserve user and assistant roles and ordering.

Model-visible persistence is required. Terminal rendering fidelity is recorded
as a version capability. If injected items do not render as usable history,
writing a versioned native Codex rollout is a separate design decision rather
than an automatic fallback.

Anima speaks the small AppServer JSON-RPC protocol directly. It does not depend
on the broader agent SDK.

The black-box compatibility result for Codex CLI 0.146.0 is recorded in
[`codex-appserver-compatibility.md`](codex-appserver-compatibility.md). Raw
injected items are durable and model-visible after resume, but are not rendered
as prior turns in the interactive TUI in either legacy or paginated history
mode. Standalone readback also excludes injected user items because they have no
visible `event_msg` counterpart. The production encoder therefore remains gated
on an explicit product decision and must rely on canonical lineage for round
trips unless a separately validated native projection solves both limitations.

## 12. Codex-to-Claude projection

Claude Code does not currently expose a supported arbitrary-history injection
operation in its CLI. The initial encoder therefore creates a new
Claude-compatible project transcript.

The encoder should:

1. Generate a fresh UUID.
2. Resolve the source working directory and Claude project directory.
3. Convert canonical messages into a valid parent-linked Claude transcript.
4. Flatten tool activity into inert history records.
5. Write the complete transcript to a temporary file in the destination
   directory.
6. Flush and fsync the temporary file.
7. Atomically rename it to `<new-session-id>.jsonl`.
8. Fsync the destination directory so the new directory entry is durable.
9. Re-read and validate the generated chain.
10. Record the native cursor and projection metadata.
11. Launch `claude --resume <new-session-id>` from the working directory.

The encoder must never overwrite an existing path. If the generated UUID
collides, it generates another.

The encoder uses a complete, known-good transcript template for each supported
Claude Code version instead of trying to write a theoretical minimum record.
Expected template fields include `type`, `uuid`, `parentUuid`, `sessionId`,
`cwd`, `timestamp`, and `message`, plus any version-specific fields needed for
resume and rendering.

Each template is validated in an isolated Claude configuration root with a
black-box compatibility test covering:

- Successful `claude --resume`.
- Correct user and assistant history rendering.
- Correct model-visible context on the next turn.

Because this uses an internal persistence format, the encoder is enabled only
for tested Claude Code versions unless `--force-version` is supplied.

The black-box compatibility result for Claude Code 2.1.220 is recorded in
[`claude-transcript-compatibility.md`](claude-transcript-compatibility.md). A
two-record, parent-linked transcript generated entirely offline resumed
successfully, rendered both imported roles in the TUI, remained model-visible,
accepted an appended turn, and stayed role-complete when read back through
Anima. The versioned template is therefore compatible. The production
Codex-to-Claude path now supplies the canonical archive, projection transaction,
exclusive atomic native writer, read-back validation, and inherited-terminal
launcher around that template.

## 13. Local storage

The default data root is:

```text
${XDG_DATA_HOME:-~/.local/share}/anima/
```

Proposed layout:

```text
anima/
  schema-version
  lineages/
    <lineage-id>/
      manifest.json
      events.jsonl
  projections/
    claude/
      <session-id>.json
    codex/
      <session-id>.json
  transfers/
    <transfer-id>.json
```

Directories are created with mode `0700` and files with mode `0600`. Transcript
content must never be written to a system-wide shared temporary directory.

`manifest.json` contains graph and summary metadata. `events.jsonl` is the
append-only canonical event stream. Projection lookup files make provider and
session ID resolution direct.

Canonical stream validation and replacement are serialized per lineage with an
owner-only lock file. This prevents a shorter snapshot of an actively growing
source from racing a longer snapshot and regressing either `events.jsonl` or
its manifest. Lock waits are bounded; after a crash, Anima reports the retained
lock for explicit inspection instead of guessing that an active writer is
stale.

## 14. Transfer transaction

Each invocation creates a durable transfer record with these states:

```text
reading -> normalized -> target_created -> projected -> launching -> complete
                                                       \-> launch_failed
```

The transaction rules are:

- Canonical history is committed before target-native projection begins.
- Target creation is recorded as soon as a native ID exists.
- Projection metadata is committed before launching the target and only after
  generated native files and their destination directory entries are durable.
- A launch failure does not delete the generated target session.
- Retrying a recorded incomplete transfer resumes the same target when safe
  instead of creating duplicates.
- A failed or timed-out Codex injection is not safe to retry in the same target
  because AppServer has no atomic batch or idempotency contract. Mark that
  target incomplete and create a fresh target on transfer retry.
- The new target ID and a manual resume command are always printed before
  process replacement or launch.

If Anima crashes after creating a target but before recording it, the next run
may discover an orphan. Orphan reconciliation can be added after the first
version; native target IDs should still carry descriptive titles where possible.

## 15. Process launching

The target process inherits stdin, stdout, stderr, terminal dimensions, and
relevant signal behavior. Anima must not pipe a large transcript through a
command-line argument.

Because history has already been projected, the launcher sends no synthetic user
prompt. The target opens at the end of the imported history and waits for the
user's next message.

The working directory defaults to the source session's recorded `cwd`. If it no
longer exists, Anima stops and asks for `--cwd`; silently substituting the
caller's current directory could expose the wrong repository to the target.

### 15.1 Generated session names

Generated sessions use the logical conversation title, source provider, and a
six-character lineage identifier:

```text
<logical title> · via Anima/<source> · <lineage-short-id>
```

For example:

```text
Fix session recovery · via Anima/Claude · 7K3M2P
```

The logical title remains stable across round trips. The source provider changes
at each transfer. Full native session IDs remain in Anima metadata and are not
included in session-picker titles.

## 16. Versioning and compatibility

### 16.1 Adapter interface

Each provider adapter exposes independent capabilities:

```text
discover(session_id)
read(session_ref, cursor?)
detect_version()
can_encode(version)
create(history, options)
validate(session_ref)
launch(session_ref)
```

A reader may support a wider version range than its encoder.

### 16.2 Fixture tests

The repository should contain sanitized fixtures grouped by provider and CLI
version:

```text
fixtures/
  claude/2.1.220/
  codex/0.146.0/
```

Fixtures should cover:

- Multiple user and assistant turns
- Tool calls and results
- Valid final records without trailing newlines
- Incomplete or invalid final fragments
- Repeated ID-less events with identical roles and content
- Compaction
- Claude branches and sidechains
- Codex duplicate event and response records
- Codex injected-history persistence, model visibility, and terminal rendering
- Claude generated-history resume, model visibility, and terminal rendering
- Histories generated by Anima
- A full Claude-to-Codex-to-Claude round trip

Golden canonical JSONL verifies readers. Native structural validation and
target-runtime smoke tests verify encoders.

### 16.3 Unknown versions

Unknown read versions are attempted conservatively because parsing is read-only.
Unknown write versions fail closed by default. The error should explain the
detected version, supported range, and `--force-version` escape hatch.

## 17. Security and privacy

Moving a history between Claude and Codex sends some content to a different
provider on the next model turn. Anima must make that boundary visible.

Default policy:

- Preserve visible user and assistant message text.
- Exclude system and developer instructions.
- Exclude hidden thinking, reasoning, and encrypted payloads.
- Never copy credentials or provider auth files.
- Never replay native tool calls.
- Retain at most 64 KiB per tool result in canonical storage.
- Include at most 8 KiB per tool result in target projections by default.
- Represent omitted tool output with its size, digest, and native source
  location.
- Keep the complete canonical store local with owner-only permissions.
- Emit no telemetry.

Imported tool output is untrusted content. Target projections label it as
historical data, not as instructions. This does not eliminate prompt injection,
but prevents Anima itself from executing embedded commands.

The first cross-provider transfer may show a concise confirmation unless the
user has acknowledged the policy in local configuration. Non-interactive use
can provide an explicit acknowledgement flag.

## 18. Failure modes

### Source provider outage

Expected operating condition. Read local durable history and continue.

### Source process died during a write

Attempt to parse a non-newline-terminated final fragment. Preserve it when it is
valid JSON; otherwise ignore it and report the cutoff.

### Source session not found

Do not guess by recency. Report searched roots and offer a separate listing
command in a later CLI revision.

### Source working directory is missing

Require `--cwd`.

### Unsupported target format

Do not write native state. Preserve the canonical lineage and report the
compatibility problem.

### Target session created but launch fails

Preserve it, print its session ID and manual resume command, and mark the
transfer `launch_failed`.

### Projection is not durable

Fail before launch. A target session that exists only in an AppServer process is
not a successful transfer.

### Import boundary cannot be recovered

Fall back to normalized full-history prefix matching. If the result is
ambiguous, stop rather than duplicate or discard conversation history.

## 19. Implementation constraints

The initial implementation is a standalone TypeScript CLI compiled to ESM for
Node.js 20 or newer. It has no third-party runtime dependencies. TypeScript may
be a development dependency, and tests use the built-in `node:test` runner.

Anima may reuse protocol knowledge from the existing agent-sdk project, but it
must not require that package.

The implementation language and distribution format should satisfy:

- Streaming JSONL parsing
- Atomic filesystem operations
- SHA-256 hashing
- UUID generation
- Child-process control with inherited TTY
- Direct newline-delimited JSON-RPC over Codex AppServer stdio
- Straightforward single-binary or minimal-runtime installation

No model API SDK is required.

## 20. Initial delivery sequence

### Phase 0: Native compatibility probes

- Verify Codex injected-history durability, model visibility, and terminal
  rendering.
- Determine and capture a known-good Claude transcript template.
- Exercise generated Claude history in an isolated configuration root.
- Record provider-version capabilities before committing to either encoder.

### Phase 1: Offline readers

- Resolve exact Claude and Codex session IDs.
- Normalize both formats to canonical JSONL.
- Add sanitized fixtures and golden tests.
- Implement dry-run inspection.

### Phase 2: Claude to Codex

- Create a persistent Codex thread through AppServer.
- Inject canonical history.
- Verify rollout durability.
- Launch the new thread with `codex resume`.

### Phase 3: Codex to Claude (implemented for Claude Code 2.1.220)

- Build the versioned Claude transcript encoder.
- Validate generated parent chains.
- Launch with `claude --resume`.

### Phase 4: Lineage round trips

- Store projection records and native cursors.
- Import only post-boundary target events.
- Add branching and repeated-transfer tests.

### Phase 5: Hardening

- Compatibility matrix and unknown-version behavior
- Transfer retry and orphan reconciliation
- Tool-output policy and redaction
- Packaging and installation

## 21. Initial decisions

1. Project a plaintext compaction summary only when it is the effective source
   boundary or is needed to fit the target budget. Do not also project the raw
   turns it covers.
2. Generate Claude histories from versioned, known-good templates. Determine
   required fields with isolated black-box tests rather than minimizing records
   in production.
3. Treat Codex model-visible persistence as mandatory and terminal rendering as
   a tested version capability. Run this compatibility spike before building the
   full encoder.
4. Cap tool results at 64 KiB in canonical storage and 8 KiB in target
   projections. Preserve size, digest, and native source location when content
   is omitted.
5. Build the first implementation in TypeScript for Node.js 20 or newer with no
   third-party runtime dependencies.
6. Name generated sessions
   `<logical title> · via Anima/<source> · <lineage-short-id>`.
