import { expect, test } from "bun:test";
import * as BunContext from "@effect/platform-bun/BunContext";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/TestClock";
import * as TestContext from "effect/TestContext";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EditorAdapterService } from "../../src/services/editor-adapter.ts";
import type { WorkspaceHintSourceService } from "../../src/services/workspace-hint-source.ts";
import type { WorkspaceSourceService } from "../../src/services/workspace-source.ts";
import type {
    WorkspaceCwdHint,
    WorkspaceGeneration,
    WorkspaceId,
    WorkspaceRecord,
    WorkspaceSnapshot,
} from "../../src/domain/workspace.ts";
import type { EditorAdapterError } from "../../src/domain/errors.ts";
import type { SyncDaemon } from "../../src/sync/daemon.ts";
import { EditorAdapterError as EditorAdapterErrorValue } from "../../src/domain/errors.ts";
import { EditorAdapter } from "../../src/services/editor-adapter.ts";
import { WorkspaceHintSource } from "../../src/services/workspace-hint-source.ts";
import { WorkspaceSource } from "../../src/services/workspace-source.ts";
import { makeSyncDaemon } from "../../src/sync/daemon.ts";

interface CapturedLog {
    readonly message: string;
    readonly annotations: Readonly<Record<string, string>>;
}

interface AdapterBehavior {
    readonly ensureProject?: (path: string) => Effect.Effect<void, EditorAdapterError>;
    readonly focusProject?: (path: string) => Effect.Effect<void, EditorAdapterError>;
}

interface DaemonHarness {
    readonly calls: Array<string>;
    readonly callEvents: Queue.Queue<string>;
    readonly daemon: SyncDaemon;
    readonly events: Queue.Queue<{
        readonly _tag: "Invalidated" | "Disconnected";
        readonly generation: WorkspaceGeneration;
    }>;
    readonly hints: Queue.Queue<WorkspaceCwdHint>;
    readonly logEvents: Queue.Queue<CapturedLog>;
    readonly logs: Array<CapturedLog>;
    readonly snapshotCalls: Array<number>;
    readonly snapshotEvents: Queue.Queue<number>;
    readonly snapshots: Map<number, Array<Effect.Effect<WorkspaceSnapshot>>>;
}

const workspaceId = (value: string): WorkspaceId => value as WorkspaceId;
const generation = (value: number): WorkspaceGeneration => value as WorkspaceGeneration;

const workspace = (
    id: string,
    checkoutPath: string | null,
    options: { readonly name?: string; readonly isLinkedWorktree?: boolean } = {},
): WorkspaceRecord => ({
    workspaceId: workspaceId(id),
    name: options.name ?? id,
    checkoutPath,
    isLinkedWorktree: options.isLinkedWorktree ?? false,
});

const snapshot = (
    focusedWorkspaceId: string | null,
    workspaces: ReadonlyArray<WorkspaceRecord>,
): WorkspaceSnapshot => ({
    focusedWorkspaceId: focusedWorkspaceId === null ? null : workspaceId(focusedWorkspaceId),
    workspaces,
});

const hint = (id: string, cwd: string): WorkspaceCwdHint => ({
    workspaceId: workspaceId(id),
    cwd,
});

const adapterError = (
    operation: "ensure_project" | "focus_project",
    path: string,
): EditorAdapterError =>
    new EditorAdapterErrorValue({
        operation,
        path,
        exitCode: null,
        stderr: "",
        message: `${operation}:${path}`,
    });

const settle: Effect.Effect<void> = Effect.forEach([0, 1, 2, 3], () => Effect.yieldNow());

const advanceDebounce: Effect.Effect<void> = TestClock.adjust("50 millis").pipe(
    Effect.zipRight(settle),
);

