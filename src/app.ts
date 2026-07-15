import * as BunContext from "@effect/platform-bun/BunContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Runtime from "effect/Runtime";
import * as Stream from "effect/Stream";

import type { AppConfig } from "./config.ts";
import type { WorkspaceCwdHint } from "./domain/workspace.ts";
import { makeZedEditorAdapterLayer } from "./editor/zed.ts";
import { HerdRClientLive } from "./herdr/client.ts";
import { HerdRWorkspaceSourceLive } from "./herdr/workspace-source.ts";
import { controlSocketPath, startControlServer } from "./plugin/control.ts";
import type { HookNotification } from "./plugin/protocol.ts";
import { WorkspaceHintSource } from "./services/workspace-hint-source.ts";
import { makeSyncDaemon } from "./sync/daemon.ts";

const CONTROL_NOTIFICATION_QUEUE_CAPACITY = 256;

const makeWorkspaceHintSourceLive = (hints: Stream.Stream<WorkspaceCwdHint>) =>
    Layer.succeed(WorkspaceHintSource, { hints });

const JsonLoggerLive = Logger.json;
const HerdRSourceLive = HerdRWorkspaceSourceLive.pipe(
    Layer.provide(HerdRClientLive.pipe(Layer.provide(JsonLoggerLive))),
);

export const makeAppLayer = (
    config: AppConfig,
    hints: Stream.Stream<WorkspaceCwdHint> = Stream.empty,
) =>
    Layer.mergeAll(
        BunContext.layer,
        HerdRSourceLive,
        makeZedEditorAdapterLayer({ executable: config.zedBin }).pipe(
            Layer.provide(BunContext.layer),
        ),
        makeWorkspaceHintSourceLive(hints),
    ).pipe(Layer.provideMerge(JsonLoggerLive));

export const runDaemon = (config: AppConfig, environment: NodeJS.ProcessEnv = process.env) =>
    Effect.scoped(
        Effect.gen(function* () {
            const notifications = yield* Queue.bounded<HookNotification>(
                CONTROL_NOTIFICATION_QUEUE_CAPACITY,
            );
            yield* Effect.addFinalizer(() => Queue.shutdown(notifications));
            const runtime = yield* Effect.runtime<never>();
            const paneId = environment.HERDR_PANE_ID?.trim() || null;
            yield* Effect.acquireRelease(
                Effect.tryPromise({
                    try: () =>
                        startControlServer({
                            path: controlSocketPath(environment),
                            paneId,
                            notifications: {
                                publish: (notification) =>
                                    Runtime.runPromise(runtime)(
                                        Queue.offer(notifications, notification).pipe(
                                            Effect.asVoid,
                                        ),
                                    ),
                            },
                        }),
                    catch: (cause) => cause,
                }),
                (server) =>
                    Effect.promise(() => server.close()).pipe(Effect.catchAllCause(Effect.die)),
            );

            return yield* makeSyncDaemon.pipe(
                Effect.flatMap((daemon) => daemon.run),
                Effect.provide(makeAppLayer(config, Stream.fromQueue(notifications))),
            );
        }),
    ).pipe(Effect.provide(JsonLoggerLive));
