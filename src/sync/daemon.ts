import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { FileSystem } from "@effect/platform/FileSystem";
import type { Path } from "@effect/platform/Path";
import * as Chunk from "effect/Chunk";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { StaleWorkspaceGeneration } from "../domain/errors.ts";
import type {
    WorkspaceCwdHint,
    WorkspaceGeneration,
    WorkspaceId,
    WorkspaceProject,
    WorkspaceRecord,
    WorkspaceSnapshot,
    WorkspaceSourceEvent,
} from "../domain/workspace.ts";
import { EditorAdapter } from "../services/editor-adapter.ts";
import { WorkspaceHintSource } from "../services/workspace-hint-source.ts";
import { WorkspaceSource } from "../services/workspace-source.ts";
import { resolveProject } from "./resolve-project.ts";

export interface SuccessfulWorkspaceProject {
    readonly workspaceId: WorkspaceId;
    readonly gitRoot: string;
}

export interface SyncCache {
    readonly latestLiveGeneration: WorkspaceGeneration | null;
    readonly snapshot: WorkspaceSnapshot | null;
    readonly cwdHints: ReadonlyMap<WorkspaceId, string>;
    readonly projects: ReadonlyMap<WorkspaceId, WorkspaceProject>;
    readonly ensuredGitRoots: ReadonlySet<string>;
    readonly lastSuccessful: SuccessfulWorkspaceProject | null;
    readonly lastSynchronizedAt: number | null;
}

export const makeEmptySyncCache = (): SyncCache => ({
    latestLiveGeneration: null,
    snapshot: null,
    cwdHints: new Map(),
    projects: new Map(),
    ensuredGitRoots: new Set(),
    lastSuccessful: null,
    lastSynchronizedAt: null,
});

interface RefreshTrigger {
    readonly generation: WorkspaceGeneration;
    readonly ingressAt: bigint;
    readonly cancelled: Deferred.Deferred<void>;
}

type Ingress =
    | { readonly _tag: "SourceEvent"; readonly event: WorkspaceSourceEvent }
    | { readonly _tag: "CwdHint"; readonly hint: WorkspaceCwdHint };

interface LogFields {
    readonly workspaceId?: WorkspaceId;
    readonly workspace?: string;
    readonly path?: string;
    readonly operation: string;
    readonly elapsedMs: number;
    readonly cause?: unknown;
}

const boundedCause = (cause: unknown): string => {
    const rendered = cause instanceof Error ? cause.message : String(cause);
    return rendered.length <= 4_096 ? rendered : rendered.slice(rendered.length - 4_096);
};

const elapsedMillis = (ingressAt: bigint, completedAt: bigint): number =>
    Number(completedAt - ingressAt) / 1_000_000;

const logSync = (level: "info" | "warning" | "error", message: string, fields: LogFields) => {
    const annotations = {
        workspace_id: fields.workspaceId ?? "",
        workspace: fields.workspace ?? "",
        path: fields.path ?? "",
        operation: fields.operation,
        elapsed_ms: fields.elapsedMs,
        cause: fields.cause === undefined ? "" : boundedCause(fields.cause),
    };
    const effect =
        level === "error"
            ? Effect.logError(message)
            : level === "warning"
              ? Effect.logWarning(message)
              : Effect.logInfo(message);
    return effect.pipe(Effect.annotateLogs(annotations));
};

const sameSuccessfulProject = (
    left: SuccessfulWorkspaceProject | null,
    right: SuccessfulWorkspaceProject,
): boolean =>
    left !== null && left.workspaceId === right.workspaceId && left.gitRoot === right.gitRoot;

const gateGeneration = (
    cache: Ref.Ref<SyncCache>,
    generation: WorkspaceGeneration,
): Effect.Effect<void, StaleWorkspaceGeneration> =>
    Ref.get(cache).pipe(
        Effect.flatMap((state) =>
            state.latestLiveGeneration === generation
                ? Effect.void
                : Effect.fail(new StaleWorkspaceGeneration({ generation })),
        ),
    );

