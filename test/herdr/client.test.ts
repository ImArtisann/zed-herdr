import { expect, test, vi } from "bun:test";
import * as BunContext from "@effect/platform-bun/BunContext";
import * as Chunk from "effect/Chunk";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { realpath } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    WorkspaceGeneration,
    WorkspaceId,
    WorkspaceSourceEvent,
} from "../../src/domain/workspace.ts";
import type { SyncDaemon } from "../../src/sync/daemon.ts";
import type { HerdRClientService } from "../../src/herdr/client.ts";
import { makeHerdRClient, resolveHerdRSocketPath } from "../../src/herdr/client.ts";
import { EditorAdapter } from "../../src/services/editor-adapter.ts";
import { WorkspaceHintSource } from "../../src/services/workspace-hint-source.ts";
import { WorkspaceSource } from "../../src/services/workspace-source.ts";
import { makeSyncDaemon } from "../../src/sync/daemon.ts";

interface OutboundRequest {
    readonly id: string;
    readonly method: string;
    readonly params: unknown;
}

interface ReceivedRequest {
    readonly raw: string;
    readonly request: OutboundRequest;
    readonly socket: Bun.Socket<ServerConnection>;
}

interface ServerConnection {
    buffer: string;
    readonly decoder: TextDecoder;
    request: OutboundRequest | undefined;
}

interface ServerHarness {
    readonly closed: AsyncQueue<ServerConnection>;
    readonly path: string;
    readonly requests: AsyncQueue<ReceivedRequest>;
    close(): Promise<void>;
}

class AsyncQueue<Value> {
    get size(): number {
        return this.#values.length;
    }
    readonly #values: Array<Value> = [];
    readonly #waiters: Array<PromiseWithResolvers<Value>> = [];

    offer(value: Value): void {
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
            this.#values.push(value);
            return;
        }
        waiter.resolve(value);
    }

    take(): Promise<Value> {
        const value = this.#values.shift();
        if (value !== undefined) {
            return Promise.resolve(value);
        }
        const waiter = Promise.withResolvers<Value>();
        this.#waiters.push(waiter);
        return waiter.promise;
    }
}

const generation = (value: number): WorkspaceGeneration => value as WorkspaceGeneration;
const workspaceId = (value: string): WorkspaceId => value as WorkspaceId;

const snapshot = (
    options: {
        readonly checkoutPath?: string;
        readonly label?: string;
        readonly protocol?: number;
    } = {},
) => ({
    version: "0.7.3",
    protocol: options.protocol ?? 16,
    workspaces: [
        {
            workspace_id: "workspace-1",
            number: 1,
            label: options.label ?? "alpha",
            focused: true,
            pane_count: 0,
            tab_count: 0,
            active_tab_id: "tab-1",
            agent_status: "idle",
            worktree: {
                repo_key: "repo-1",
                repo_name: "repo",
                repo_root: "/repos/repo",
                checkout_path: options.checkoutPath ?? "/repos/repo",
                is_linked_worktree: false,
            },
        },
    ],
    tabs: [],
    panes: [],
    layouts: [],
    agents: [],
    focused_workspace_id: "workspace-1",
    focused_tab_id: "tab-1",
    focused_pane_id: null,
});

const snapshotResponse = (
    id: string,
    options: {
        readonly checkoutPath?: string;
        readonly label?: string;
        readonly protocol?: number;
    } = {},
) => ({
    id,
    result: { type: "session_snapshot", snapshot: snapshot(options) },
});

const subscriptionStarted = (id: string) => ({ id, result: { type: "subscription_started" } });

const focusedEvent = () => ({
    event: "workspace_focused",
    data: { type: "workspace_focused", workspace_id: "workspace-1" },
});

const writeJson = (socket: Bun.Socket<ServerConnection>, value: unknown): void => {
    socket.write(`${JSON.stringify(value)}\n`);
};

