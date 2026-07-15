import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { WorkspaceSourceError } from "../domain/errors.ts";
import type {
    WorkspaceGeneration,
    WorkspaceSnapshot,
    WorkspaceSourceEvent,
} from "../domain/workspace.ts";

export interface WorkspaceSourceService {
    readonly snapshot: (
        generation: WorkspaceGeneration,
    ) => Effect.Effect<WorkspaceSnapshot, WorkspaceSourceError>;
    readonly events: Stream.Stream<WorkspaceSourceEvent, WorkspaceSourceError>;
}

export class WorkspaceSource extends Context.Tag("zed-herdr/WorkspaceSource")<
    WorkspaceSource,
    WorkspaceSourceService
>() {}
