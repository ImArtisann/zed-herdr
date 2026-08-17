import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { UnsupportedHerdRProtocol } from "../domain/errors.ts";

/** Oldest HerdR wire protocol revision this transport can safely consume. */
export const MINIMUM_HERDR_PROTOCOL = 16 as const;

/** Newest HerdR wire protocol revision covered by this repository's compatibility tests. */
export const HIGHEST_TESTED_HERDR_PROTOCOL = 19 as const;
const EXTENDED_LIFECYCLE_SUBSCRIPTIONS_PROTOCOL = 19;

const UnsignedInteger = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const HerdRId = Schema.String;

/** A request envelope before its method-specific payload is inspected. */
export const HerdRRequestEnvelope = Schema.Struct({
    id: HerdRId,
    method: Schema.String,
    params: Schema.Unknown,
});
export type HerdRRequestEnvelope = Schema.Schema.Type<typeof HerdRRequestEnvelope>;

export const SessionSnapshotRequest = Schema.Struct({
    id: HerdRId,
    method: Schema.Literal("session.snapshot"),
    params: Schema.Struct({}),
});
export type SessionSnapshotRequest = Schema.Schema.Type<typeof SessionSnapshotRequest>;

/** Subscription spelling uses dotted API method names, not lifecycle event names. */
export const LifecycleSubscription = Schema.Union(
    Schema.Struct({ type: Schema.Literal("workspace.created") }),
    Schema.Struct({ type: Schema.Literal("workspace.updated") }),
    Schema.Struct({ type: Schema.Literal("workspace.metadata_updated") }),
    Schema.Struct({ type: Schema.Literal("workspace.renamed") }),
    Schema.Struct({ type: Schema.Literal("workspace.moved") }),
    Schema.Struct({ type: Schema.Literal("workspace.reordered") }),
    Schema.Struct({ type: Schema.Literal("workspace.closed") }),
    Schema.Struct({ type: Schema.Literal("workspace.focused") }),
    Schema.Struct({ type: Schema.Literal("worktree.created") }),
    Schema.Struct({ type: Schema.Literal("worktree.opened") }),
    Schema.Struct({ type: Schema.Literal("worktree.removed") }),
);
export type LifecycleSubscription = Schema.Schema.Type<typeof LifecycleSubscription>;

const BASE_LIFECYCLE_SUBSCRIPTIONS: ReadonlyArray<LifecycleSubscription> = [
    { type: "workspace.created" },
    { type: "workspace.updated" },
    { type: "workspace.renamed" },
    { type: "workspace.moved" },
    { type: "workspace.closed" },
    { type: "workspace.focused" },
    { type: "worktree.created" },
    { type: "worktree.opened" },
    { type: "worktree.removed" },
];

const PROTOCOL_19_LIFECYCLE_SUBSCRIPTIONS: ReadonlyArray<LifecycleSubscription> = [
    ...BASE_LIFECYCLE_SUBSCRIPTIONS,
    { type: "workspace.metadata_updated" },
    { type: "workspace.reordered" },
];

export const EventsSubscribeRequest = Schema.Struct({
    id: HerdRId,
    method: Schema.Literal("events.subscribe"),
    params: Schema.Struct({
        subscriptions: Schema.Array(LifecycleSubscription),
    }),
});
export type EventsSubscribeRequest = Schema.Schema.Type<typeof EventsSubscribeRequest>;

/** The read-only request methods that may leave this client. */
export const HerdRRequest = Schema.Union(SessionSnapshotRequest, EventsSubscribeRequest);
export type HerdRRequest = Schema.Schema.Type<typeof HerdRRequest>;

export const makeSessionSnapshotRequest = (id: string): SessionSnapshotRequest =>
    SessionSnapshotRequest.make({ id, method: "session.snapshot", params: {} });

export const makeEventsSubscribeRequest = (id: string, protocol: number): EventsSubscribeRequest =>
    EventsSubscribeRequest.make({
        id,
        method: "events.subscribe",
        params: {
            subscriptions: [
                ...(protocol >= EXTENDED_LIFECYCLE_SUBSCRIPTIONS_PROTOCOL
                    ? PROTOCOL_19_LIFECYCLE_SUBSCRIPTIONS
                    : BASE_LIFECYCLE_SUBSCRIPTIONS),
            ],
        },
    });

