import * as Schema from "effect/Schema";

const WorkspaceText = Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(4_096));

/** A HerdR workspace identifier. */
export const WorkspaceId = WorkspaceText.pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = Schema.Schema.Type<typeof WorkspaceId>;

/** A nonnegative, monotonically increasing source-connection generation. */
export const WorkspaceGeneration = Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
    Schema.brand("WorkspaceGeneration"),
);
export type WorkspaceGeneration = Schema.Schema.Type<typeof WorkspaceGeneration>;

export const WorkspaceInvalidated = Schema.TaggedStruct("Invalidated", {
    generation: WorkspaceGeneration,
});
export type WorkspaceInvalidated = Schema.Schema.Type<typeof WorkspaceInvalidated>;

export const WorkspaceDisconnected = Schema.TaggedStruct("Disconnected", {
    generation: WorkspaceGeneration,
});
export type WorkspaceDisconnected = Schema.Schema.Type<typeof WorkspaceDisconnected>;

export const WorkspaceSourceEvent = Schema.Union(WorkspaceInvalidated, WorkspaceDisconnected);
export type WorkspaceSourceEvent = Schema.Schema.Type<typeof WorkspaceSourceEvent>;

export const WorkspaceRecord = Schema.Struct({
    workspaceId: WorkspaceId,
    name: WorkspaceText,
    checkoutPath: Schema.NullOr(WorkspaceText),
    isLinkedWorktree: Schema.Boolean,
});
export type WorkspaceRecord = Schema.Schema.Type<typeof WorkspaceRecord>;

export const WorkspaceSnapshot = Schema.Struct({
    focusedWorkspaceId: Schema.NullOr(WorkspaceId),
    workspaces: Schema.Array(WorkspaceRecord),
});
export type WorkspaceSnapshot = Schema.Schema.Type<typeof WorkspaceSnapshot>;

export const WorkspaceProject = Schema.Struct({
    workspaceId: WorkspaceId,
    name: WorkspaceText,
    cwd: WorkspaceText,
    gitRoot: WorkspaceText,
    source: Schema.Literal("worktree", "plugin"),
    isLinkedWorktree: Schema.Boolean,
});
export type WorkspaceProject = Schema.Schema.Type<typeof WorkspaceProject>;

export const WorkspaceCwdHint = Schema.Struct({
    workspaceId: WorkspaceId,
    cwd: WorkspaceText,
});
export type WorkspaceCwdHint = Schema.Schema.Type<typeof WorkspaceCwdHint>;
