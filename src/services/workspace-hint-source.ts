import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { WorkspaceCwdHint } from "../domain/workspace.ts";

export interface WorkspaceHintSourceService {
    readonly hints: Stream.Stream<WorkspaceCwdHint>;
}

export class WorkspaceHintSource extends Context.Tag("zed-herdr/WorkspaceHintSource")<
    WorkspaceHintSource,
    WorkspaceHintSourceService
>() {
    static readonly empty = Layer.succeed(this, {
        hints: Stream.empty,
    });
}