const makeHarness = (
    behavior: AdapterBehavior = {},
): Effect.Effect<DaemonHarness, never, Scope.Scope> =>
    Effect.gen(function* () {
        const events = yield* Queue.unbounded<{
            readonly _tag: "Invalidated" | "Disconnected";
            readonly generation: WorkspaceGeneration;
        }>();
        const hints = yield* Queue.unbounded<WorkspaceCwdHint>();
        const calls: Array<string> = [];
        const callEvents = yield* Queue.unbounded<string>();
        const logs: Array<CapturedLog> = [];
        const logEvents = yield* Queue.unbounded<CapturedLog>();
        const snapshotCalls: Array<number> = [];
        const snapshotEvents = yield* Queue.unbounded<number>();
        const snapshots = new Map<number, Array<Effect.Effect<WorkspaceSnapshot>>>();
        const logger = Logger.make((entry) => {
            const captured = {
                message: String(entry.message),
                annotations: Object.fromEntries(
                    HashMap.toEntries(entry.annotations).map(([key, value]) => [
                        key,
                        String(value),
                    ]),
                ),
            };
            logs.push(captured);
            logEvents.unsafeOffer(captured);
        });
        const source: WorkspaceSourceService = {
            events: Stream.fromQueue(events),
            snapshot: (currentGeneration) =>
                Effect.sync(() => snapshotCalls.push(Number(currentGeneration))).pipe(
                    Effect.zipRight(Queue.offer(snapshotEvents, Number(currentGeneration))),
                    Effect.zipRight(
                        Effect.suspend(() => {
                            const next = snapshots.get(Number(currentGeneration))?.shift();
                            return (
                                next ??
                                Effect.die(
                                    `unexpected snapshot for generation ${currentGeneration}`,
                                )
                            );
                        }),
                    ),
                ),
        };
        const hintSource: WorkspaceHintSourceService = {
            hints: Stream.fromQueue(hints),
        };
        const adapter: EditorAdapterService = {
            ensureProject: (path) =>
                Effect.sync(() => calls.push(`ensure:${path}`)).pipe(
                    Effect.zipRight(Queue.offer(callEvents, `ensure:${path}`)),
                    Effect.zipRight(behavior.ensureProject?.(path) ?? Effect.void),
                ),
            focusProject: (path) =>
                Effect.sync(() => calls.push(`focus:${path}`)).pipe(
                    Effect.zipRight(Queue.offer(callEvents, `focus:${path}`)),
                    Effect.zipRight(behavior.focusProject?.(path) ?? Effect.void),
                ),
        };
        const services = Layer.mergeAll(
            BunContext.layer,
            Logger.replace(Logger.defaultLogger, logger),
        );
        const daemon = yield* makeSyncDaemon.pipe(
            Effect.provideService(WorkspaceSource, source),
            Effect.provideService(WorkspaceHintSource, hintSource),
            Effect.provideService(EditorAdapter, adapter),
            Effect.provide(services),
        );
        yield* daemon.run.pipe(Effect.provide(services), Effect.forkScoped);
        return {
            calls,
            callEvents,
            daemon,
            events,
            hints,
            logEvents,
            logs,
            snapshotCalls,
            snapshotEvents,
            snapshots,
        } satisfies DaemonHarness;
    });

const withDaemon = <A>(
    body: (harness: DaemonHarness) => Effect.Effect<A>,
    behavior: AdapterBehavior = {},
): Promise<A> =>
    Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const harness = yield* makeHarness(behavior);
                return yield* body(harness);
            }),
        ).pipe(Effect.provide(TestContext.TestContext)),
    );

const emitInvalidated = (harness: DaemonHarness, value: number): Effect.Effect<void> =>
    Queue.offer(harness.events, { _tag: "Invalidated", generation: generation(value) }).pipe(
        Effect.zipRight(settle),
    );

const emitDisconnected = (harness: DaemonHarness, value: number): Effect.Effect<void> =>
    Queue.offer(harness.events, { _tag: "Disconnected", generation: generation(value) }).pipe(
        Effect.zipRight(settle),
    );

const emitHint = (harness: DaemonHarness, id: string, cwd: string): Effect.Effect<void> =>
    Queue.offer(harness.hints, hint(id, cwd)).pipe(Effect.zipRight(settle));

const queueSnapshot = (
    harness: DaemonHarness,
    value: number,
    valueSnapshot: WorkspaceSnapshot,
): void => {
    const queued = harness.snapshots.get(value) ?? [];
    queued.push(Effect.succeed(valueSnapshot));
    harness.snapshots.set(value, queued);
};

const lastLog = (harness: DaemonHarness, message: string): CapturedLog | undefined =>
    [...harness.logs].reverse().find((entry) => entry.message === message);

const run = (args: Array<string>): void => {
    const child = Bun.spawnSync(args);
    expect(child.exitCode).toBe(0);
};

const awaitSnapshot = (harness: DaemonHarness): Effect.Effect<void> =>
    Queue.take(harness.snapshotEvents).pipe(Effect.zipRight(settle));

const awaitCalls = (harness: DaemonHarness, count: number): Effect.Effect<void> =>
    Effect.forEach(Array.from({ length: count }), () => Queue.take(harness.callEvents)).pipe(
        Effect.zipRight(settle),
    );

const awaitLogs = (harness: DaemonHarness, count: number): Effect.Effect<void> =>
    Effect.forEach(Array.from({ length: count }), () => Queue.take(harness.logEvents)).pipe(
        Effect.zipRight(settle),
    );

