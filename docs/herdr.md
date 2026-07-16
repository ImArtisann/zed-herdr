# HerdR workspace source

[Documentation index](README.md)

## Purpose

The HerdR adapter turns read-only HerdR 0.7.3 protocol-16 observations into the
[`WorkspaceSource`](services.md) consumed by the editor-independent core. `HERDR_PROTOCOL` is the
literal `16`. Socket-path precedence remains canonical in the root
[configuration and behavior](../README.md#configuration-and-behavior) runbook.

## Responsibilities

Only two methods can leave the client:

- `session.snapshot`
- `events.subscribe`

The exact subscription set is:

- `workspace.created`
- `workspace.updated`
- `workspace.renamed`
- `workspace.moved`
- `workspace.closed`
- `workspace.focused`
- `worktree.created`
- `worktree.opened`
- `worktree.removed`

No HerdR mutation is sent. Forward-compatible unrelated events and fields do not enter the domain
projection.

## Contracts and state

`LiveHerdRClient` owns the Unix sockets, monotonically increasing connection generations,
generation-local snapshot requests, the current live subscription, reconnect state, and a
replay-one `PubSub`. Replay one lets a consumer that subscribes after acknowledgement still receive
the most recent source event.

`makeHerdRWorkspaceSource` exposes only `snapshot` and `events`.
`HerdRWorkspaceSourceLive` projects the scoped `HerdRClient` onto the core `WorkspaceSource` tag.
Transport-only panes, tabs, layouts, and agents are discarded before the domain snapshot.

## Flow

For generation $N$:

1. **S1 protocol gate.** A separate `session.snapshot` request validates that the peer reports
   protocol `16`. Its workspace state is deliberately discarded.
2. The client opens a subscription socket and sends `events.subscribe` with the exact lifecycle
   set above.
3. Only a matching `subscription_started` acknowledgement resets reconnect failures, marks $N$
   live, and publishes the first `Invalidated(N)`.
4. After acknowledgement, each valid subscribed lifecycle event publishes another
   `Invalidated(N)`. Unrelated events are ignored.
5. The [synchronization daemon](synchronization.md) receives that signal and requests **S2**, a
   fresh authoritative `session.snapshot` for $N$.
6. S2 is protocol-validated again, checked against the live generation before and after transport
   work, and projected into `WorkspaceSnapshot`.

S1 establishes compatibility; S2 supplies state. No editor call is derived from S1.

## Failure boundaries

`NdjsonDecoder` incrementally frames UTF-8 bytes on newlines. Its non-fatal `TextDecoder` replaces
invalid byte sequences rather than rejecting the entire stream. The 64 KiB limit applies only to
the retained unterminated partial frame; completed frames are emitted immediately and are not
size-limited by this decoder.
An oversized unterminated partial frame is connection-fatal; it is not isolated as a recoverable
malformed JSON frame.

Empty lines are ignored. Invalid JSON and malformed relevant lifecycle frames are logged as
`herdr_malformed_frame` and isolated so later frames can proceed. Objects without relevant events
are filtered. A malformed response carrying the active request id is handled at that request's
protocol boundary.

Both the S1 bootstrap snapshot and subscription acknowledgement have five-second timeouts.
Reconnect uses an exponential base from 100 ms through a 5 s maximum, applies ±20% jitter, and
clamps the final delay to 5 s. A disconnect cancels outstanding generation-$N$ snapshots,
terminates their sockets, clears the live generation, and publishes `Disconnected(N)`. Scoped
shutdown interrupts sleep, terminates sockets, cancels requests as stale, and shuts down event
publication.

Source failures remain typed as transport, protocol, unsupported-protocol, or stale-generation
errors. Protocol incompatibility prevents the generation from becoming live.

## Implementation and tests

- [`src/herdr/protocol.ts`](../src/herdr/protocol.ts)
- [`src/herdr/ndjson.ts`](../src/herdr/ndjson.ts)
- [`src/herdr/client.ts`](../src/herdr/client.ts)
- [`src/herdr/workspace-source.ts`](../src/herdr/workspace-source.ts)
- [`test/herdr/client.test.ts`](../test/herdr/client.test.ts)
- [`test/e2e/daemon.test.ts`](../test/e2e/daemon.test.ts)

## Related

- [Runtime composition](runtime.md)
- [Service ports](services.md)
- [Synchronization core](synchronization.md)
