# Domain model

[Documentation index](README.md)

## Purpose

The domain layer is the editor-independent language shared by the HerdR source, synchronization
core, plugin bridge, and Zed adapter. It contains bounded Effect `Schema` values and tagged
failures; it does not expose HerdR wire objects or Zed process details.

## Responsibilities

[`src/domain/workspace.ts`](../src/domain/workspace.ts) declares:

- `WorkspaceId`: a branded, nonempty string with a maximum length of 4,096 characters.
- `WorkspaceGeneration`: a branded nonnegative integer. The source emits increasing connection
  generations, and the synchronization daemon enforces current-generation ordering before work or
  side effects.
- `WorkspaceInvalidated`: `{ _tag: "Invalidated", generation }`, requesting a fresh authoritative
  snapshot for that generation.
- `WorkspaceDisconnected`: `{ _tag: "Disconnected", generation }`, cancelling work for that
  generation.
- `WorkspaceRecord`: `{ workspaceId, name, checkoutPath: string | null, isLinkedWorktree }`, the
  editor-independent workspace projection from a HerdR snapshot.
- `WorkspaceSnapshot`: `{ focusedWorkspaceId: WorkspaceId | null, workspaces }`.
- `WorkspaceProject`: `{ workspaceId, name, cwd, gitRoot, source: "worktree" | "plugin",
isLinkedWorktree }`, a record after path and Git-root resolution.
- `WorkspaceCwdHint`: `{ workspaceId, cwd }`, the plugin hook's fallback path signal.

The shared text fields are nonempty and bounded to 4,096 characters. `WorkspaceSourceEvent` is the
union of `WorkspaceInvalidated` and `WorkspaceDisconnected`.

## Contracts and state

Domain values describe observations and resolved state, not mutable services. A source event names
the generation to which it belongs. A snapshot contains all authoritative workspace records for
one synchronization pass. A resolved project carries both the selected cwd and canonical Git root,
plus whether its path came from a HerdR worktree or a plugin hint.

The generation number alone is not permission to mutate state. The
[synchronization core](synchronization.md) checks it against the current live generation before
snapshot, cache, and editor stages.

## Flow

1. The [HerdR workspace source](herdr.md) decodes transport data into `WorkspaceRecord`,
   `WorkspaceSnapshot`, and generation-tagged source events.
2. The [plugin boundary](plugin.md) decodes hook input into `WorkspaceCwdHint`.
3. The synchronization core selects a path and constructs `WorkspaceProject`.
4. The [service ports](services.md) carry only these domain values between implementations.

## Failure boundaries

[`src/domain/errors.ts`](../src/domain/errors.ts) groups tagged failures by the boundary that owns
them:

- Resolution: `WorkspaceResolutionError.operation` is
  `"resolve_checkout_path" | "resolve_cwd_hint" | "stat" | "git_root"`; its `reason` is
  `"missing_path" | "ambiguous_path" | "inaccessible_path" | "not_directory" |
"not_git_repository"`.
- Source transport: `WorkspaceSourceTransportError.operation` is
  `"connect" | "request" | "subscribe" | "read"`.
- Source protocol: `WorkspaceSourceProtocolError.operation` is
  `"decode" | "response" | "subscription"`.
- Generation: `StaleWorkspaceGeneration` records the rejected generation.
- Compatibility: `UnsupportedHerdRProtocol` requires the expected literal `16` and records the
  actual nonnegative protocol number.
- Configuration: `ConfigurationError` records a bounded key and message.
- Editor: `EditorAdapterError.operation` is `"ensure_project" | "focus_project"` and records the
  path, optional exit code, bounded stderr, and message.

The error vocabulary includes `"ambiguous_path"` for the domain contract, but
[`resolveProject`](../src/sync/resolve-project.ts) currently emits every listed resolution reason
except `"ambiguous_path"`. There is no implemented ambiguity detector.

## Implementation and tests

The declarations are authoritative:

- [`src/domain/workspace.ts`](../src/domain/workspace.ts)
- [`src/domain/errors.ts`](../src/domain/errors.ts)

Their consumer behavior is covered where values cross real boundaries:
[synchronization tests](../test/sync/daemon.test.ts),
[HerdR client tests](../test/herdr/client.test.ts), and
[editor adapter tests](../test/editor/zed.test.ts). These are consumer contracts, not a claim that
one suite exhaustively tests every schema declaration.

## Related

- [Service ports](services.md)
- [Synchronization core](synchronization.md)
