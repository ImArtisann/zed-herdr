import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { EditorAdapterError } from "../domain/errors.ts";

export interface EditorAdapterService {
    readonly ensureProject: (path: string) => Effect.Effect<void, EditorAdapterError>;
    readonly focusProject: (path: string) => Effect.Effect<void, EditorAdapterError>;
}

export class EditorAdapter extends Context.Tag("zed-herdr/EditorAdapter")<
    EditorAdapter,
    EditorAdapterService
>() {}
