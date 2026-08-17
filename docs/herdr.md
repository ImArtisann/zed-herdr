# HerdR workspace source

[Documentation index](README.md)

## Purpose

The HerdR adapter turns read-only observations from HerdR 0.7.3 or newer into the
[`WorkspaceSource`](services.md) consumed by the editor-independent core.
`MINIMUM_HERDR_PROTOCOL` is `16`; compatibility is tested through
`HIGHEST_TESTED_HERDR_PROTOCOL` `19`. Socket-path precedence remains canonical in the root
[configuration and behavior](../README.md#configuration-and-behavior) runbook.

## Responsibilities

Only two methods can leave the client:

- `session.snapshot`
- `events.subscribe`

The base subscription set for protocols 16 through 18 is:

- `workspace.created`
- `workspace.updated`
- `workspace.renamed`
- `workspace.moved`
- `workspace.closed`
- `workspace.focused`
- `worktree.created`
- `worktree.opened`
- `worktree.removed`

Protocol 19 adds `workspace.metadata_updated` and `workspace.reordered`. The selection is
protocol-gated because HerdR rejects the entire `events.subscribe` request when any subscription
type is unknown; sending the protocol-19 names to HerdR 0.7.3 would prevent the generation from
becoming live.

No HerdR mutation is sent. Snapshot schemas decode only the protocol, workspace fields, and focus
identifier consumed by the core projection. Unknown transport fields are discarded. Recognized
lifecycle names invalidate the snapshot without decoding their discarded payloads; unrelated event
names are ignored.

## Contracts and state

`LiveHerdRClient` owns the Unix sockets, monotonically increasing connection generations,
generation-local snapshot requests, the current live subscription, reconnect state, and a
replay-one `PubSub`. Replay one lets a consumer that subscribes after acknowledgement still receive
the most recent source event.

`makeHerdRWorkspaceSource` exposes only `snapshot` and `events`.
`HerdRWorkspaceSourceLive` projects the scoped `HerdRClient` onto the core `WorkspaceSource` tag.
The client separately exposes its last negotiated protocol to the local health server; this
transport status does not enter the core domain.

## Flow

For generation $N$:

1. **S1 protocol gate.** A separate `session.snapshot` request requires protocol 16 or newer. Its
   workspace state is deliberately discarded. The accepted protocol is retained for health and
   subscription selection.
2. The client opens a subscription socket and sends `events.subscribe` with the protocol-selected
   lifecycle set above.
3. Only a matching `subscription_started` acknowledgement resets reconnect failures, marks $N$
   live, and publishes the first `Invalidated(N)`.
4. After acknowledgement, each recognized subscribed lifecycle name publishes another
   `Invalidated(N)`, regardless of unconsumed payload shape. Unrelated event names are ignored.
5. The [synchronization daemon](synchronization.md) receives that signal and requests **S2**, a
   fresh authoritative `session.snapshot` for $N$.
6. S2 is protocol-validated again, checked against the live generation before and after transport
   work, and projected into the strict domain `WorkspaceSnapshot`.

S1 establishes compatibility; S2 supplies state. No editor call is derived from S1.

## Failure boundaries

`NdjsonDecoder` incrementally frames UTF-8 bytes on newlines. Its non-fatal `TextDecoder` replaces
invalid byte sequences rather than rejecting the entire stream. The 64 KiB limit applies only to
the retained unterminated partial frame; completed frames are emitted immediately and are not
size-limited by this decoder.
An oversized unterminated partial frame is connection-fatal; it is not isolated as a recoverable
malformed JSON frame.

Empty lines are ignored. Invalid JSON is logged as `herdr_malformed_frame` and isolated so later
frames can proceed. Objects without recognized lifecycle names are filtered. A matching snapshot
response decodes only fields consumed by protocol negotiation and the core projection, so additive
fields and new values in discarded fields cannot strand the request until its timeout.

Both the S1 bootstrap snapshot and subscription acknowledgement have five-second timeouts.
Reconnect uses an exponential base from 100 ms through a 5 s maximum, applies ±20% jitter, and
clamps the final delay to 5 s. A disconnect cancels outstanding generation-$N$ snapshots,
terminates their sockets, clears the live generation, and publishes `Disconnected(N)`. Scoped
shutdown interrupts sleep, terminates sockets, cancels requests as stale, and shuts down event
publication.

Protocols below 16 fail as `UnsupportedHerdRProtocol`, log `herdr_protocol_unsupported`, and
terminate the client run loop without reconnecting. Newer protocols are accepted. A value above
protocol 19 logs `herdr_protocol_beyond_tested` once and sets `beyondTested` in health. Other source
failures remain typed as transport, protocol, or stale-generation errors and retain reconnect
behavior.

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
