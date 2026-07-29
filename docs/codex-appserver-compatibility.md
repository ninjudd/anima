# Codex AppServer compatibility

This document records black-box compatibility probes for Codex history
injection. A version is not assumed compatible merely because its generated
protocol includes `thread/inject_items`.

## Codex CLI 0.146.0

Probe environment: macOS on arm64, 2026-07-29.

### Protocol

- `initialize` succeeds with the experimental API capability enabled.
- `thread/start` with `ephemeral: false` returns a persistent thread ID and
  rollout path.
- `thread/inject_items` accepts raw user `input_text` and assistant
  `output_text` message items.
- `thread/name/set` persists a picker-visible thread name.
- Both `legacy` and `paginated` history modes accept injected items.

### Durability and model visibility

Pass:

1. Create a persistent thread.
2. Inject one user message followed by one assistant message.
3. Close AppServer.
4. Confirm both response items exist in the rollout.
5. Start a new AppServer, resume the thread, and run a model turn asking for the
   two immediately preceding messages.
6. Confirm the model returns both injected messages exactly.

The injected history remains model-visible after the bootstrap AppServer exits.

### Interactive rendering

Fail:

- An injected-only thread opens in `codex resume` with an empty visible history.
- After a real turn, the TUI displays the real turn but still does not display
  the injected user and assistant items as prior turns.
- `paginated` mode behaves the same as `legacy` mode.
- Before the first real user turn, `thread/turns/list` reports that the thread is
  not materialized. `thread/items/list` is advertised in generated bindings but
  returns “not supported yet.”

### Capability decision

| Capability | 0.146.0 |
| --- | --- |
| Persistent thread creation | Yes |
| Raw history injection | Yes |
| Survives AppServer exit | Yes |
| Model-visible after resume | Yes |
| Imported turns visible in TUI | No |

Anima can use AppServer injection as a durable model-context transport for this
version, but it must not claim full history rendering. The production
Claude-to-Codex encoder remains disabled until the product behavior is chosen:

1. Accept model-visible but TUI-invisible imported history and disclose that
   limitation, or
2. Design and separately validate a versioned native rollout projection that
   creates renderable turns.

The `externalAgentConfig/import` methods do not provide a third path; they import
configuration, skills, and connectors rather than conversation history.
