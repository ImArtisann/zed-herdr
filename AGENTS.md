# Repository Guidelines

## Project Overview

`zed-herdr` is a private Bun/TypeScript application that keeps the active HerdR workspace available in an existing Zed session. HerdR 0.7.3 protocol 16 is authoritative for workspace state. The daemon consumes read-only HerdR snapshots/events and plugin cwd hints, resolves Git roots, then invokes only Zed's supported `zed -e <absolute-git-root>` command. It must not inspect Zed databases, replace windows, kill processes, or mutate existing HerdR panes.

Supported hosts are macOS and Linux with Bun, Git, HerdR `>=0.7.3`, and the Zed CLI.

## Architecture & Data Flow

1. `index.ts` runs `runCli()` through `BunRuntime.runMain`; `src/cli.ts` accepts exactly one command: `daemon`, `hook`, `health`, or `toggle`.
2. `src/app.ts` composes Bun platform services, the HerdR workspace source, Zed adapter, JSON logger, plugin control server, and synchronization daemon through Effect `Layer`s.
3. `src/herdr/client.ts` bootstraps each generation with `session.snapshot`, opens `events.subscribe`, waits for `subscription_started`, and only then publishes an `Invalidated` event. A fresh snapshot is requested for synchronization. Disconnects cancel the generation and publish `Disconnected`.
4. `src/sync/daemon.ts` merges source events and hook cwd hints into queues. A single worker collapses bursts for 50 ms, gates every async stage against the live generation and runtime enable cycle, resolves all projects, atomically replaces cache state, ensures each unique Git root, and focuses the authoritative workspace.
5. `src/sync/resolve-project.ts` prefers HerdR `checkoutPath`, falls back to the matching hook cwd hint, verifies a directory, and runs `git -C <path> rev-parse --show-toplevel`. Invalid, inaccessible, ambiguous, or non-Git paths are logged and never reach the editor adapter.
6. `src/editor/zed.ts` serializes shell-free Zed calls. `ensureProject` caches only successful roots; `focusProject` always runs `zed -e`.
7. Plugin hooks send cwd hints to the owner-only control socket. When no live daemon exists, `src/plugin/hook.ts` coordinates contenders with a token lock and opens one unfocused HerdR daemon tab. `health` reads daemon identity; `toggle` pauses or resumes the live synchronization daemon; neither starts one.

Preserve these boundaries: transport types do not enter core domain types, stale generations cannot mutate cache or call Zed, and plugin control/hook code remains separate from the Effect-based synchronization core.

## Key Directories

| Path            | Purpose                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `src/domain/`   | Effect `Schema` domain values and tagged error types independent of HerdR/Zed.                 |
| `src/services/` | `Context.Tag` contracts for workspace source, cwd hints, and editor adapter.                   |
| `src/sync/`     | Project resolution, generation-aware cache, debounce, serialization, and editor orchestration. |
| `src/herdr/`    | Protocol-16 schemas, NDJSON framing, Unix-socket client, and core source projection.           |
| `src/editor/`   | Timeout-safe, state-preserving Zed CLI adapter.                                                |
| `src/plugin/`   | Local control protocol/socket plus hook decoding, locking, and pane startup.                   |
| `test/`         | Bun unit, integration, socket-safety, and built-artifact E2E suites by subsystem.              |
| `dist/`         | Generated Bun bundle; ignored by Git and recreated by `bun run build`.                         |

There is no `src/index.ts`, scripts directory, or separate test configuration. Root `index.ts` and `package.json` are authoritative.

## Development Commands

Run commands from the repository root with Bun:

```bash
bun install --frozen-lockfile  # install exactly from bun.lock
bun run dev                    # watch index.ts and run the daemon
bun run start                  # run the source daemon
bun run build                  # bundle index.ts to dist/index.js for Bun
bun ./dist/index.js daemon     # run the built daemon
bun ./dist/index.js health     # query an existing matching daemon; does not start one
bun test                       # run all tests
bun test test/sync/daemon.test.ts  # run one suite directly
bun run typecheck              # tsc --noEmit
bun run lint                   # oxlint .
bun run lint:fix               # oxlint . --fix
bun run format                 # oxfmt .
bun run check                  # typecheck, lint, build, then full tests
```