const withTemporaryDirectory = async <A>(body: (directory: string) => Promise<A>): Promise<A> => {
    const directory = await mkdtemp(join(tmpdir(), "zed-herdr-daemon-test-"));
    try {
        return await body(await realpath(directory));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
};

const initializeRepository = async (directory: string): Promise<void> => {
    run(["git", "init", "--quiet", directory]);
    await writeFile(join(directory, "README"), "test\n");
    run(["git", "-C", directory, "add", "README"]);
    run([
        "git",
        "-C",
        directory,
        "-c",
        "user.name=daemon-test",
        "-c",
        "user.email=daemon-test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "initial",
    ]);
};

test("does not snapshot or call the editor before a live invalidation", async () => {
    await withDaemon((harness) =>
        TestClock.adjust("51 millis").pipe(
            Effect.zipRight(settle),
            Effect.zipRight(
                Effect.sync(() => {
                    expect(harness.snapshotCalls).toEqual([]);
                    expect(harness.calls).toEqual([]);
                }),
            ),
        ),
    );
});

test("uses the latest generation so S1 focused A cannot call the editor before S2 focused B", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repoA = join(directory, "repo-a");
        const repoB = join(directory, "repo-b");
        await initializeRepository(repoA);
        await initializeRepository(repoB);
        await withDaemon((harness) => {
            queueSnapshot(harness, 1, snapshot("a", [workspace("a", repoA)]));
            queueSnapshot(harness, 2, snapshot("b", [workspace("b", repoB)]));
            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(emitInvalidated(harness, 2)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.snapshotCalls).toEqual([2]);
                        expect(harness.calls).toEqual([`ensure:${repoB}`, `focus:${repoB}`]);
                        expect(harness.calls).not.toContain(`ensure:${repoA}`);
                        expect(harness.calls).not.toContain(`focus:${repoA}`);
                    }),
                ),
            );
        });
    });
});

test("on the first valid snapshot ensures each unique root then focuses the active workspace", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repoA = join(directory, "repo-a");
        const repoB = join(directory, "repo-b");
        const nestedA = join(repoA, "nested");
        await initializeRepository(repoA);
        await initializeRepository(repoB);
        await mkdir(nestedA);
        await withDaemon((harness) => {
            queueSnapshot(
                harness,
                1,
                snapshot("b", [
                    workspace("a", repoA),
                    workspace("same-root", nestedA),
                    workspace("b", repoB),
                ]),
            );
            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 3)),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.calls).toEqual([
                            `ensure:${repoA}`,
                            `ensure:${repoB}`,
                            `focus:${repoB}`,
                        ]);
                        const succeeded = lastLog(harness, "workspace_sync_succeeded");
                        expect(succeeded?.annotations).toMatchObject({
                            workspace_id: "b",
                            workspace: "b",
                            path: repoB,
                            operation: "focus_project",
                        });
                    }),
                ),
            );
        });
    });
});

test("installs an empty authoritative snapshot without calling the editor", async () => {
    await withDaemon((harness) => {
        queueSnapshot(harness, 1, snapshot(null, []));
        return emitInvalidated(harness, 1).pipe(
            Effect.zipRight(advanceDebounce),
            Effect.zipRight(awaitSnapshot(harness)),
            Effect.zipRight(settle),
            Effect.zipRight(Ref.get(harness.daemon.cache)),
            Effect.tap((cache) =>
                Effect.sync(() => {
                    expect(cache.snapshot).toEqual(snapshot(null, []));
                    expect(cache.projects.size).toBe(0);
                    expect(harness.calls).toEqual([]);
                }),
            ),
        );
    });
});

test("collapses a burst at 50 ms and reports elapsed time from the earliest ingress", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repo = join(directory, "repo");
        await initializeRepository(repo);
        await withDaemon((harness) => {
            queueSnapshot(harness, 1, snapshot("a", [workspace("a", repo)]));
            queueSnapshot(harness, 1, snapshot("a", [workspace("a", repo)]));
            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(TestClock.adjust("20 millis")),
                Effect.zipRight(emitInvalidated(harness, 1)),
                Effect.zipRight(TestClock.adjust("30 millis")),
                Effect.zipRight(settle),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.snapshotCalls).toEqual([1]);
                        const completed = lastLog(harness, "workspace_sync_succeeded");
                        expect(Number(completed?.annotations.elapsed_ms)).toBeGreaterThanOrEqual(
                            50,
                        );
                    }),
                ),
            );
        });
    });
});

