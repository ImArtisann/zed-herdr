# Plugin lifecycle and control

[Documentation index](README.md)

## Purpose

The plugin boundary converts HerdR activation into a bounded cwd hint for a live daemon. It keeps
hook decoding, startup contention, lock ownership, control-socket safety, and wire validation
together because those invariants guard one flow. This low-level Bun/Promise code remains separate
from the Effect synchronization service graph.

## Responsibilities

### Manifest and entrypoints

[`herdr-plugin.toml`](../herdr-plugin.toml) activates the hook on exactly:

- `workspace.created`
- `workspace.focused`

Both execute `bun ./dist/index.js hook`. The manifest's `daemon` pane executes
`bun ./dist/index.js daemon`, is titled `Zed Workspace Sync`, and uses placement `tab`.
The manifest also declares the workspace-scoped `toggle` action, which executes
`bun ./dist/index.js toggle` and pauses or resumes the live daemon without disabling the plugin.
HerdR keybindings are user configuration, not plugin-manifest fields. Install the binding in
`~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+z"
type = "plugin_action"
command = "artisann.zed-herdr.toggle"
description = "Toggle Zed workspace sync"
```

Run `herdr server reload-config` after editing the file.

### Hook decoding

[`decodeHookNotification`](../src/plugin/hook.ts) selects the workspace id in this order:

1. `HERDR_PLUGIN_EVENT_JSON.data.workspace.workspace_id`
2. `HERDR_PLUGIN_EVENT_JSON.data.workspace_id`
3. `HERDR_WORKSPACE_ID`

The cwd comes only from `HERDR_PLUGIN_CONTEXT_JSON.workspace_cwd`; `PWD` is never consulted.
Successful boundary decoding projects the pair to `WorkspaceCwdHint`. Missing, malformed, or
incomplete values produce no I/O and return exactly:

```text
{ _tag: "Skipped", reason: "missing_workspace_or_cwd" }
```

## Contracts and state

### Lock and control-path security

The contender lock is `${controlSocketPath}.lock`. Its directory must be owner-controlled mode
`0700`; its single token owner file must be a regular, non-symlink owner file mode `0600`. A lock
becomes eligible for takeover after 5,000 ms, but removal occurs only after stable directory inode,
token, and owner-file inode revalidation. Release repeats identity checks and removes only the
caller's token. The stored PID is metadata: no lock path probes or kills that PID.

`controlSocketPath` resolves the HerdR socket, hashes that absolute path with SHA-256, and uses the
first 16 hexadecimal characters beneath a `zed-herdr` control directory. A nonempty
`XDG_RUNTIME_DIR` supplies the runtime base; otherwise the HerdR socket's parent does. This gives
each HerdR socket a distinct local control endpoint.

The control path requires:

- a safe, existing parent directory owned by the current UID and not group/other writable;
- an owner-only, non-symlink `0700` control directory;
- an owner-only, non-symlink Unix socket mode `0600`;
- stable UID, socket type, device, and inode across probes and mutations.

Preparation refuses a live socket. An orphan is probed twice, identity-checked, atomically moved to
a quarantine name, revalidated, and only then removed. Races fail closed or restore the preserved
entry without replacing a winner. Server shutdown likewise removes only the inode it bound and
restores a replacement without clobbering it.

### Wire protocol and application bridge

The server accepts exactly one newline-delimited frame. Its UTF-8 decoder is fatal, CRLF is accepted
by removing one trailing carriage return, trailing bytes or a second frame are rejected, and the
request is capped at 64 KiB. Unknown object fields are discarded by the tolerant request schemas.

Exact requests:

```json
{ "type": "notify", "notification": { "workspaceId": "<id>", "cwd": "<path>" } }
```

```json
{ "type": "health" }
```

```json
{ "type": "toggle" }
```

Exact success shapes:

```json
{ "ok": true }
```

