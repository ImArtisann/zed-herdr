# Zed Workspace Sync

[![Plugin Demo](https://img.youtube.com/vi/Q_i-IKda7hE/maxresdefault.jpg)](https://youtu.be/Q_i-IKda7hE)

HerdR plugin `artisann.zed-herdr` keeps the active HerdR workspace available in Zed without taking ownership of either application. It supports macOS and Linux, HerdR **0.7.3+** using protocol **16**, Bun, Git, and Zed with its `zed` CLI available.

For contributor architecture and subsystem internals, see [the documentation index](docs/README.md).

## Build and install

Run plugin commands from a HerdR environment (`HERDR_ENV=1`), then build and link this checkout:

```bash
cd zed-herdr
bun install --frozen-lockfile
bun run build
herdr plugin link ImArtisann/zed-herdr
herdr plugin enable artisann.zed-herdr
```

Linking makes the local checkout available to HerdR; enabling activates its declared hooks. The plugin starts automatically for `workspace.created` and `workspace.focused` events. Its hook opens its own **unfocused** `Zed Workspace Sync` tab only when no live plugin daemon is available.

For direct development, run the same daemon without the plugin host:

```bash
bun run dev
# or, without watch mode:
bun run start
```

Both commands require access to the current HerdR session socket. The built artifact can also be started directly with `bun ./dist/index.js daemon`.

## Health and inspection

Ask the daemon on the current session's control socket for its health:

```bash
bun dist/index.js health
```

A successful response is JSON shaped like:

```json
{
    "ok": true,
    "daemon": {
        "identity": "artisann.zed-herdr:daemon",
        "paneId": "<pane-id>",
        "pid": 1234,
        "startedAt": "2026-01-01T00:00:00.000Z"
    }
}
```

`identity` identifies this plugin's owner-validated local daemon, `paneId` is the plugin pane that hosts it (or `null` when not injected by HerdR), and `pid`/`startedAt` identify that daemon instance. Exit status `1` means no valid matching daemon answered; it does not start one.

Use the plugin registry and plugin log to inspect the installation:

```bash
herdr plugin list --plugin artisann.zed-herdr --json
herdr plugin log list --plugin artisann.zed-herdr --limit 100
```

Use the `paneId` from `health` (or the response from a manual plugin-pane open) to inspect the daemon terminal:

```bash
herdr pane read <pane-id> --source recent-unwrapped --lines 100 --format text
```

HerdR 0.7.3 exposes plugin-pane `open`, `focus`, and `close` operations; use the health response rather than relying on a plugin-pane listing command.

## Configuration and behavior

Set `ZED_BIN` to a non-empty executable path to select a Zed CLI explicitly:

```bash
export ZED_BIN=/absolute/path/to/zed
```

Without `ZED_BIN`, the daemon resolves `zed` from `PATH`; on macOS an executable-not-found result also tries Zed's standard application CLI path. It invokes only `zed -e <absolute-git-root>`.

For HerdR transport, `HERDR_SOCKET_PATH` takes precedence. Otherwise the socket is resolved as:

1. `$XDG_CONFIG_HOME/herdr/sessions/$HERDR_SESSION/herdr.sock` for a named session, or `~/.config/herdr/sessions/$HERDR_SESSION/herdr.sock` when `XDG_CONFIG_HOME` is unset.
2. `$XDG_CONFIG_HOME/herdr/herdr.sock`, or `~/.config/herdr/herdr.sock`, when there is no named session.

The daemon reads HerdR snapshots and lifecycle events, then asks Zed to add/focus a validated Git root. It never sends a mutating HerdR request, kills a process, reuses an existing pane, replaces Zed window/project state, accesses Zed's private storage, or uses Zed's state-replacing CLI options. Non-worktree workspaces wait for the plugin hook's workspace cwd hint; ambiguous, inaccessible, or non-Git paths are skipped.

## Troubleshooting

- **Protocol mismatch:** use HerdR 0.7.3 or later with protocol 16. A different protocol is rejected rather than guessed; update the compatible HerdR/plugin pair, rebuild, and relink if needed.
- **Socket or health failure:** confirm `HERDR_SOCKET_PATH`, `HERDR_SESSION`, and `XDG_CONFIG_HOME` describe the intended session, then inspect the plugin log and daemon pane output above. Focusing or creating a workspace will run the activation hook again.
- **Zed errors:** ensure `ZED_BIN` points to an executable, or that `zed` is on `PATH`; inspect the daemon output for the failed `zed -e` command. The daemon leaves HerdR and existing Zed state unchanged when Zed rejects or times out.

## Disable or remove

For a linked checkout, stop future hook activation and remove the link:

```bash
herdr plugin disable artisann.zed-herdr
herdr plugin unlink artisann.zed-herdr
```

For a plugin installed from a remote source instead of linked from this checkout, use:

```bash
herdr plugin uninstall artisann.zed-herdr
```