const takeClosedMethod = async (
    server: ServerHarness,
    method: string,
): Promise<ServerConnection> => {
    for (;;) {
        const connection = await server.closed.take();
        if (connection.request?.method === method) {
            return connection;
        }
    }
};

const takeEvents = (client: HerdRClientService, count: number) =>
    Effect.runPromise(Stream.runCollect(client.events.pipe(Stream.take(count)))).then(
        Chunk.toReadonlyArray,
    );

const runSnapshot = (client: HerdRClientService, currentGeneration: number) =>
    Effect.runPromise(client.snapshot(generation(currentGeneration)));

const withClient = <Value>(
    socketPath: string,
    body: (client: HerdRClientService) => Promise<Value>,
): Promise<Value> =>
    Effect.runPromise(
        Effect.scoped(
            makeHerdRClient({ HERDR_SOCKET_PATH: socketPath }).pipe(
                Effect.flatMap((client) => Effect.promise(() => body(client))),
            ),
        ),
    );

interface DaemonClientHarness {
    readonly callEvents: Queue.Queue<string>;
    readonly calls: ReadonlyArray<string>;
    readonly client: HerdRClientService;
    readonly daemon: SyncDaemon;
}

const withDaemonClient = <Value>(
    socketPath: string,
    body: (harness: DaemonClientHarness) => Effect.Effect<Value, never, Scope.Scope>,
): Promise<Value> =>
    Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* makeHerdRClient({ HERDR_SOCKET_PATH: socketPath });
                const calls: Array<string> = [];
                const callEvents = yield* Queue.unbounded<string>();
                const daemon = yield* makeSyncDaemon.pipe(
                    Effect.provideService(WorkspaceSource, {
                        snapshot: client.snapshot,
                        events: client.events,
                    }),
                    Effect.provideService(WorkspaceHintSource, { hints: Stream.empty }),
                    Effect.provideService(EditorAdapter, {
                        ensureProject: (path) =>
                            Effect.sync(() => calls.push(`ensure:${path}`)).pipe(
                                Effect.zipRight(Queue.offer(callEvents, `ensure:${path}`)),
                            ),
                        focusProject: (path) =>
                            Effect.sync(() => calls.push(`focus:${path}`)).pipe(
                                Effect.zipRight(Queue.offer(callEvents, `focus:${path}`)),
                            ),
                    }),
                );
                yield* daemon.run.pipe(
                    Effect.provide(BunContext.layer),
                    Effect.catchAllCause(Effect.die),
                    Effect.forkScoped,
                );
                return yield* body({ callEvents, calls, client, daemon });
            }),
        ),
    );

const makeServer = async (): Promise<ServerHarness> => {
    const directory = await mkdtemp(join(tmpdir(), "zed-herdr-client-"));
    const path = join(directory, "herdr.sock");
    const requests = new AsyncQueue<ReceivedRequest>();
    const closed = new AsyncQueue<ServerConnection>();
    const listener = Bun.listen<ServerConnection>({
        unix: path,
        socket: {
            open(socket) {
                socket.data = { buffer: "", decoder: new TextDecoder(), request: undefined };
            },
            data(socket, data) {
                const connection = socket.data;
                connection.buffer += connection.decoder.decode(data, { stream: true });
                for (;;) {
                    const newline = connection.buffer.indexOf("\n");
                    if (newline < 0) {
                        return;
                    }
                    const raw = connection.buffer.slice(0, newline + 1);
                    connection.buffer = connection.buffer.slice(newline + 1);
                    const request = JSON.parse(raw) as OutboundRequest;
                    connection.request = request;
                    requests.offer({ raw, request, socket });
                }
            },
            close(socket) {
                closed.offer(socket.data);
            },
        },
    });

    return {
        path,
        requests,
        closed,
        async close() {
            listener.stop();
            await rm(directory, { force: true, recursive: true });
        },
    };
};