Documented plugin workflow:

```bash
bun run build
herdr plugin link <repo>
herdr plugin enable artisann.zed-herdr
herdr plugin disable artisann.zed-herdr
herdr plugin unlink artisann.zed-herdr
```

Build before any command or E2E test that uses `dist/index.js`.

## Code Conventions & Common Patterns

- Use `.ts` extensions in imports. Prefer direct module imports; the repository has no barrel modules.
- Formatter policy: 100-column width, four spaces, semicolons, and double quotes. Run Oxfmt rather than hand-formatting.
- Naming: PascalCase schemas, tags, and error classes; camelCase factories/handlers; uppercase protocol and limit constants; kebab-case filenames.
- Define domain values with Effect `Schema` and infer types with `Schema.Schema.Type`. Keep records readonly and external input bounded.
- Decode environment, JSON, and wire data at boundaries with `Schema.decodeUnknownEither`. Model expected failures with `Schema.TaggedError`; bound logged/CLI causes rather than exposing unbounded input.
- Namespace-import Effect modules and use `Effect.gen(function* () { ... })`. Express dependencies in Effect types, expose service interfaces as `Context.Tag`s, and assemble implementations with explicit `Layer`s.
- Scope resources with `Effect.scoped`, `acquireRelease`, or finalizers. Sockets, fibers, child processes, queues, and subscriptions must be closed on success, failure, and interruption.
- Use `Ref` for atomic state, `Queue`/`PubSub`/`Stream` for event ingress, `Deferred` plus interruption/racing for generation cancellation, and Effect `Clock` for measurable or testable time.
- Low-level plugin control and hook modules intentionally use Bun/Promise APIs with injected interfaces. Do not force them into the Effect service graph or duplicate their socket/startup logic.
- Keep HerdR requests read-only and allowlisted: only `session.snapshot` and `events.subscribe`. Unknown forward-compatible fields/events may be ignored, but malformed frames must be isolated and protocol values other than 16 rejected.
- Preserve checkout-path precedence over hook hints. Do not infer projects from `PWD`, pane metadata, focus order, or editor internals. Linked worktrees remain distinct by canonical path.
- Never cache failed resolution or editor operations. Recheck generation before cache/editor side effects; disconnecting generation N must leave no effects while N+1 may proceed.
- Invoke Zed without a shell and with only `-e <absolute-git-root>`. Preserve the five-second timeout, process termination, and bounded final stderr tail.
- Treat control sockets and hook locks as owner-only resources. Preserve UID, mode, inode, symlink, one-frame, fatal UTF-8, and 64 KiB checks; never blindly unlink or replace a socket path.
- Keep stable JSON log event names and fields (`workspace_sync_started`, `workspace_sync_succeeded`, `workspace_sync_skipped`, `workspace_sync_failed`). `elapsed_ms` begins at event ingress and includes the debounce.

## Important Files

| File                          | Why it matters                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `index.ts`                    | Sole Bun runtime entry; runs CLI with pretty logging disabled.                         |
| `src/cli.ts`                  | Exact command dispatch, exit codes, health output, and bounded failures.               |
| `src/app.ts`                  | Effect layer composition, daemon scope, control server, and hint queue.                |
| `src/domain/workspace.ts`     | Core workspace generations, events, snapshots, projects, and hints.                    |
| `src/domain/errors.ts`        | Tagged resolution, source, configuration, and editor failures.                         |
| `src/sync/daemon.ts`          | Generation gates, cache replacement, debounce, dedupe, and structured logs.            |
| `src/sync/resolve-project.ts` | Path precedence, directory checks, and canonical Git-root resolution.                  |
| `src/herdr/protocol.ts`       | Protocol-16 wire compatibility boundary and method/event allowlists.                   |
| `src/herdr/client.ts`         | Scoped sockets, bootstrap ordering, requests, reconnects, and generation cancellation. |
| `src/editor/zed.ts`           | Only supported editor integration path and timeout behavior.                           |
| `src/plugin/control.ts`       | Owner/inode-safe control socket, exact one-frame request/response handling.            |
| `src/plugin/hook.ts`          | Hook precedence, lock ownership, deadline, and `--no-focus` pane startup.              |
| `herdr-plugin.toml`           | Plugin metadata, build commands, lifecycle hooks, and daemon pane declaration.         |
| `package.json`                | Authoritative development commands and dependency ranges.                              |
| `tsconfig.json`               | Strict Bun-oriented TypeScript contract.                                               |
| `README.md`                   | Operator runbook, configuration, health/log inspection, and removal.                   |
| `CLAUDE.md`                   | Repository Bun-specific implementation guidance.                                       |

