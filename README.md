# anima

Anima transfers durable local coding-agent history between Claude Code and
Codex. It is designed to recover a source session even when that provider is
unavailable.

The first implementation slice is intentionally read-only. It discovers a
native session, parses its JSONL transcript offline, and prints canonical Anima
history:

```text
anima --claude <session-id> --dry-run
anima --codex <session-id> --dry-run
```

Creating target-native histories is not implemented yet. Invocations without
`--dry-run` fail without modifying provider state.

The Codex AppServer compatibility probe is documented in
[`docs/codex-appserver-compatibility.md`](docs/codex-appserver-compatibility.md).
Codex CLI 0.146.0 durably preserves injected history for the model, but does not
render imported items as prior turns in the interactive TUI.

## Development

```text
npm install
npm test
```

There are no third-party runtime dependencies. See
[`docs/architecture.md`](docs/architecture.md) for the complete design.
