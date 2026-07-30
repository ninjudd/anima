# anima

Anima transfers durable local coding-agent history between Claude Code and
Codex. It is designed to recover a source session even when that provider is
unavailable.

Anima can now transfer a Codex session into a new Claude Code session:

```text
anima --codex <session-id>
```

The source is read entirely from Codex's local rollout. Anima archives canonical
history under `${XDG_DATA_HOME:-~/.local/share}/anima`, creates and validates a
new Claude transcript, prints its UUID and manual resume command, then launches
`claude --resume <new-session-id>`. The source Codex process is never invoked.

Claude Code 2.1.220 is the only writable target version currently validated.
Unknown target versions fail closed after the canonical archive is committed
and before any Claude transcript is created. If the recorded workspace no
longer exists, pass `--cwd <path>`.

Offline inspection remains available for either provider:

```text
anima --claude <session-id> --dry-run
anima --codex <session-id> --dry-run
```

Claude-to-Codex creation is still gated on the product decision documented
below; `anima --claude <session-id>` therefore fails without modifying Codex.
Tool calls, tool results, and context notes are imported into Claude as labeled
historical text and are never replayed. Tool results are limited to 8 KiB in the
target transcript by default; `--include-tool-output` raises that to the 64 KiB
canonical limit.

The Codex AppServer compatibility probe is documented in
[`docs/codex-appserver-compatibility.md`](docs/codex-appserver-compatibility.md).
Codex CLI 0.146.0 durably preserves injected history for the model, but does not
render imported items as prior turns in the interactive TUI.

The Claude transcript compatibility probe is documented in
[`docs/claude-transcript-compatibility.md`](docs/claude-transcript-compatibility.md).
Claude Code 2.1.220 resumes the offline-generated template, renders both roles,
includes them in the next model request, and appends a role-complete native
chain.

## Development

```text
npm install
npm test
```

There are no third-party runtime dependencies. See
[`docs/architecture.md`](docs/architecture.md) for the complete design.
