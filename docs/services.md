# Service ports

[Documentation index](README.md)

## Purpose

Three Effect `Context.Tag` ports invert dependencies around the synchronization core. The core
consumes domain snapshots, events, hints, and editor operations without importing HerdR transport,
plugin socket, or Zed process implementations.

## Responsibilities

The exact service identifiers are:

- `"zed-herdr/WorkspaceSource"`
- `"zed-herdr/WorkspaceHintSource"`
- `"zed-herdr/EditorAdapter"`

Their consumer-facing shapes are:

```text
WorkspaceSource.snapshot(generation)
    -> Effect<WorkspaceSnapshot, WorkspaceSourceError>
WorkspaceSource.events
    -> Stream<WorkspaceSourceEvent, WorkspaceSourceError>

WorkspaceHintSource.hints
    -> Stream<WorkspaceCwdHint>

EditorAdapter.ensureProject(path)
    -> Effect<void, EditorAdapterError>
EditorAdapter.focusProject(path)
    -> Effect<void, EditorAdapterError>
```

## Contracts and state

[`WorkspaceSource`](../src/services/workspace-source.ts) couples a generation-gated snapshot
operation with the source-event stream. Callers must use the generation from an `Invalidated`
event; the implementation can reject stale generations.

[`WorkspaceHintSource`](../src/services/workspace-hint-source.ts) is an error-free stream of
decoded cwd hints. `WorkspaceHintSource.empty` supplies an empty layer when no hook integration is
needed.

[`EditorAdapter`](../src/services/editor-adapter.ts) exposes only ensure and focus. Both operations
return `void` on success and fail with `EditorAdapterError`; cache and process behavior belong to
the implementation.

## Flow

- [`makeHerdRWorkspaceSource`](../src/herdr/workspace-source.ts) projects the scoped transport
  client's `snapshot` and `events` onto `WorkspaceSource`.
- [`runDaemon`](../src/app.ts) projects owner-validated control notifications through a bounded
  queue and supplies the resulting stream as `WorkspaceHintSource`.
- [`makeZedEditorAdapterLayer`](../src/editor/zed.ts) implements `EditorAdapter`.
- [`makeSyncDaemon`](../src/sync/daemon.ts) depends only on these three tags.

This keeps transport types out of core domain types and keeps low-level plugin control and locking
outside the Effect service graph.

## Failure boundaries

`WorkspaceSourceError` contains source transport, source protocol, unsupported-protocol, and stale
generation failures. The hint port exposes no stream error because requests have already passed
plugin protocol validation before queue publication. The editor port exposes only bounded
`EditorAdapterError` values. Synchronization decides how to log, skip, or retry these failures; the
ports do not hide them or add fallback behavior.

## Implementation and tests

- [`src/services/workspace-source.ts`](../src/services/workspace-source.ts)
- [`src/services/workspace-hint-source.ts`](../src/services/workspace-hint-source.ts)
- [`src/services/editor-adapter.ts`](../src/services/editor-adapter.ts)
- [`test/sync/daemon.test.ts`](../test/sync/daemon.test.ts) exercises the core against these ports.

## Related

- [Domain model](domain.md)
- [Runtime composition](runtime.md)
- [HerdR workspace source](herdr.md)
- [Synchronization core](synchronization.md)
- [Plugin lifecycle and control](plugin.md)
- [Zed editor adapter](editor.md)