const installSnapshot = (
    cache: Ref.Ref<SyncCache>,
    generation: WorkspaceGeneration,
    snapshot: WorkspaceSnapshot,
    projects: ReadonlyMap<WorkspaceId, WorkspaceProject>,
): Effect.Effect<SyncCache, StaleWorkspaceGeneration> =>
    Ref.modify(cache, (state) => {
        if (state.latestLiveGeneration !== generation) {
            return [null, state] as const;
        }

        const presentIds = new Set(snapshot.workspaces.map((workspace) => workspace.workspaceId));
        const cwdHints = new Map(
            [...state.cwdHints].filter(([workspaceId]) => presentIds.has(workspaceId)),
        );
        const next: SyncCache = {
            ...state,
            snapshot,
            cwdHints,
            projects,
        };
        return [next, next] as const;
    }).pipe(
        Effect.flatMap((installed) =>
            installed === null
                ? Effect.fail(new StaleWorkspaceGeneration({ generation }))
                : Effect.succeed(installed),
        ),
    );

const resolveSnapshotProjects = (
    snapshot: WorkspaceSnapshot,
    cwdHints: ReadonlyMap<WorkspaceId, string>,
    ingressAt: bigint,
) =>
    Effect.gen(function* () {
        const projects = new Map<WorkspaceId, WorkspaceProject>();
        for (const workspace of snapshot.workspaces) {
            const result = yield* Effect.either(resolveProject(workspace, cwdHints));
            if (result._tag === "Left") {
                const now = yield* Clock.currentTimeNanos;
                yield* logSync("warning", "workspace_sync_skipped", {
                    workspaceId: workspace.workspaceId,
                    workspace: workspace.name,
                    path: result.left.path ?? undefined,
                    operation: result.left.operation,
                    elapsedMs: elapsedMillis(ingressAt, now),
                    cause: result.left.reason,
                });
                continue;
            }
            projects.set(workspace.workspaceId, result.right);
        }
        return projects;
    });

const uniqueProjects = (
    snapshot: WorkspaceSnapshot,
    projects: ReadonlyMap<WorkspaceId, WorkspaceProject>,
): ReadonlyArray<WorkspaceProject> => {
    const unique = new Map<string, WorkspaceProject>();
    for (const workspace of snapshot.workspaces) {
        const project = projects.get(workspace.workspaceId);
        if (project !== undefined && !unique.has(project.gitRoot)) {
            unique.set(project.gitRoot, project);
        }
    }
    return [...unique.values()];
};

const findWorkspace = (
    snapshot: WorkspaceSnapshot,
    workspaceId: WorkspaceId,
): WorkspaceRecord | undefined =>
    snapshot.workspaces.find((workspace) => workspace.workspaceId === workspaceId);

export interface SyncDaemon {
    readonly cache: Ref.Ref<SyncCache>;
    readonly run: Effect.Effect<never, unknown, Scope.Scope | FileSystem | Path | CommandExecutor>;
}