/** The worktree fields consumed when projecting a workspace snapshot into the core domain. */
export const WorkspaceWorktreeInfo = Schema.Struct({
    checkout_path: Schema.String,
    is_linked_worktree: Schema.Boolean,
});
export type WorkspaceWorktreeInfo = Schema.Schema.Type<typeof WorkspaceWorktreeInfo>;

/** The workspace fields consumed when projecting a snapshot into the core domain. */
export const WorkspaceInfo = Schema.Struct({
    workspace_id: HerdRId,
    label: Schema.String,
    worktree: Schema.optional(Schema.NullOr(WorkspaceWorktreeInfo)),
});
export type WorkspaceInfo = Schema.Schema.Type<typeof WorkspaceInfo>;

/**
 * The snapshot fields consumed by protocol negotiation and the core projection.
 * Unknown transport fields are intentionally discarded at this boundary.
 */
export const SessionSnapshot = Schema.Struct({
    protocol: UnsignedInteger,
    workspaces: Schema.Array(WorkspaceInfo),
    focused_workspace_id: Schema.optional(Schema.NullOr(HerdRId)),
});
export type SessionSnapshot = Schema.Schema.Type<typeof SessionSnapshot>;

export const SessionSnapshotResult = Schema.Struct({
    type: Schema.Literal("session_snapshot"),
    snapshot: SessionSnapshot,
});
export type SessionSnapshotResult = Schema.Schema.Type<typeof SessionSnapshotResult>;

export const SubscriptionStarted = Schema.Struct({
    type: Schema.Literal("subscription_started"),
});
export type SubscriptionStarted = Schema.Schema.Type<typeof SubscriptionStarted>;

/** Success responses relevant to the two permitted methods. */
export const HerdRSuccessResponse = Schema.Struct({
    id: HerdRId,
    result: Schema.Union(SessionSnapshotResult, SubscriptionStarted),
});
export type HerdRSuccessResponse = Schema.Schema.Type<typeof HerdRSuccessResponse>;

export const HerdRErrorResponse = Schema.Struct({
    id: HerdRId,
    error: Schema.Struct({
        code: Schema.String,
        message: Schema.String,
    }),
});
export type HerdRErrorResponse = Schema.Schema.Type<typeof HerdRErrorResponse>;

const lifecycleEventNames = [
    "workspace_metadata_updated",
    "workspace_created",
    "workspace_updated",
    "workspace_renamed",
    "workspace_reordered",
    "workspace_moved",
    "workspace_closed",
    "workspace_focused",
    "worktree_created",
    "worktree_opened",
    "worktree_removed",
] as const;

const lifecycleEventNameLookup: Record<(typeof lifecycleEventNames)[number], true> = {
    workspace_created: true,
    workspace_updated: true,
    workspace_renamed: true,
    workspace_moved: true,
    workspace_metadata_updated: true,
    workspace_closed: true,
    workspace_focused: true,
    worktree_created: true,
    workspace_reordered: true,
    worktree_opened: true,
    worktree_removed: true,
};
const LifecycleEventNameSchema = Schema.Literal(...lifecycleEventNames);

export type LifecycleEventName = (typeof lifecycleEventNames)[number];

/** Returns false for unrelated events before schema decoding is attempted. */
export const isLifecycleEventName = (event: unknown): event is LifecycleEventName =>
    typeof event === "string" && Object.hasOwn(lifecycleEventNameLookup, event);

/** Lifecycle payloads are intentionally ignored; every recognized event invalidates the snapshot. */
export const LifecycleEventEnvelope = Schema.Struct({
    event: LifecycleEventNameSchema,
});
export type LifecycleEventEnvelope = Schema.Schema.Type<typeof LifecycleEventEnvelope>;

/** Validate the compatibility boundary after decoding a session snapshot. */
export const validateHerdRProtocol = (
    snapshot: SessionSnapshot,
): Effect.Effect<SessionSnapshot, UnsupportedHerdRProtocol> =>
    snapshot.protocol >= MINIMUM_HERDR_PROTOCOL
        ? Effect.succeed(snapshot)
        : Effect.fail(
              new UnsupportedHerdRProtocol({
                  minimum: MINIMUM_HERDR_PROTOCOL,
                  actual: snapshot.protocol,
              }),
          );
