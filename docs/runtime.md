# Runtime composition

[Documentation index](README.md)

## Purpose

The runtime selects one CLI path, decodes process configuration, and scopes the Effect application
and the separate local control server. Synchronization policy remains in the
[synchronization core](synchronization.md).

## Responsibilities

[`index.ts`](../index.ts) calls `BunRuntime.runMain(runCli(), { disablePrettyLogger: true })`.
[`runCli`](../src/cli.ts) accepts exactly one argument and exposes this exact usage literal:

```text
Usage: zed-herdr <daemon|hook|health|toggle>
```

The one argument dispatches as follows:

| Command  | Runtime path                                                                 |
| -------- | ---------------------------------------------------------------------------- |
| `daemon` | `decodeAppConfig` → `runDaemon`                                              |
| `hook`   | Promise-based `runHook` wrapped at the CLI boundary                          |
| `health` | Promise-based `healthControl` plus daemon-identity validation                |
| `toggle` | Promise-based `toggleControl`, printing the daemon's resulting enabled state |

Missing, extra, or unknown arguments print the usage and set exit status `2`.

## Contracts and state

[`decodeAppConfig`](../src/config.ts) reads optional `ZED_BIN`, trims it, and rejects an explicitly
present value that becomes empty. An absent value remains `undefined`, allowing the Zed adapter to
resolve `zed` through `PATH`.

`makeAppLayer` composes the daemon dependencies:

| Layer                       | Supplied responsibility                                     |
| --------------------------- | ----------------------------------------------------------- |
| `BunContext.layer`          | Bun command, filesystem, and path platform services         |
| `HerdRWorkspaceSourceLive`  | The protocol-16 `WorkspaceSource` implementation            |
| `makeZedEditorAdapterLayer` | The `EditorAdapter` implementation, configured by `ZED_BIN` |
| `WorkspaceHintSource`       | The stream supplied by the control notification queue       |
| `Logger.json`               | Stable JSON logging for source and synchronization events   |

The layer graph supplies implementations to `makeSyncDaemon`; it does not move plugin socket or
lock coordination into the Effect service graph.

## Flow

1. `BunRuntime.runMain` starts `runCli`.
2. `daemon` decodes configuration and enters `runDaemon`.
3. `runDaemon` allocates a bounded `HookNotification` queue with capacity `256` and adds a queue
   shutdown finalizer.
4. It trims `HERDR_PANE_ID`, using `null` when absent or empty, creates the synchronization daemon,
   and starts the owner-only control server at the derived control path.
5. The control server bridges `toggle` requests to the synchronization daemon through the current
   Effect runtime. `Effect.acquireRelease` scopes that server and closes it during release.
6. `Stream.fromQueue` projects accepted notifications into the `WorkspaceHintSource` layer.
7. The scoped synchronization daemon runs with the assembled application layer. Scope exit closes
   the control server, shuts down the queue, and releases the source and adapter resources.

The control server is a low-level Promise/Bun resource bridged through the current Effect runtime.
Its socket safety and request protocol are documented with the [plugin boundary](plugin.md).

## Failure boundaries

`hook`, `health`, and `toggle` failures pass through `commandFailed`: it renders an error message,
keeps at most the last 4,096 characters, prints it, and sets exit status `1`. `health` also uses
that path if the response carries the wrong daemon identity.

Daemon configuration and runtime failures do **not** pass through `commandFailed`. They remain
Effect failures and propagate through `BunRuntime.runMain`. This distinction prevents the docs from
promising the hook/health formatting contract for daemon failures.

## Implementation and tests

- [`index.ts`](../index.ts)
- [`src/cli.ts`](../src/cli.ts)
- [`src/config.ts`](../src/config.ts)
- [`src/app.ts`](../src/app.ts)
- [`test/e2e/daemon.test.ts`](../test/e2e/daemon.test.ts) covers the built daemon path.
- [`test/plugin/control.test.ts`](../test/plugin/control.test.ts) covers the runtime-facing control
  contract.

## Related

- [Architecture](architecture.md)
- [Service ports](services.md)
- [HerdR workspace source](herdr.md)
- [Plugin lifecycle and control](plugin.md)
- [Zed editor adapter](editor.md)
