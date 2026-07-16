# Synchronization core

[Documentation index](README.md)

## Purpose

`makeSyncDaemon` is the authoritative end-to-end state machine between the three
[service ports](services.md): `WorkspaceSource`, `WorkspaceHintSource`, and `EditorAdapter`. It
turns a live HerdR generation plus plugin cwd hints into validated, generation-gated editor calls.

## Responsibilities

The daemon owns:

- merged source-event and cwd-hint ingress;
- current-generation selection and cancellation;
- a 50 ms burst collapse;
- authoritative S2 snapshot retrieval;
- resolution of every workspace to a canonical Git root;
- atomic cache replacement and stale-hint pruning;
- ordered, unique ensure calls and focused-project selection;
- stable structured synchronization logs.

[`resolveProject`](../src/sync/resolve-project.ts) owns filesystem and Git validation; editor
process policy remains in the [Zed adapter](editor.md).

## Contracts and state

`SyncCache` contains:

| Field | Meaning |
|---|---|
| `latestLiveGeneration` | The only generation currently allowed to install or invoke the editor |
| `snapshot` | The most recently installed authoritative snapshot |
| `cwdHints` | Latest plugin cwd by workspace id |
| `projects` | Successfully resolved project by workspace id |
| `ensuredGitRoots` | Roots successfully ensured during the current source generation |
| `lastSuccessful` | Last successfully focused `{ workspaceId, gitRoot }` |
| `lastSynchronizedAt` | Millisecond timestamp of the last recorded ensure or focus success |

`Invalidated` and `Disconnected` events form one ingress path. `WorkspaceCwdHint` values form the
other. A hint always updates `cwdHints`; it queues a refresh only when a generation is live and has
an active cancellation token. This allows a hint received before the first live generation to be
used by a later snapshot without starting work prematurely.

An `Invalidated` event older than the live generation is ignored. A newer generation cancels all
older generation work. Changing generations resets the daemon's `ensuredGitRoots` and
`lastSuccessful`; these fields are generation-local.

## Flow

1. The worker takes the first refresh trigger, sleeps for 50 ms, drains the queued burst, filters
   it to the current live generation, and keeps the earliest ingress timestamp.
2. It races the refresh against that generation's cancellation signal.
3. After a generation gate, it logs `workspace_sync_started` and requests the generation-gated S2
   snapshot from `WorkspaceSource`.
4. It gates again, reads the current cwd hints, and resolves every workspace in snapshot order.
5. It gates again and atomically installs the authoritative snapshot and resolved-project map.
   Hints for workspace ids absent from the new snapshot are pruned in the same cache update.
6. It preserves snapshot order while deduplicating projects by Git root. Each root not already in
   the daemon's generation-local `ensuredGitRoots` is gated and passed to `ensureProject`.
7. If the snapshot has a focused workspace with a resolved project, and its
   `{ workspaceId, gitRoot }` differs from `lastSuccessful`, the daemon gates and calls
   `focusProject`.

### Project resolution

For each `WorkspaceRecord`:

1. A non-null `checkoutPath` wins over any matching cwd hint and sets source `"worktree"`.
2. Otherwise the matching plugin hint is the fallback and sets source `"plugin"`.
3. The selected value is resolved to an absolute path.
4. Filesystem `stat` must report a directory.
5. The daemon invokes shell-free
   `git -C <candidate> rev-parse --show-toplevel` and resolves its output to the canonical absolute
   Git root.

A resolution failure logs `workspace_sync_skipped` and omits that workspace; it does not prevent
other workspaces from resolving. Linked worktrees remain distinct because canonical paths are not
collapsed by repository identity.

### Success and retry state

An ensure failure logs `workspace_sync_failed`, is not added to `ensuredGitRoots`, and does not stop
later roots in the same pass. A later trigger retries that root. An ensure success is recorded only
if its generation is still live.

A focus failure logs `workspace_sync_failed` and does not replace `lastSuccessful`; a later trigger
retries it. A focus success is recorded only if its generation is still live. If either editor call
finishes after its generation becomes stale, the completion neither mutates state nor logs
`workspace_sync_succeeded`.

The daemon's `ensuredGitRoots` is reset on generation changes. The Zed adapter has a separate
adapter-lifetime successful-root cache, so the daemon may re-request an ensure after reconnect while
the adapter safely suppresses a redundant process call it already completed.

## Failure boundaries

Generation gates run before snapshot work, authoritative cache installation, every editor call,
and each success-state write. Disconnect resolves the generation's cancellation signal, clears it
as live when applicable, and removes queued triggers for that generation. Stale-generation
failures are absorbed without a misleading failure or success log.

The stable synchronization event literals are:

- `workspace_sync_started`
- `workspace_sync_succeeded`
- `workspace_sync_skipped`
- `workspace_sync_failed`

Every `elapsed_ms` begins at ingress, so it includes the 50 ms burst window and all subsequent
snapshot, resolution, and editor time. Causes are bounded to the final 4,096 characters. Snapshot
or unexpected failures are logged with operation `snapshot`; resolution warnings retain their
exact operation and reason; editor failures use `ensure_project` or `focus_project`.

## Implementation and tests

- [`src/sync/daemon.ts`](../src/sync/daemon.ts)
- [`src/sync/resolve-project.ts`](../src/sync/resolve-project.ts)
- [`test/sync/daemon.test.ts`](../test/sync/daemon.test.ts)
- [`test/sync/resolve-project.test.ts`](../test/sync/resolve-project.test.ts)
- [`test/e2e/daemon.test.ts`](../test/e2e/daemon.test.ts)

## Related

- [Architecture](architecture.md)
- [Domain model](domain.md)
- [Service ports](services.md)
- [HerdR workspace source](herdr.md)
- [Plugin lifecycle and control](plugin.md)
- [Zed editor adapter](editor.md)