## Runtime/Tooling Preferences

- Use Bun for installs, scripts, tests, sockets, subprocesses, and runtime execution. Node appears only transitively in types; this is not a Node-supported application.
- Package management is `bun install --frozen-lockfile`; commit `bun.lock` changes only when dependencies intentionally change. Do not use npm, pnpm, or Yarn.
- Production dependencies are Effect 3.22, `@effect/platform` 0.97, and `@effect/platform-bun` 0.91. Use existing platform abstractions before adding Node APIs.
- TypeScript is strict, no-emit, ESNext, bundler-resolved, verbatim-module ESM with Bun types. `noUncheckedIndexedAccess`, `noImplicitOverride`, and switch fallthrough checks are enabled.
- Oxfmt and Oxlint are the formatter/linter. Generated/dependency/env outputs, including `dist/` and `bun.lock`, are intentionally excluded from formatting.
- Runtime assumptions include POSIX UIDs and Unix sockets; the plugin manifest supports only macOS and Linux.
- Relevant environment configuration: `ZED_BIN`; `HERDR_SOCKET_PATH`; `HERDR_SESSION`; `XDG_CONFIG_HOME`/`HOME`; hook-provided `HERDR_PLUGIN_EVENT_JSON`, `HERDR_WORKSPACE_ID`, `HERDR_PLUGIN_CONTEXT_JSON`, and `HERDR_PANE_ID`; optional hook CLI override `HERDR_BIN_PATH`. `ZED_HERDR_TEST_DIST` is test-only.

## Testing & QA

- Tests use native `bun:test` with top-level `test`/`expect`, async test bodies, and ESM TypeScript imports. There are no global setup files, `describe` blocks, or lifecycle hooks.
- Suites mirror subsystems: `test/sync/`, `test/herdr/`, `test/editor/`, `test/plugin/`, and `test/e2e/`.
- Test observable contracts, not implementation text: exact NDJSON bytes/JSON, CLI argv and ordering, generation transitions, editor-call serialization/dedupe, retry bounds, socket/lock ownership, timeout cleanup, and process exit behavior.
- Use `Effect.scoped`/`Effect.runPromise` for Effect harnesses. Prefer `TestClock` for debounce and timeout behavior; use fake timers only where the Promise/Bun boundary requires them. Always restore timers and spies.
- Unix-socket tests use temporary paths and real `Bun.listen`/`Bun.connect`; Git-resolution tests create temporary repositories and linked worktrees. Close listeners, interrupt fibers, terminate children, and remove temporary directories in `finally`.
- `test/e2e/daemon.test.ts` exercises the built `dist/index.js` against fake HerdR and Zed socket peers. Run `bun run build` first; its main scenario has a 15-second timeout.
- Do not assert exact timestamps or nondeterministic jitter. Assert stable tags, fields, ranges, ordering, and final effects.
- No numeric coverage threshold is configured. Every behavior change should add or update the narrow deterministic contract test; changes crossing the built CLI/socket boundary should also be covered by E2E.
- Before pushing, run `bun run check`. Expected malformed-frame/reconnect fixtures emit warning logs while still passing.