test("resolveHerdRSocketPath gives HERDR_SOCKET_PATH precedence over named and default sessions", () => {
    expect(
        resolveHerdRSocketPath({
            HERDR_SOCKET_PATH: "/override/herdr.sock",
            HERDR_SESSION: "named",
            HOME: "/home/artisan",
            XDG_CONFIG_HOME: "/config",
        }),
    ).toBe("/override/herdr.sock");
    expect(resolveHerdRSocketPath({ HERDR_SESSION: "named", XDG_CONFIG_HOME: "/config" })).toBe(
        "/config/herdr/sessions/named/herdr.sock",
    );
    expect(resolveHerdRSocketPath({ HOME: "/home/artisan" })).toBe(
        "/home/artisan/.config/herdr/herdr.sock",
    );
});

test("sends exact newline-delimited read-only requests and gates S2 until subscription_started", async () => {
    const server = await makeServer();
    try {
        await withClient(server.path, async (client) => {
            const receivedEvents = takeEvents(client, 1);
            const firstSnapshot = await server.requests.take();
            expect(firstSnapshot.raw.endsWith("\n")).toBe(true);
            expect(firstSnapshot.request).toMatchObject({ method: "session.snapshot", params: {} });
            expect(firstSnapshot.request.id).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
            writeJson(firstSnapshot.socket, snapshotResponse(firstSnapshot.request.id));

            const subscribe = await server.requests.take();
            expect(subscribe.raw.endsWith("\n")).toBe(true);
            expect(subscribe.request).toEqual({
                id: subscribe.request.id,
                method: "events.subscribe",
                params: {
                    subscriptions: [
                        { type: "workspace.created" },
                        { type: "workspace.updated" },
                        { type: "workspace.renamed" },
                        { type: "workspace.moved" },
                        { type: "workspace.closed" },
                        { type: "workspace.focused" },
                        { type: "worktree.created" },
                        { type: "worktree.opened" },
                        { type: "worktree.removed" },
                    ],
                },
            });
            expect(
                await Effect.runPromise(Effect.either(client.snapshot(generation(1)))),
            ).toMatchObject({
                _tag: "Left",
                left: { _tag: "StaleWorkspaceGeneration", generation: generation(1) },
            });

            writeJson(subscribe.socket, subscriptionStarted(subscribe.request.id));
            expect(await receivedEvents).toEqual([
                { _tag: "Invalidated", generation: generation(1) },
            ]);

            const secondSnapshotPromise = runSnapshot(client, 1);
            const secondSnapshot = await server.requests.take();
            expect(secondSnapshot.request.method).toBe("session.snapshot");
            writeJson(
                secondSnapshot.socket,
                snapshotResponse(secondSnapshot.request.id, { label: "S2" }),
            );

            expect(await secondSnapshotPromise).toEqual({
                focusedWorkspaceId: workspaceId("workspace-1"),
                workspaces: [
                    {
                        workspaceId: workspaceId("workspace-1"),
                        name: "S2",
                        checkoutPath: "/repos/repo",
                        isLinkedWorktree: false,
                    },
                ],
            });

            expect([
                firstSnapshot.request.method,
                subscribe.request.method,
                secondSnapshot.request.method,
            ]).toEqual(["session.snapshot", "events.subscribe", "session.snapshot"]);
        });
    } finally {
        await server.close();
    }
});

test("incrementally decodes split UTF-8 and a trailing S2 frame", async () => {
    const server = await makeServer();
    try {
        await withClient(server.path, async (client) => {
            const firstSnapshot = await server.requests.take();
            writeJson(firstSnapshot.socket, snapshotResponse(firstSnapshot.request.id));
            const subscribe = await server.requests.take();
            writeJson(subscribe.socket, subscriptionStarted(subscribe.request.id));
            await takeEvents(client, 1);

            const secondSnapshotPromise = runSnapshot(client, 1);
            const secondSnapshot = await server.requests.take();
            const encoded = new TextEncoder().encode(
                JSON.stringify(snapshotResponse(secondSnapshot.request.id, { label: "café 🐙" })),
            );
            const octopus = encoded.findIndex((byte) => byte === 0xf0);
            expect(octopus).toBeGreaterThan(0);
            secondSnapshot.socket.write(encoded.slice(0, octopus + 2));
            secondSnapshot.socket.end(encoded.slice(octopus + 2));

            expect((await secondSnapshotPromise).workspaces[0]?.name).toBe("café 🐙");
        });
    } finally {
        await server.close();
    }
});

