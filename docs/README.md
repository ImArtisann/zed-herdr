# Zed Workspace Sync documentation

## Start here

This contributor reference documents the supported boundary: Bun on macOS or Linux, HerdR 0.7.3 using protocol 16, Git, and Zed through its public CLI. The root [operator runbook](../README.md) remains the canonical guide for installation, configuration, health checks, troubleshooting, and removal. Use the [compact contributor checklist](../AGENTS.md) for repository conventions and safety invariants.

For a first architecture pass, read [Architecture](architecture.md), [Domain model](domain.md), and [Service ports](services.md), then continue into the subsystem pages that own the behavior you are changing.

## Documentation map

| Page                                       | Responsibility                                                                | Source                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Architecture](architecture.md)            | Connects daemon synchronization and plugin-hook startup end to end.           | [`index.ts`](../index.ts), [`src/app.ts`](../src/app.ts)                     |
| [Runtime composition](runtime.md)          | CLI dispatch, configuration, Effect layers, and daemon resource scope.        | [`src/cli.ts`](../src/cli.ts), [`src/app.ts`](../src/app.ts)                 |
| [Domain model](domain.md)                  | Editor-independent workspace values and typed failures.                       | [`src/domain/`](../src/domain/)                                              |
| [Service ports](services.md)               | Dependency-inverted contracts consumed by the synchronization core.           | [`src/services/`](../src/services/)                                          |
| [HerdR workspace source](herdr.md)         | Protocol-16 transport, generations, events, and source projection.            | [`src/herdr/`](../src/herdr/)                                                |
| [Synchronization core](synchronization.md) | Generation gating, project resolution, cache replacement, and orchestration.  | [`src/sync/`](../src/sync/)                                                  |
| [Plugin lifecycle and control](plugin.md)  | Hook decoding, startup contention, local control protocol, and socket safety. | [`src/plugin/`](../src/plugin/), [`herdr-plugin.toml`](../herdr-plugin.toml) |
| [Zed editor adapter](editor.md)            | Serialized, timeout-safe `zed -e` integration.                                | [`src/editor/`](../src/editor/)                                              |
| [Documentation index](README.md)           | Reading paths and ownership map for this documentation set.                   | [`docs/`](./)                                                                |

## Suggested reading paths

- Normal daemon synchronization: [Architecture](architecture.md) → [HerdR workspace source](herdr.md) → [Service ports](services.md) → [Synchronization core](synchronization.md) → [Zed editor adapter](editor.md).
- Plugin-hook startup and cwd hints: [Architecture](architecture.md) → [Plugin lifecycle and control](plugin.md) → [Service ports](services.md) → [Synchronization core](synchronization.md).
- Domain or contract changes: [Domain model](domain.md) → [Service ports](services.md) → the owning subsystem page.

## Repository guides

- [Operator runbook](../README.md): [build and installation](../README.md#build-and-install),
  [health and inspection](../README.md#health-and-inspection),
  [configuration and behavior](../README.md#configuration-and-behavior),
  [troubleshooting](../README.md#troubleshooting), and
  [disable or removal](../README.md#disable-or-remove).
- [Contributor checklist](../AGENTS.md): architecture boundaries, commands, conventions, and QA expectations.