test("serializes editor commands", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repoA = join(directory, "repo-a");
        const repoB = join(directory, "repo-b");
        await initializeRepository(repoA);
        await initializeRepository(repoB);
        let active = 0;
        let maximumActive = 0;
        const command = () =>
            Effect.acquireUseRelease(
                Effect.sync(() => {
                    active += 1;
                    maximumActive = Math.max(maximumActive, active);
                }),
                () => Effect.sleep("5 millis"),
                () =>
                    Effect.sync(() => {
                        active -= 1;
                    }),
            );
        await withDaemon(
            (harness) => {
                queueSnapshot(
                    harness,
                    1,
                    snapshot("b", [workspace("a", repoA), workspace("b", repoB)]),
                );
                return emitInvalidated(harness, 1).pipe(
                    Effect.zipRight(advanceDebounce),
                    Effect.zipRight(awaitSnapshot(harness)),
                    Effect.zipRight(awaitCalls(harness, 1)),
                    Effect.zipRight(TestClock.adjust("5 millis")),
                    Effect.zipRight(awaitCalls(harness, 1)),
                    Effect.zipRight(TestClock.adjust("5 millis")),
                    Effect.zipRight(awaitCalls(harness, 1)),
                    Effect.zipRight(TestClock.adjust("5 millis")),
                    Effect.zipRight(settle),
                    Effect.zipRight(
                        Effect.sync(() => {
                            expect(maximumActive).toBe(1);
                            expect(active).toBe(0);
                            expect(harness.calls).toEqual([
                                `ensure:${repoA}`,
                                `ensure:${repoB}`,
                                `focus:${repoB}`,
                            ]);
                        }),
                    ),
                );
            },
            { ensureProject: command, focusProject: command },
        );
    });
});

test("replaces cache state with each authoritative snapshot and prunes absent ids and hints", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repoA = join(directory, "repo-a");
        const repoB = join(directory, "repo-b");
        await initializeRepository(repoA);
        await initializeRepository(repoB);
        await withDaemon((harness) => {
            queueSnapshot(harness, 1, snapshot("a", [workspace("a", repoA)]));
            queueSnapshot(harness, 1, snapshot("b", [workspace("b", repoB)]));
            return emitHint(harness, "a", repoA).pipe(
                Effect.zipRight(emitInvalidated(harness, 1)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(emitInvalidated(harness, 1)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(Ref.get(harness.daemon.cache)),
                Effect.tap((cache) =>
                    Effect.sync(() => {
                        expect(cache.snapshot?.focusedWorkspaceId).toBe(workspaceId("b"));
                        expect([...cache.projects.keys()]).toEqual([workspaceId("b")]);
                        expect(cache.cwdHints.has(workspaceId("a"))).toBeFalse();
                        expect(harness.calls).toContain(`focus:${repoB}`);
                    }),
                ),
            );
        });
    });
});

test("deduplicates roots and retries a failed focus without caching the failure", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repo = join(directory, "repo");
        await initializeRepository(repo);
        let attempts = 0;
        await withDaemon(
            (harness) => {
                queueSnapshot(
                    harness,
                    1,
                    snapshot("a", [workspace("a", repo), workspace("duplicate", repo)]),
                );
                queueSnapshot(
                    harness,
                    1,
                    snapshot("a", [workspace("a", repo), workspace("duplicate", repo)]),
                );
                return emitInvalidated(harness, 1).pipe(
                    Effect.zipRight(advanceDebounce),
                    Effect.zipRight(awaitSnapshot(harness)),
                    Effect.zipRight(awaitCalls(harness, 2)),
                    Effect.zipRight(emitInvalidated(harness, 1)),
                    Effect.zipRight(advanceDebounce),
                    Effect.zipRight(awaitSnapshot(harness)),
                    Effect.zipRight(awaitCalls(harness, 1)),
                    Effect.zipRight(Ref.get(harness.daemon.cache)),
                    Effect.tap((cache) =>
                        Effect.sync(() => {
                            expect(
                                harness.calls.filter((call) => call === `ensure:${repo}`),
                            ).toHaveLength(1);
                            expect(
                                harness.calls.filter((call) => call === `focus:${repo}`),
                            ).toHaveLength(2);
                            expect(cache.lastSuccessful).toEqual({
                                workspaceId: workspaceId("a"),
                                gitRoot: repo,
                            });
                            const failed = lastLog(harness, "workspace_sync_failed");
                            expect(failed?.annotations).toMatchObject({
                                workspace_id: "a",
                                path: repo,
                                operation: "focus_project",
                            });
                        }),
                    ),
                );
            },
            {
                focusProject: (path) =>
                    Effect.suspend(() => {
                        attempts += 1;
                        return attempts === 1
                            ? Effect.fail(adapterError("focus_project", path))
                            : Effect.void;
                    }),
            },
        );
    });
});

