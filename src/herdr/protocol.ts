import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { UnsupportedHerdRProtocol } from "../domain/errors.ts";

/** The only HerdR wire protocol revision supported by this transport. */
export const HERDR_PROTOCOL = 16 as const;

const UnsignedInteger = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const HerdRId = Schema.String;
const AgentStatus = Schema.Literal("idle", "working", "blocked", "done", "unknown");

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
    Schema.Struct({ type: Schema.Literal("workspace.renamed") }),
    Schema.Struct({ type: Schema.Literal("workspace.moved") }),
    Schema.Struct({ type: Schema.Literal("workspace.closed") }),
    Schema.Struct({ type: Schema.Literal("workspace.focused") }),
    Schema.Struct({ type: Schema.Literal("worktree.created") }),
    Schema.Struct({ type: Schema.Literal("worktree.opened") }),
    Schema.Struct({ type: Schema.Literal("worktree.removed") }),
);
export type LifecycleSubscription = Schema.Schema.Type<typeof LifecycleSubscription>;

/** The exact lifecycle subscription set owned by this integration. */
export const LifecycleSubscriptions: ReadonlyArray<LifecycleSubscription> = [
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

export const makeEventsSubscribeRequest = (id: string): EventsSubscribeRequest =>
    EventsSubscribeRequest.make({
        id,
        method: "events.subscribe",
        params: { subscriptions: [...LifecycleSubscriptions] },
    });

/** The worktree summary embedded in a workspace listing. */
export const WorkspaceWorktreeInfo = Schema.Struct({
    repo_key: Schema.String,
    repo_name: Schema.String,
    repo_root: Schema.String,
    checkout_path: Schema.String,
    is_linked_worktree: Schema.Boolean,
});
export type WorkspaceWorktreeInfo = Schema.Schema.Type<typeof WorkspaceWorktreeInfo>;

/** A HerdR workspace as returned by snapshots and workspace lifecycle events. */
export const WorkspaceInfo = Schema.Struct({
    workspace_id: HerdRId,
    number: UnsignedInteger,
    label: Schema.String,
    focused: Schema.Boolean,
    pane_count: UnsignedInteger,
    tab_count: UnsignedInteger,
    active_tab_id: Schema.String,
    agent_status: AgentStatus,
    worktree: Schema.optional(Schema.NullOr(WorkspaceWorktreeInfo)),
});
export type WorkspaceInfo = Schema.Schema.Type<typeof WorkspaceInfo>;

/** A physical git worktree used by worktree lifecycle events. */
export const WorktreeInfo = Schema.Struct({
    path: Schema.String,
    is_bare: Schema.Boolean,
    is_detached: Schema.Boolean,
    is_prunable: Schema.Boolean,
    is_linked_worktree: Schema.Boolean,
    label: Schema.String,
    branch: Schema.optional(Schema.NullOr(Schema.String)),
    open_workspace_id: Schema.optional(Schema.NullOr(HerdRId)),
});
export type WorktreeInfo = Schema.Schema.Type<typeof WorktreeInfo>;

/** Pane data retained at the transport boundary; it never reaches the core snapshot. */
export const PaneInfo = Schema.Struct({
    pane_id: HerdRId,
    terminal_id: HerdRId,
    workspace_id: HerdRId,
    tab_id: HerdRId,
    focused: Schema.Boolean,
    agent_status: AgentStatus,
    revision: UnsignedInteger,
    cwd: Schema.optional(Schema.NullOr(Schema.String)),
    foreground_cwd: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PaneInfo = Schema.Schema.Type<typeof PaneInfo>;

/** The complete snapshot fields required by protocol 16, with unrelated entries stripped. */
export const SessionSnapshot = Schema.Struct({
    version: Schema.String,
    protocol: UnsignedInteger,
    workspaces: Schema.Array(WorkspaceInfo),
    tabs: Schema.Array(Schema.Unknown),
    panes: Schema.Array(PaneInfo),
    layouts: Schema.Array(Schema.Unknown),
    agents: Schema.Array(Schema.Unknown),
    focused_workspace_id: Schema.optional(Schema.NullOr(HerdRId)),
    focused_tab_id: Schema.optional(Schema.NullOr(HerdRId)),
    focused_pane_id: Schema.optional(Schema.NullOr(HerdRId)),
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

export const WorkspaceCreated = Schema.Struct({
    type: Schema.Literal("workspace_created"),
    workspace: WorkspaceInfo,
});
export const WorkspaceUpdated = Schema.Struct({
    type: Schema.Literal("workspace_updated"),
    workspace: WorkspaceInfo,
});
export const WorkspaceRenamed = Schema.Struct({
    type: Schema.Literal("workspace_renamed"),
    workspace_id: HerdRId,
    label: Schema.String,
});
export const WorkspaceMoved = Schema.Struct({
    type: Schema.Literal("workspace_moved"),
    workspace_id: HerdRId,
    insert_index: UnsignedInteger,
    workspaces: Schema.Array(WorkspaceInfo),
});
export const WorkspaceClosed = Schema.Struct({
    type: Schema.Literal("workspace_closed"),
    workspace_id: HerdRId,
    workspace: Schema.optional(Schema.NullOr(WorkspaceInfo)),
});
export const WorkspaceFocused = Schema.Struct({
    type: Schema.Literal("workspace_focused"),
    workspace_id: HerdRId,
});
export const WorktreeCreated = Schema.Struct({
    type: Schema.Literal("worktree_created"),
    workspace: WorkspaceInfo,
    worktree: WorktreeInfo,
});
export const WorktreeOpened = Schema.Struct({
    type: Schema.Literal("worktree_opened"),
    workspace: WorkspaceInfo,
    worktree: WorktreeInfo,
    already_open: Schema.Boolean,
});
export const WorktreeRemoved = Schema.Struct({
    type: Schema.Literal("worktree_removed"),
    workspace_id: HerdRId,
    workspace: Schema.optional(Schema.NullOr(WorkspaceInfo)),
    worktree: WorktreeInfo,
    forced: Schema.Boolean,
});

/** Lifecycle payloads use underscored response event names. */
export const LifecycleEventData = Schema.Union(
    WorkspaceCreated,
    WorkspaceUpdated,
    WorkspaceRenamed,
    WorkspaceMoved,
    WorkspaceClosed,
    WorkspaceFocused,
    WorktreeCreated,
    WorktreeOpened,
    WorktreeRemoved,
);
export type LifecycleEventData = Schema.Schema.Type<typeof LifecycleEventData>;

const lifecycleEventNames: Record<LifecycleEventName, true> = {
    workspace_created: true,
    workspace_updated: true,
    workspace_renamed: true,
    workspace_moved: true,
    workspace_closed: true,
    workspace_focused: true,
    worktree_created: true,
    worktree_opened: true,
    worktree_removed: true,
};

export type LifecycleEventName = LifecycleEventData["type"];

/** Returns false for unrelated events before schema decoding is attempted. */
export const isLifecycleEventName = (event: unknown): event is LifecycleEventName =>
    typeof event === "string" && Object.hasOwn(lifecycleEventNames, event);

/** Required envelopes keep the envelope event and data.type coupled. */
export const LifecycleEventEnvelope = Schema.Union(
    Schema.Struct({ event: Schema.Literal("workspace_created"), data: WorkspaceCreated }),
    Schema.Struct({ event: Schema.Literal("workspace_updated"), data: WorkspaceUpdated }),
    Schema.Struct({ event: Schema.Literal("workspace_renamed"), data: WorkspaceRenamed }),
    Schema.Struct({ event: Schema.Literal("workspace_moved"), data: WorkspaceMoved }),
    Schema.Struct({ event: Schema.Literal("workspace_closed"), data: WorkspaceClosed }),
    Schema.Struct({ event: Schema.Literal("workspace_focused"), data: WorkspaceFocused }),
    Schema.Struct({ event: Schema.Literal("worktree_created"), data: WorktreeCreated }),
    Schema.Struct({ event: Schema.Literal("worktree_opened"), data: WorktreeOpened }),
    Schema.Struct({ event: Schema.Literal("worktree_removed"), data: WorktreeRemoved }),
);
export type LifecycleEventEnvelope = Schema.Schema.Type<typeof LifecycleEventEnvelope>;

/** Validate the compatibility boundary after decoding a session snapshot. */
export const validateHerdRProtocol = (
    snapshot: SessionSnapshot,
): Effect.Effect<SessionSnapshot, UnsupportedHerdRProtocol> =>
    snapshot.protocol === HERDR_PROTOCOL
        ? Effect.succeed(snapshot)
        : Effect.fail(
              new UnsupportedHerdRProtocol({ expected: HERDR_PROTOCOL, actual: snapshot.protocol }),
          );