test("skips malformed frames, ignores pre-ack lifecycle replay, and preserves generation tags", async () => {
    const server = await makeServer();
    try {
        await withClient(server.path, async (client) => {
            const events = takeEvents(client, 3);
            const firstSnapshot = await server.requests.take();
            writeJson(firstSnapshot.socket, snapshotResponse(firstSnapshot.request.id));
            const subscribe = await server.requests.take();

            subscribe.socket.write("not-json\n");
            writeJson(subscribe.socket, focusedEvent());
            subscribe.socket.write(
                `${JSON.stringify(subscriptionStarted(subscribe.request.id))}\n${JSON.stringify({ event: "workspace_focused", data: { type: "workspace_focused" } })}\n${JSON.stringify(focusedEvent())}\n${JSON.stringify(focusedEvent())}\n`,
            );

            expect(await events).toEqual([
                { _tag: "Invalidated", generation: generation(1) },
                { _tag: "Invalidated", generation: generation(1) },
                { _tag: "Invalidated", generation: generation(1) },
            ]);
        });
    } finally {
        await server.close();
    }
});

test("rejects matching HerdR error responses without sending another method", async () => {
    const server = await makeServer();
    try {
        await withClient(server.path, async (client) => {
            const firstSnapshot = await server.requests.take();
            writeJson(firstSnapshot.socket, snapshotResponse(firstSnapshot.request.id));
            const subscribe = await server.requests.take();
            writeJson(subscribe.socket, subscriptionStarted(subscribe.request.id));
            await takeEvents(client, 1);

            const rejectedSnapshot = Effect.runPromise(
                Effect.either(client.snapshot(generation(1))),
            );
            const secondSnapshot = await server.requests.take();
            writeJson(secondSnapshot.socket, {
                id: secondSnapshot.request.id,
                error: { code: "internal", message: "snapshot unavailable" },
            });
            expect(await rejectedSnapshot).toMatchObject({
                _tag: "Left",
                left: {
                    _tag: "WorkspaceSourceProtocolError",
                    operation: "response",
                    message: "snapshot unavailable",
                },
            });
            expect(secondSnapshot.request.method).toBe("session.snapshot");
        });
    } finally {
        await server.close();
    }
});

test("retries S1 protocol failures with deterministic exponential delays capped at five seconds", async () => {
    const server = await makeServer();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.useFakeTimers();
    try {
        await withClient(server.path, async () => {
            for (const delay of [100, 200, 400, 800, 1_600, 3_200, 5_000]) {
                const request = await server.requests.take();
                expect(request.request.method).toBe("session.snapshot");
                writeJson(request.socket, snapshotResponse(request.request.id, { protocol: 15 }));
                await takeClosedMethod(server, "session.snapshot");
                await Promise.resolve();
                await Promise.resolve();
                vi.advanceTimersByTime(delay);
            }
        });
    } finally {
        vi.useRealTimers();
        random.mockRestore();
        await server.close();
    }
});