test("keeps linked worktree roots independent", async () => {
    await withTemporaryDirectory(async (directory) => {
        const main = join(directory, "main");
        const linked = join(directory, "linked");
        await initializeRepository(main);
        run(["git", "-C", main, "worktree", "add", "--quiet", linked]);
        await withDaemon((harness) => {
            queueSnapshot(
                harness,
                1,
                snapshot("linked", [
                    workspace("main", main),
                    workspace("linked", linked, { isLinkedWorktree: true }),
                ]),
            );
            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 3)),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.calls).toEqual([
                            `ensure:${main}`,
                            `ensure:${linked}`,
                            `focus:${linked}`,
                        ]);
                    }),
                ),
            );
        });
    });
});

test("retries a failed ensure and records its root only after it succeeds", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repo = join(directory, "repo");
        await initializeRepository(repo);
        let attempts = 0;
        await withDaemon(
            (harness) => {
                queueSnapshot(harness, 1, snapshot(null, [workspace("a", repo)]));
                queueSnapshot(harness, 1, snapshot(null, [workspace("a", repo)]));
                return emitInvalidated(harness, 1).pipe(
                    Effect.zipRight(advanceDebounce),
                    Effect.zipRight(awaitSnapshot(harness)),
                    Effect.zipRight(awaitCalls(harness, 1)),
                    Effect.zipRight(Ref.get(harness.daemon.cache)),
                    Effect.tap((cache) =>
                        Effect.sync(() => {
                            expect(cache.ensuredGitRoots.has(repo)).toBeFalse();
                            expect(cache.lastSynchronizedAt).toBeNull();
                        }),
                    ),
                    Effect.zipRight(emitInvalidated(harness, 1)),
                    Effect.zipRight(advanceDebounce),
                    Effect.zipRight(awaitSnapshot(harness)),
                    Effect.zipRight(awaitCalls(harness, 1)),
                    Effect.zipRight(Ref.get(harness.daemon.cache)),
                    Effect.tap((cache) =>
                        Effect.sync(() => {
                            expect(harness.calls).toEqual([`ensure:${repo}`, `ensure:${repo}`]);
                            expect([...cache.ensuredGitRoots]).toEqual([repo]);
                            expect(cache.lastSynchronizedAt).not.toBeNull();
                        }),
                    ),
                );
            },
            {
                ensureProject: (path) =>
                    Effect.suspend(() => {
                        attempts += 1;
                        return attempts === 1
                            ? Effect.fail(adapterError("ensure_project", path))
                            : Effect.void;
                    }),
            },
        );
    });
});

test("ensures a root introduced by a later snapshot without repeating prior roots", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repoA = join(directory, "repo-a");
        const repoB = join(directory, "repo-b");
        await initializeRepository(repoA);
        await initializeRepository(repoB);
        await withDaemon((harness) => {
            queueSnapshot(harness, 1, snapshot(null, [workspace("a", repoA)]));
            queueSnapshot(
                harness,
                1,
                snapshot(null, [workspace("a", repoA), workspace("b", repoB)]),
            );
            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 1)),
                Effect.zipRight(emitInvalidated(harness, 1)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 1)),
                Effect.zipRight(Ref.get(harness.daemon.cache)),
                Effect.tap((cache) =>
                    Effect.sync(() => {
                        expect(harness.calls).toEqual([`ensure:${repoA}`, `ensure:${repoB}`]);
                        expect([...cache.ensuredGitRoots]).toEqual([repoA, repoB]);
                    }),
                ),
            );
        });
    });
});

