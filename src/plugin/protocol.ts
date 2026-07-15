import * as Schema from "effect/Schema";

import { WorkspaceCwdHint } from "../domain/workspace.ts";

const ControlText = Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(4_096));
const IsoTimestamp = Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(64));
const ProcessId = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

/** A workspace directory hint emitted by the lightweight HerdR plugin hook. */
export const HookNotification = WorkspaceCwdHint;
export type HookNotification = Schema.Schema.Type<typeof HookNotification>;

/** Tolerant inbound control request schemas. Unknown properties are discarded. */
export const NotifyControlRequest = Schema.Struct({
    type: Schema.Literal("notify"),
    notification: HookNotification,
});
export type NotifyControlRequest = Schema.Schema.Type<typeof NotifyControlRequest>;

export const HealthControlRequest = Schema.Struct({
    type: Schema.Literal("health"),
});
export type HealthControlRequest = Schema.Schema.Type<typeof HealthControlRequest>;

export const ControlRequest = Schema.Union(NotifyControlRequest, HealthControlRequest);
export type ControlRequest = Schema.Schema.Type<typeof ControlRequest>;

export const DaemonIdentity = Schema.Literal("dev.zed-herdr:daemon");
export type DaemonIdentity = Schema.Schema.Type<typeof DaemonIdentity>;

/** The daemon-owned fields reported to a local health client. */
export const DaemonHealth = Schema.Struct({
    identity: DaemonIdentity,
    paneId: Schema.NullOr(ControlText),
    pid: ProcessId,
    startedAt: IsoTimestamp,
});
export type DaemonHealth = Schema.Schema.Type<typeof DaemonHealth>;

/** Exact success wire responses. */
export const NotifyControlResponse = Schema.Struct({
    ok: Schema.Literal(true),
});
export type NotifyControlResponse = Schema.Schema.Type<typeof NotifyControlResponse>;

export const HealthControlResponse = Schema.Struct({
    ok: Schema.Literal(true),
    daemon: DaemonHealth,
});
export type HealthControlResponse = Schema.Schema.Type<typeof HealthControlResponse>;

/** Exact failure wire response: client input failures or server publish failure. */
export const ControlFailureResponse = Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Literal("invalid_request", "payload_too_large", "server_failure"),
});
export type ControlFailureResponse = Schema.Schema.Type<typeof ControlFailureResponse>;

export const ControlResponse = Schema.Union(
    HealthControlResponse,
    NotifyControlResponse,
    ControlFailureResponse,
);
export type ControlResponse = Schema.Schema.Type<typeof ControlResponse>;
