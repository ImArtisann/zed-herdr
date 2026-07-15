import * as Schema from "effect/Schema";

import { WorkspaceGeneration, WorkspaceId } from "./workspace.ts";

const ErrorText = Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(4_096));
const ErrorPath = Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(4_096));
const ErrorExitCode = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

export class WorkspaceResolutionError extends Schema.TaggedError<WorkspaceResolutionError>(
    "WorkspaceResolutionError",
)("WorkspaceResolutionError", {
    workspaceId: Schema.NullOr(WorkspaceId),
    workspace: ErrorText,
    path: Schema.NullOr(ErrorPath),
    operation: Schema.Literal("resolve_checkout_path", "resolve_cwd_hint", "stat", "git_root"),
    reason: Schema.Literal(
        "missing_path",
        "ambiguous_path",
        "inaccessible_path",
        "not_directory",
        "not_git_repository",
    ),
}) {}

export class StaleWorkspaceGeneration extends Schema.TaggedError<StaleWorkspaceGeneration>(
    "StaleWorkspaceGeneration",
)("StaleWorkspaceGeneration", {
    generation: WorkspaceGeneration,
}) {}

export class WorkspaceSourceTransportError extends Schema.TaggedError<WorkspaceSourceTransportError>(
    "WorkspaceSourceTransportError",
)("WorkspaceSourceTransportError", {
    operation: Schema.Literal("connect", "request", "subscribe", "read"),
    message: ErrorText,
}) {}

export class WorkspaceSourceProtocolError extends Schema.TaggedError<WorkspaceSourceProtocolError>(
    "WorkspaceSourceProtocolError",
)("WorkspaceSourceProtocolError", {
    operation: Schema.Literal("decode", "response", "subscription"),
    message: ErrorText,
}) {}

export class UnsupportedHerdRProtocol extends Schema.TaggedError<UnsupportedHerdRProtocol>(
    "UnsupportedHerdRProtocol",
)("UnsupportedHerdRProtocol", {
    expected: Schema.Literal(16),
    actual: ErrorExitCode,
}) {}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>(
    "ConfigurationError",
)("ConfigurationError", {
    key: ErrorText,
    message: ErrorText,
}) {}

export class EditorAdapterError extends Schema.TaggedError<EditorAdapterError>(
    "EditorAdapterError",
)("EditorAdapterError", {
    operation: Schema.Literal("ensure_project", "focus_project"),
    path: ErrorPath,
    exitCode: Schema.NullOr(ErrorExitCode),
    stderr: Schema.String.pipe(Schema.maxLength(4_096)),
    message: ErrorText,
}) {}

export const WorkspaceSourceError = Schema.Union(
    StaleWorkspaceGeneration,
    WorkspaceSourceTransportError,
    WorkspaceSourceProtocolError,
    UnsupportedHerdRProtocol,
);
export type WorkspaceSourceError = Schema.Schema.Type<typeof WorkspaceSourceError>;