```json
{
    "ok": true,
    "daemon": {
        "identity": "artisann.zed-herdr:daemon",
        "paneId": null,
        "pid": 1234,
        "startedAt": "2026-01-01T00:00:00.000Z"
    }
}
```

```json
{ "ok": true, "enabled": false }
```

`paneId` is `null | string`; `pid` is a nonnegative integer and `startedAt` is a bounded ISO
timestamp. A toggle response reports the daemon's resulting state. The exact failure shape is:

```json
{
    "ok": false,
    "error": "invalid_request" | "payload_too_large" | "server_failure"
}
```

A validated `notify` request publishes its `HookNotification` into `runDaemon`'s bounded queue.
`Stream.fromQueue` supplies that queue as `WorkspaceHintSource`; no control wire type reaches the
synchronization core. A validated `toggle` request invokes the daemon's Effect control contract
through the captured runtime.

## Flow

### Startup state machine

`runHook` creates one deadline 1,500 ms from startup. Directory preparation, initial notification,
lock acquisition, pane open, and readiness notification all consume that same deadline:

1. Prepare and validate the control directory before attempting notification.
2. Notify the existing daemon. Success returns `Notified` with `openedPane: false`.
3. Only `ControlUnavailable` enters the contender path.
4. Acquire the token lock at `${controlSocketPath}.lock`.
5. Under the lock, notify again before preparing the socket or opening a pane. A concurrent winner
   is reused with `openedPane: false`.
6. After another `ControlUnavailable`, prepare the control socket and open the daemon pane only if
   still needed.
7. Poll notification readiness every 25 ms until the same deadline, then publish the hint.

The exact pane argv is:

```text
herdr plugin pane open --plugin artisann.zed-herdr --entrypoint daemon --placement tab \
    --workspace <workspaceId> --no-focus
```

`HERDR_BIN_PATH` may replace the first token. The pane is deliberately unfocused. An
`AlreadyRunning` discovered while preparing/opening the pane is treated as concurrent reuse only
around that preparation block; readiness notification still must succeed. Stable token locking,
the under-lock recheck, and live-socket refusal yield one pane under contention.

## Failure boundaries

The exported errors define the retry/fail-closed boundary precisely:

- `ControlUnavailable.operation` is `"connect" | "read" | "timeout"`. It is the only condition
  the hook retries or uses to enter daemon startup.
- `UnsafeControlSocket.reason` is `"foreign_owner" | "not_socket" | "symlink" |
"changed_inode" | "lstat_failed" | "probe_failed" | "not_directory" | "unsafe_mode" |
"unsafe_parent"`. Every variant fails closed.
- `ControlProtocolError` fails closed; malformed, oversized, trailing, or unexpected daemon
  responses never trigger pane startup.
- `AlreadyRunning` is handled only around pane preparation as described above.
- `HookStartupError.operation` is `"open_pane" | "readiness" | "lock"` and reaches the CLI failure
  path.

Server-side invalid input returns `invalid_request` or `payload_too_large`; synchronous or
asynchronous notification publication failure returns `server_failure`. Client-side response
decoding remains strict and owner/inode validation occurs before trusting the peer.

## Implementation and tests

- [`herdr-plugin.toml`](../herdr-plugin.toml)
- [`src/plugin/hook.ts`](../src/plugin/hook.ts)
- [`src/plugin/control.ts`](../src/plugin/control.ts)
- [`src/plugin/protocol.ts`](../src/plugin/protocol.ts)
- [`src/app.ts`](../src/app.ts)
- [`test/plugin/hook-unit.test.ts`](../test/plugin/hook-unit.test.ts)
- [`test/plugin/control.test.ts`](../test/plugin/control.test.ts)
- [`test/plugin/control-socket.test.ts`](../test/plugin/control-socket.test.ts)

## Related

- [Architecture](architecture.md)
- [Runtime composition](runtime.md)
- [Service ports](services.md)
- [Synchronization core](synchronization.md)