test("disconnects an acknowledged generation, rejects an in-flight S2, recovers as N+1, and closes scoped sockets", async () => {
    const server = await makeServer();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.useFakeTimers();
    try {
        const subscriptionClosed = Promise.withResolvers<ServerConnection>();
        await withClient(server.path, async (client) => {
            const events = new AsyncQueue<WorkspaceSourceEvent>();
            Effect.runFork(
                Stream.runForEach(client.events, (event) => Effect.sync(() => events.offer(event))),
            );
            const firstSnapshot = await server.requests.take();
            writeJson(firstSnapshot.socket, snapshotResponse(firstSnapshot.request.id));
            const subscribe = await server.requests.take();
            writeJson(subscribe.socket, subscriptionStarted(subscribe.request.id));
            expect(await events.take()).toEqual({
                _tag: "Invalidated",
                generation: generation(1),
            });

            const staleSnapshot = Effect.runPromise(Effect.either(client.snapshot(generation(1))));
            const blockedS2 = await server.requests.take();
            expect(blockedS2.request.method).toBe("session.snapshot");
            subscribe.socket.end();

            expect(await events.take()).toEqual({
                _tag: "Disconnected",
                generation: generation(1),
            });
            expect(await staleSnapshot).toMatchObject({
                _tag: "Left",
                left: { _tag: "StaleWorkspaceGeneration", generation: generation(1) },
            });
            await takeClosedMethod(server, "session.snapshot");
            await Promise.resolve();
            await Promise.resolve();
            vi.advanceTimersByTime(100);

            const recoveredS1 = await server.requests.take();
            expect(recoveredS1.request.method).toBe("session.snapshot");
            writeJson(recoveredS1.socket, snapshotResponse(recoveredS1.request.id));
            const recoveredSubscribe = await server.requests.take();
            expect(recoveredSubscribe.request.method).toBe("events.subscribe");
            writeJson(
                recoveredSubscribe.socket,
                subscriptionStarted(recoveredSubscribe.request.id),
            );

            expect(await events.take()).toEqual({
                _tag: "Invalidated",
                generation: generation(2),
            });
            const recoveredSnapshotPromise = runSnapshot(client, 2);
            const recoveredS2 = await server.requests.take();
            writeJson(
                recoveredS2.socket,
                snapshotResponse(recoveredS2.request.id, { label: "N+1" }),
            );
            expect((await recoveredSnapshotPromise).workspaces[0]?.name).toBe("N+1");

            void takeClosedMethod(server, "events.subscribe").then(subscriptionClosed.resolve);
        });
        expect((await subscriptionClosed.promise).request?.method).toBe("events.subscribe");
    } finally {
        vi.useRealTimers();
        random.mockRestore();
        await server.close();
    }
});

test("daemon drops N when the subscription closes during its 50 ms debounce", async () => {
    const server = await makeServer();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const repositoryRoot = await realpath(join(import.meta.dir, "../.."));
    try {
        await withDaemonClient(server.path, (harness) =>
            Effect.gen(function* () {
                const sourceEvents = new AsyncQueue<WorkspaceSourceEvent>();
                yield* Stream.runForEach(harness.client.events, (event) =>
                    Effect.sync(() => sourceEvents.offer(event)),
                ).pipe(Effect.forkScoped);

                const firstS1 = yield* Effect.promise(() => server.requests.take());
                writeJson(
                    firstS1.socket,
                    snapshotResponse(firstS1.request.id, { checkoutPath: repositoryRoot }),
                );
                const firstSubscription = yield* Effect.promise(() => server.requests.take());
                writeJson(
                    firstSubscription.socket,
                    subscriptionStarted(firstSubscription.request.id),
                );
                expect(yield* Effect.promise(() => sourceEvents.take())).toEqual({
                    _tag: "Invalidated",
                    generation: generation(1),
                });
                firstSubscription.socket.end();
                expect(yield* Effect.promise(() => sourceEvents.take())).toEqual({
                    _tag: "Disconnected",
                    generation: generation(1),
                });

                yield* Effect.sleep("70 millis");
                expect(server.requests.size).toBe(0);
                expect(harness.calls).toEqual([]);

                const secondS1 = yield* Effect.promise(() => server.requests.take());
                writeJson(
                    secondS1.socket,
                    snapshotResponse(secondS1.request.id, { checkoutPath: repositoryRoot }),
                );
                const secondSubscription = yield* Effect.promise(() => server.requests.take());
                writeJson(
                    secondSubscription.socket,
                    subscriptionStarted(secondSubscription.request.id),
                );
                expect(yield* Effect.promise(() => sourceEvents.take())).toEqual({
                    _tag: "Invalidated",
                    generation: generation(2),
                });
                const secondS2 = yield* Effect.promise(() => server.requests.take());
                writeJson(
                    secondS2.socket,
                    snapshotResponse(secondS2.request.id, { checkoutPath: repositoryRoot }),
                );

                yield* Queue.take(harness.callEvents);
                yield* Queue.take(harness.callEvents);
                expect(harness.calls).toEqual([
                    `ensure:${repositoryRoot}`,
                    `focus:${repositoryRoot}`,
                ]);
                const cache = yield* Ref.get(harness.daemon.cache);
                expect(cache.latestLiveGeneration).toBe(generation(2));
                expect(cache.lastSuccessful?.workspaceId).toBe(workspaceId("workspace-1"));
            }),
        );
    } finally {
        random.mockRestore();
        await server.close();
    }
});