test("stale ensure completion cannot record a root or synchronization time", async () => {
    await withTemporaryDirectory(async (directory) => {
        const oldRepo = join(directory, "old-repo");
        await initializeRepository(oldRepo);
        const gate = await Effect.runPromise(Deferred.make<void>());
        const ensureCompleted = await Effect.runPromise(Deferred.make<void>());
        await withDaemon(
            (harness) => {
                queueSnapshot(harness, 1, snapshot(null, [workspace("old", oldRepo)]));
                return emitInvalidated(harness, 1).pipe(
                    Effect.zipRight(advanceDebounce),
                    Effect.zipRight(awaitSnapshot(harness)),
                    Effect.zipRight(awaitCalls(harness, 1)),
                    Effect.zipRight(
                        Ref.update(harness.daemon.cache, (cache) => ({
                            ...cache,
                            latestLiveGeneration: generation(2),
                        })),
                    ),
                    Effect.zipRight(Ref.get(harness.daemon.cache)),
                    Effect.tap((cache) =>
                        Effect.sync(() => {
                            expect(cache.latestLiveGeneration).toBe(generation(2));
                            expect(cache.ensuredGitRoots.has(oldRepo)).toBeFalse();
                            expect(cache.lastSynchronizedAt).toBeNull();
                        }),
                    ),
                    Effect.zipRight(Queue.takeAll(harness.logEvents)),
                    Effect.zipRight(Deferred.succeed(gate, undefined)),
                    Effect.zipRight(Deferred.await(ensureCompleted)),
                    Effect.zipRight(
                        Effect.sync(() => {
                            queueSnapshot(harness, 2, snapshot(null, []));
                        }),
                    ),
                    Effect.zipRight(emitInvalidated(harness, 2)),
                    Effect.zipRight(advanceDebounce),
                    Effect.zipRight(awaitSnapshot(harness)),
                    Effect.zipRight(Queue.takeAll(harness.logEvents)),
                    Effect.tap((logs) =>
                        Effect.sync(() => {
                            expect(logs).not.toContainEqual(
                                expect.objectContaining({
                                    message: "workspace_sync_succeeded",
                                    annotations: expect.objectContaining({
                                        operation: "ensure_project",
                                    }),
                                }),
                            );
                        }),
                    ),
                    Effect.zipRight(Ref.get(harness.daemon.cache)),
                    Effect.tap((cache) =>
                        Effect.sync(() => {
                            expect(cache.ensuredGitRoots.has(oldRepo)).toBeFalse();
                            expect(cache.lastSynchronizedAt).toBeNull();
                        }),
                    ),
                );
            },
            {
                ensureProject: () =>
                    Effect.uninterruptible(Deferred.await(gate)).pipe(
                        Effect.zipRight(Deferred.succeed(ensureCompleted, undefined)),
                    ),
            },
        );
    });
});

test("stale focus completion cannot record or log success", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repo = join(directory, "repo");
        await initializeRepository(repo);
        const gate = await Effect.runPromise(Deferred.make<void>());
        const focusCompleted = await Effect.runPromise(Deferred.make<void>());
        await withDaemon(
            (harness) => {
                queueSnapshot(harness, 1, snapshot("workspace", [workspace("workspace", repo)]));
                return emitInvalidated(harness, 1).pipe(
                    Effect.zipRight(advanceDebounce),
                    Effect.zipRight(awaitSnapshot(harness)),
                    Effect.zipRight(awaitCalls(harness, 2)),
                    Effect.zipRight(
                        Ref.update(harness.daemon.cache, (cache) => ({
                            ...cache,
                            latestLiveGeneration: generation(2),
                        })),
                    ),
                    Effect.zipRight(Queue.takeAll(harness.logEvents)),
                    Effect.zipRight(Deferred.succeed(gate, undefined)),
                    Effect.zipRight(Deferred.await(focusCompleted)),
                    Effect.zipRight(
                        Effect.sync(() => {
                            queueSnapshot(harness, 2, snapshot(null, []));
                        }),
                    ),
                    Effect.zipRight(emitInvalidated(harness, 2)),
                    Effect.zipRight(advanceDebounce),
                    Effect.zipRight(awaitSnapshot(harness)),
                    Effect.zipRight(Queue.takeAll(harness.logEvents)),
                    Effect.tap((logs) =>
                        Effect.sync(() => {
                            expect(logs).not.toContainEqual(
                                expect.objectContaining({
                                    message: "workspace_sync_succeeded",
                                    annotations: expect.objectContaining({
                                        operation: "focus_project",
                                    }),
                                }),
                            );
                        }),
                    ),
                    Effect.zipRight(Ref.get(harness.daemon.cache)),
                    Effect.tap((cache) =>
                        Effect.sync(() => {
                            expect(cache.lastSuccessful).toBeNull();
                        }),
                    ),
                );
            },
            {
                focusProject: () =>
                    Effect.uninterruptible(Deferred.await(gate)).pipe(
                        Effect.zipRight(Deferred.succeed(focusCompleted, undefined)),
                    ),
            },
        );
    });
});

test("repeats ensure and focus for a reused root after a generation change", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repo = join(directory, "repo");
        await initializeRepository(repo);
        await withDaemon((harness) => {
            queueSnapshot(harness, 1, snapshot("workspace", [workspace("workspace", repo)]));
            queueSnapshot(harness, 2, snapshot("workspace", [workspace("workspace", repo)]));
            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(emitDisconnected(harness, 1)),
                Effect.zipRight(emitInvalidated(harness, 2)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(Ref.get(harness.daemon.cache)),
                Effect.tap((cache) =>
                    Effect.sync(() => {
                        expect(harness.calls).toEqual([
                            `ensure:${repo}`,
                            `focus:${repo}`,
                            `ensure:${repo}`,
                            `focus:${repo}`,
                        ]);
                        expect([...cache.ensuredGitRoots]).toEqual([repo]);
                        expect(cache.lastSuccessful).toEqual({
                            workspaceId: workspaceId("workspace"),
                            gitRoot: repo,
                        });
                    }),
                ),
            );
        });
    });
});

