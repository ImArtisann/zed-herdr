import * as BunContext from "@effect/platform-bun/BunContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";

import type { AppConfig } from "./config.ts";
import { makeZedEditorAdapterLayer } from "./editor/zed.ts";
import { HerdRClientLive } from "./herdr/client.ts";
import { HerdRWorkspaceSourceLive } from "./herdr/workspace-source.ts";
import { WorkspaceHintSource } from "./services/workspace-hint-source.ts";
import { makeSyncDaemon } from "./sync/daemon.ts";

const WorkspaceHintSourceLive = Layer.succeed(WorkspaceHintSource, {
    hints: Stream.empty,
});

const JsonLoggerLive = Logger.json;
const HerdRSourceLive = HerdRWorkspaceSourceLive.pipe(
    Layer.provide(HerdRClientLive.pipe(Layer.provide(JsonLoggerLive))),
);

export const makeAppLayer = (config: AppConfig) =>
    Layer.mergeAll(
        BunContext.layer,
        HerdRSourceLive,
        makeZedEditorAdapterLayer({ executable: config.zedBin }).pipe(
            Layer.provide(BunContext.layer),
        ),
        WorkspaceHintSourceLive,
    ).pipe(Layer.provideMerge(JsonLoggerLive));

export const runDaemon = (config: AppConfig) =>
    Effect.scoped(
        makeSyncDaemon.pipe(
            Effect.flatMap((daemon) => daemon.run),
            Effect.provide(makeAppLayer(config)),
        ),
    ).pipe(Effect.provide(JsonLoggerLive));