export const makeSyncDaemon = Effect.gen(function* () {
    const source = yield* WorkspaceSource;
    const hintSource = yield* WorkspaceHintSource;
    const adapter = yield* EditorAdapter;
    const cache = yield* Ref.make(makeEmptySyncCache());
    const triggers = yield* Queue.unbounded<RefreshTrigger>();
    const cancellations = new Map<WorkspaceGeneration, Deferred.Deferred<void>>();

    const refresh = (trigger: RefreshTrigger) =>
        Effect.gen(function* () {
            yield* gateGeneration(cache, trigger.generation);
            yield* logSync("info", "workspace_sync_started", {
                operation: "snapshot",
                elapsedMs: elapsedMillis(trigger.ingressAt, yield* Clock.currentTimeNanos),
            });

            const snapshot = yield* source.snapshot(trigger.generation);
            yield* gateGeneration(cache, trigger.generation);
            const previous = yield* Ref.get(cache);
            const projects = yield* resolveSnapshotProjects(
                snapshot,
                previous.cwdHints,
                trigger.ingressAt,
            );
            yield* gateGeneration(cache, trigger.generation);
            const installed = yield* installSnapshot(cache, trigger.generation, snapshot, projects);
            for (const project of uniqueProjects(snapshot, projects)) {
                if (installed.ensuredGitRoots.has(project.gitRoot)) {
                    continue;
                }

                yield* gateGeneration(cache, trigger.generation);
                const result = yield* Effect.either(adapter.ensureProject(project.gitRoot));
                const now = yield* Clock.currentTimeNanos;
                if (result._tag === "Left") {
                    yield* logSync("error", "workspace_sync_failed", {
                        workspaceId: project.workspaceId,
                        workspace: project.name,
                        path: project.gitRoot,
                        operation: "ensure_project",
                        elapsedMs: elapsedMillis(trigger.ingressAt, now),
                        cause: result.left,
                    });
                    continue;
                }

                const recorded = yield* Ref.modify(cache, (state) => {
                    if (state.latestLiveGeneration !== trigger.generation) {
                        return [false, state] as const;
                    }
                    const ensuredGitRoots = new Set(state.ensuredGitRoots);
                    ensuredGitRoots.add(project.gitRoot);
                    return [
                        true,
                        {
                            ...state,
                            ensuredGitRoots,
                            lastSynchronizedAt: Number(now) / 1_000_000,
                        },
                    ] as const;
                });
                if (recorded) {
                    yield* logSync("info", "workspace_sync_succeeded", {
                        workspaceId: project.workspaceId,
                        workspace: project.name,
                        path: project.gitRoot,
                        operation: "ensure_project",
                        elapsedMs: elapsedMillis(trigger.ingressAt, now),
                    });
                }
            }

            const focusedId = snapshot.focusedWorkspaceId;
            if (focusedId === null) {
                return;
            }
            const project = projects.get(focusedId);
            const workspace = findWorkspace(snapshot, focusedId);
            if (project === undefined || workspace === undefined) {
                return;
            }
            const successful = {
                workspaceId: focusedId,
                gitRoot: project.gitRoot,
            } satisfies SuccessfulWorkspaceProject;
            if (sameSuccessfulProject(installed.lastSuccessful, successful)) {
                return;
            }

            yield* gateGeneration(cache, trigger.generation);
            const result = yield* Effect.either(adapter.focusProject(project.gitRoot));
            const now = yield* Clock.currentTimeNanos;
            if (result._tag === "Left") {
                yield* logSync("error", "workspace_sync_failed", {
                    workspaceId: workspace.workspaceId,
                    workspace: workspace.name,
                    path: project.gitRoot,
                    operation: "focus_project",
                    elapsedMs: elapsedMillis(trigger.ingressAt, now),
                    cause: result.left,
                });
                return;
            }

            const recorded = yield* Ref.modify(cache, (state) =>
                state.latestLiveGeneration === trigger.generation
                    ? [
                          true,
                          {
                              ...state,
                              lastSuccessful: successful,
                              lastSynchronizedAt: Number(now) / 1_000_000,
                          },
                      ]
                    : [false, state],
            );
            if (recorded) {
                yield* logSync("info", "workspace_sync_succeeded", {
                    workspaceId: workspace.workspaceId,
                    workspace: workspace.name,
                    path: project.gitRoot,
                    operation: "focus_project",
                    elapsedMs: elapsedMillis(trigger.ingressAt, now),
                });
            }
        }).pipe(
            Effect.catchTag("StaleWorkspaceGeneration", () => Effect.void),
            Effect.catchAllCause((cause) =>
                Clock.currentTimeNanos.pipe(
                    Effect.flatMap((now) =>
                        logSync("error", "workspace_sync_failed", {
                            operation: "snapshot",
                            elapsedMs: elapsedMillis(trigger.ingressAt, now),
                            cause,
                        }),
                    ),
                ),
            ),
        );

    const worker = Effect.forever(
        Effect.gen(function* () {
            const first = yield* Queue.take(triggers);
            yield* Clock.sleep("50 millis");
            const queued = yield* Queue.takeAll(triggers);
            const burst = [first, ...Chunk.toReadonlyArray(queued)];
            const state = yield* Ref.get(cache);
            const liveGeneration = state.latestLiveGeneration;
            if (liveGeneration === null) {
                return;
            }
            const matching = burst.filter((trigger) => trigger.generation === liveGeneration);
            if (matching.length === 0) {
                return;
            }
            const trigger = matching.reduce((earliest, candidate) =>
                candidate.ingressAt < earliest.ingressAt ? candidate : earliest,
            );
            const cancelled = Deferred.await(trigger.cancelled).pipe(
                Effect.flatMap(() =>
                    Effect.fail(new StaleWorkspaceGeneration({ generation: trigger.generation })),
                ),
            );
            yield* Effect.raceFirst(refresh(trigger), cancelled).pipe(
                Effect.catchTag("StaleWorkspaceGeneration", () => Effect.void),
            );
        }),
    );

    const removeQueuedGeneration = (generation: WorkspaceGeneration) =>
        Effect.gen(function* () {
            const queued = yield* Queue.takeAll(triggers);
            yield* Effect.forEach(queued, (trigger) =>
                trigger.generation === generation ? Effect.void : Queue.offer(triggers, trigger),
            );
        });

    const onSourceEvent = (event: WorkspaceSourceEvent) =>
        Effect.gen(function* () {
            if (event._tag === "Disconnected") {
                const cancelled = cancellations.get(event.generation);
                if (cancelled !== undefined) {
                    yield* Deferred.succeed(cancelled, undefined);
                    cancellations.delete(event.generation);
                }
                yield* Ref.update(cache, (state) =>
                    state.latestLiveGeneration === event.generation
                        ? { ...state, latestLiveGeneration: null }
                        : state,
                );
                yield* removeQueuedGeneration(event.generation);
                return;
            }

            const current = yield* Ref.get(cache);
            if (
                current.latestLiveGeneration !== null &&
                event.generation < current.latestLiveGeneration
            ) {
                return;
            }
            if (
                current.latestLiveGeneration !== null &&
                event.generation > current.latestLiveGeneration
            ) {
                for (const [generation, cancelled] of cancellations) {
                    if (generation < event.generation) {
                        yield* Deferred.succeed(cancelled, undefined);
                        cancellations.delete(generation);
                    }
                }
            }

            let cancelled = cancellations.get(event.generation);
            if (cancelled === undefined) {
                cancelled = yield* Deferred.make<void>();
                cancellations.set(event.generation, cancelled);
            }
            yield* Ref.update(cache, (state) => {
                const generationChanged = state.latestLiveGeneration !== event.generation;
                return {
                    ...state,
                    latestLiveGeneration: event.generation,
                    ensuredGitRoots: generationChanged
                        ? new Set<string>()
                        : state.ensuredGitRoots,
                    lastSuccessful: generationChanged ? null : state.lastSuccessful,
                };
            });
            yield* Queue.offer(triggers, {
                generation: event.generation,
                ingressAt: yield* Clock.currentTimeNanos,
                cancelled,
            });
        });

    const onHint = (hint: WorkspaceCwdHint) =>
        Effect.gen(function* () {
            const state = yield* Ref.modify(cache, (current) => {
                const cwdHints = new Map(current.cwdHints);
                cwdHints.set(hint.workspaceId, hint.cwd);
                const next = { ...current, cwdHints };
                return [next, next] as const;
            });
            const generation = state.latestLiveGeneration;
            if (generation === null) {
                return;
            }
            const cancelled = cancellations.get(generation);
            if (cancelled === undefined) {
                return;
            }
            yield* Queue.offer(triggers, {
                generation,
                ingressAt: yield* Clock.currentTimeNanos,
                cancelled,
            });
        });

    const ingress = Stream.merge(
        source.events.pipe(Stream.map((event): Ingress => ({ _tag: "SourceEvent", event }))),
        hintSource.hints.pipe(Stream.map((hint): Ingress => ({ _tag: "CwdHint", hint }))),
    );
    const collector = Stream.runForEach(ingress, (item) =>
        item._tag === "SourceEvent" ? onSourceEvent(item.event) : onHint(item.hint),
    ).pipe(Effect.zipRight(Effect.never));

    const run = Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Queue.shutdown(triggers));
        const collectorFiber = yield* Effect.forkScoped(collector);
        const workerFiber = yield* Effect.forkScoped(worker);
        return yield* Effect.raceFirst(Fiber.join(collectorFiber), Fiber.join(workerFiber));
    });

    return { cache, run } satisfies SyncDaemon;
});