test("daemon cancels blocked N S2 on disconnect and accepts only N+1 S2", async () => {
    const server = await makeServer();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const repositoryRoot = await realpath(join(import.meta.dir, "../.."));
    try {
        await withDaemonClient(server.path, (harness) =>
            Effect.gen(function* () {
                const sourceEvents = new AsyncQueue<WorkspaceSourceEvent>();
                yield* Stream.runForEach(harness.client.events, (event) =>
                    Effect.sync(() => sourceEvents.offer(event)),
                ).pipe(Effect.forkScoped);

                const firstS1 = yield* Effect.promise(() => server.requests.take());
                writeJson(
                    firstS1.socket,
                    snapshotResponse(firstS1.request.id, { checkoutPath: repositoryRoot }),
                );
                const firstSubscription = yield* Effect.promise(() => server.requests.take());
                writeJson(
                    firstSubscription.socket,
                    subscriptionStarted(firstSubscription.request.id),
                );
                expect(yield* Effect.promise(() => sourceEvents.take())).toMatchObject({
                    _tag: "Invalidated",
                    generation: generation(1),
                });

                const blockedS2 = yield* Effect.promise(() => server.requests.take());
                expect(blockedS2.request.method).toBe("session.snapshot");
                firstSubscription.socket.end();
                expect(yield* Effect.promise(() => sourceEvents.take())).toEqual({
                    _tag: "Disconnected",
                    generation: generation(1),
                });
                expect(harness.calls).toEqual([]);
                expect((yield* Ref.get(harness.daemon.cache)).snapshot).toBeNull();

                const secondS1 = yield* Effect.promise(() => server.requests.take());
                writeJson(
                    secondS1.socket,
                    snapshotResponse(secondS1.request.id, { checkoutPath: repositoryRoot }),
                );
                const secondSubscription = yield* Effect.promise(() => server.requests.take());
                writeJson(
                    secondSubscription.socket,
                    subscriptionStarted(secondSubscription.request.id),
                );
                expect(yield* Effect.promise(() => sourceEvents.take())).toMatchObject({
                    _tag: "Invalidated",
                    generation: generation(2),
                });
                const secondS2 = yield* Effect.promise(() => server.requests.take());
                writeJson(
                    secondS2.socket,
                    snapshotResponse(secondS2.request.id, { checkoutPath: repositoryRoot }),
                );

                yield* Queue.take(harness.callEvents);
                yield* Queue.take(harness.callEvents);
                expect(harness.calls).toEqual([
                    `ensure:${repositoryRoot}`,
                    `focus:${repositoryRoot}`,
                ]);
                const cache = yield* Ref.get(harness.daemon.cache);
                expect(cache.latestLiveGeneration).toBe(generation(2));
                expect(cache.lastSuccessful?.gitRoot).toBe(repositoryRoot);
            }),
        );
    } finally {
        random.mockRestore();
        await server.close();
    }
});