test("skips inaccessible, non-directory, and non-Git checkout paths with stable fields", async () => {
    await withTemporaryDirectory(async (directory) => {
        const file = join(directory, "file");
        const nonGit = join(directory, "non-git");
        const missing = join(directory, "missing");
        await writeFile(file, "not a directory\n");
        await mkdir(nonGit);
        await withDaemon((harness) => {
            queueSnapshot(
                harness,
                1,
                snapshot(null, [
                    workspace("missing", missing),
                    workspace("file", file),
                    workspace("non-git", nonGit),
                ]),
            );
            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitLogs(harness, 4)),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.calls).toEqual([]);
                        const skipped = harness.logs.filter(
                            (entry) => entry.message === "workspace_sync_skipped",
                        );
                        expect(skipped).toHaveLength(3);
                        expect(skipped.map((entry) => entry.annotations.operation).sort()).toEqual([
                            "git_root",
                            "stat",
                            "stat",
                        ]);
                        for (const entry of skipped) {
                            expect(entry.annotations).toMatchObject({
                                elapsed_ms: expect.any(String),
                                workspace: expect.any(String),
                                workspace_id: expect.any(String),
                            });
                        }
                    }),
                ),
            );
        });
    });
});

test("prefers checkout paths over plugin hints and uses hints only as a fallback", async () => {
    await withTemporaryDirectory(async (directory) => {
        const checkout = join(directory, "checkout");
        const hinted = join(directory, "hinted");
        await initializeRepository(checkout);
        await initializeRepository(hinted);
        await withDaemon((harness) => {
            queueSnapshot(
                harness,
                1,
                snapshot("checkout", [workspace("checkout", checkout), workspace("plugin", null)]),
            );
            return emitHint(harness, "checkout", hinted).pipe(
                Effect.zipRight(emitHint(harness, "plugin", hinted)),
                Effect.zipRight(emitInvalidated(harness, 1)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 3)),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.calls).toEqual([
                            `ensure:${checkout}`,
                            `ensure:${hinted}`,
                            `focus:${checkout}`,
                        ]);
                    }),
                ),
            );
        });
    });
});

test("caches a hint before live generation without queuing, then uses it after the generation arrives", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repo = join(directory, "repo");
        await initializeRepository(repo);
        await withDaemon((harness) => {
            queueSnapshot(harness, 1, snapshot("plugin", [workspace("plugin", null)]));
            return emitHint(harness, "plugin", repo).pipe(
                Effect.zipRight(TestClock.adjust("100 millis")),
                Effect.zipRight(settle),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.snapshotCalls).toEqual([]);
                        expect(harness.calls).toEqual([]);
                    }),
                ),
                Effect.zipRight(emitInvalidated(harness, 1)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.calls).toEqual([`ensure:${repo}`, `focus:${repo}`]);
                    }),
                ),
            );
        });
    });
});

test("uses a later current-generation hint to ensure and focus a project unresolved by an earlier snapshot", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repo = join(directory, "repo");
        await initializeRepository(repo);
        await withDaemon((harness) => {
            queueSnapshot(harness, 1, snapshot("plugin", [workspace("plugin", null)]));
            queueSnapshot(harness, 1, snapshot("plugin", [workspace("plugin", null)]));
            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitLogs(harness, 2)),
                Effect.zipRight(emitHint(harness, "plugin", repo)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.snapshotCalls).toEqual([1, 1]);
                        expect(harness.calls).toEqual([`ensure:${repo}`, `focus:${repo}`]);
                    }),
                ),
            );
        });
    });
});

test("disconnect during debounce clears generation without cache or editor effects, while N+1 succeeds", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repo = join(directory, "repo");
        await initializeRepository(repo);
        await withDaemon((harness) => {
            queueSnapshot(harness, 1, snapshot("old", [workspace("old", repo)]));
            queueSnapshot(harness, 2, snapshot("new", [workspace("new", repo)]));
            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(emitDisconnected(harness, 1)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.snapshotCalls).toEqual([]);
                        expect(harness.calls).toEqual([]);
                    }),
                ),
                Effect.zipRight(emitInvalidated(harness, 2)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(Ref.get(harness.daemon.cache)),
                Effect.tap((cache) =>
                    Effect.sync(() => {
                        expect(cache.snapshot?.focusedWorkspaceId).toBe(workspaceId("new"));
                        expect(harness.calls).toEqual([`ensure:${repo}`, `focus:${repo}`]);
                    }),
                ),
            );
        });
    });
});

test("disconnect interrupts a blocked snapshot before cache installation or editor calls, while N+1 succeeds", async () => {
    await withTemporaryDirectory(async (directory) => {
        const oldRepo = join(directory, "old-repo");
        const newRepo = join(directory, "new-repo");
        await initializeRepository(oldRepo);
        await initializeRepository(newRepo);
        const gate = await Effect.runPromise(Deferred.make<WorkspaceSnapshot>());
        await withDaemon((harness) => {
            harness.snapshots.set(1, [Deferred.await(gate)]);
            queueSnapshot(harness, 2, snapshot("new", [workspace("new", newRepo)]));
            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.snapshotCalls).toEqual([1]);
                    }),
                ),
                Effect.zipRight(emitDisconnected(harness, 1)),
                Effect.zipRight(emitInvalidated(harness, 2)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(Ref.get(harness.daemon.cache)),
                Effect.tap((cache) =>
                    Effect.sync(() => {
                        expect(cache.snapshot?.focusedWorkspaceId).toBe(workspaceId("new"));
                        expect(harness.calls).toEqual([`ensure:${newRepo}`, `focus:${newRepo}`]);
                        expect(harness.calls).not.toContain(`ensure:${oldRepo}`);
                        expect(harness.calls).not.toContain(`focus:${oldRepo}`);
                    }),
                ),
            );
        });
    });
});

test("Invalidated(2) supersedes a blocked generation 1 without Disconnected(1)", async () => {
    await withTemporaryDirectory(async (directory) => {
        const oldRepo = join(directory, "old-repo");
        const newRepo = join(directory, "new-repo");
        await initializeRepository(oldRepo);
        await initializeRepository(newRepo);
        const gate = await Effect.runPromise(Deferred.make<WorkspaceSnapshot>());
        await withDaemon((harness) => {
            harness.snapshots.set(1, [Deferred.await(gate)]);
            queueSnapshot(harness, 2, snapshot("new", [workspace("new", newRepo)]));
            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.snapshotCalls).toEqual([1]);
                        expect(harness.calls).toEqual([]);
                    }),
                ),
                Effect.zipRight(emitInvalidated(harness, 2)),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(Ref.get(harness.daemon.cache)),
                Effect.tap((cache) =>
                    Effect.sync(() => {
                        expect(harness.snapshotCalls).toEqual([1, 2]);
                        expect(cache.snapshot?.focusedWorkspaceId).toBe(workspaceId("new"));
                        expect(harness.calls).toEqual([`ensure:${newRepo}`, `focus:${newRepo}`]);
                        expect(harness.calls).not.toContain(`ensure:${oldRepo}`);
                        expect(harness.calls).not.toContain(`focus:${oldRepo}`);
                    }),
                ),
            );
        });
    });
});

test("disabling interrupts live synchronization and re-enabling refreshes the current generation", async () => {
    await withTemporaryDirectory(async (directory) => {
        const repo = join(directory, "repo");
        await initializeRepository(repo);
        const blockedSnapshot = await Effect.runPromise(Deferred.make<WorkspaceSnapshot>());

        await withDaemon((harness) => {
            harness.snapshots.set(1, [
                Deferred.await(blockedSnapshot),
                Effect.succeed(snapshot("workspace", [workspace("workspace", repo)])),
            ]);

            return emitInvalidated(harness, 1).pipe(
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(harness.daemon.toggleEnabled),
                Effect.tap((enabled) =>
                    Effect.sync(() => {
                        expect(enabled).toBe(false);
                    }),
                ),
                Effect.zipRight(settle),
                Effect.zipRight(harness.daemon.enabled),
                Effect.tap((enabled) =>
                    Effect.sync(() => {
                        expect(enabled).toBe(false);
                        expect(harness.calls).toEqual([]);
                    }),
                ),
                Effect.zipRight(harness.daemon.toggleEnabled),
                Effect.tap((enabled) =>
                    Effect.sync(() => {
                        expect(enabled).toBe(true);
                    }),
                ),
                Effect.zipRight(advanceDebounce),
                Effect.zipRight(awaitSnapshot(harness)),
                Effect.zipRight(awaitCalls(harness, 2)),
                Effect.zipRight(
                    Effect.sync(() => {
                        expect(harness.snapshotCalls).toEqual([1, 1]);
                        expect(harness.calls).toEqual([`ensure:${repo}`, `focus:${repo}`]);
                    }),
                ),
            );
        });
    });
});
