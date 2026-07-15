import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

interface HerdRRequest {
    readonly id: string;
    readonly method: string;
    readonly params: unknown;
}

interface HerdRConnection {
    buffer: string;
    readonly decoder: TextDecoder;
}

interface RecorderConnection {
    buffer: string;
    readonly decoder: TextDecoder;
}

interface ReceivedRequest {
    readonly request: HerdRRequest;
    readonly socket: Bun.Socket<HerdRConnection>;
}

const defaultArtifactPath = resolve(import.meta.dir, "../../dist/index.js");

const resolveArtifactPath = (
    environment: Partial<Pick<NodeJS.ProcessEnv, "ZED_HERDR_TEST_DIST">>,
): string => {
    const override = environment.ZED_HERDR_TEST_DIST;
    const artifactPath = override ?? defaultArtifactPath;

    if (override !== undefined && !isAbsolute(override)) {
        throw new Error("ZED_HERDR_TEST_DIST must be an absolute path");
    }
    if (!existsSync(artifactPath)) {
        throw new Error(`Built daemon artifact does not exist: ${artifactPath}`);
    }
    return artifactPath;
};

const snapshot = (repoA: string, repoB: string, focusedWorkspaceId: string) => ({
    version: "0.7.3",
    protocol: 16,
    workspaces: [
        {
            workspace_id: "workspace-a",
            number: 1,
            label: "repo-a",
            focused: focusedWorkspaceId === "workspace-a",
            pane_count: 0,
            tab_count: 0,
            active_tab_id: "tab-a",
            agent_status: "idle",
            worktree: {
                repo_key: "repo-a",
                repo_name: "repo-a",
                repo_root: repoA,
                checkout_path: repoA,
                is_linked_worktree: false,
            },
        },
        {
            workspace_id: "workspace-b",
            number: 2,
            label: "repo-b",
            focused: focusedWorkspaceId === "workspace-b",
            pane_count: 0,
            tab_count: 0,
            active_tab_id: "tab-b",
            agent_status: "idle",
            worktree: {
                repo_key: "repo-b",
                repo_name: "repo-b",
                repo_root: repoB,
                checkout_path: repoB,
                is_linked_worktree: false,
            },
        },
    ],
    tabs: [],
    panes: [],
    layouts: [],
    agents: [],
    focused_workspace_id: focusedWorkspaceId,
    focused_tab_id: null,
    focused_pane_id: null,
});

const snapshotResponse = (request: HerdRRequest, value: unknown) => ({
    id: request.id,
    result: { type: "session_snapshot", snapshot: value },
});

const subscriptionStarted = (request: HerdRRequest) => ({
    id: request.id,
    result: { type: "subscription_started" },
});

const focusedEvent = (workspaceId: string) => ({
    event: "workspace_focused",
    data: { type: "workspace_focused", workspace_id: workspaceId },
});

const parseRequest = (frame: string): HerdRRequest => {
    const value: unknown = JSON.parse(frame);
    if (
        value === null ||
        typeof value !== "object" ||
        !("id" in value) ||
        typeof value.id !== "string" ||
        !("method" in value) ||
        typeof value.method !== "string" ||
        !("params" in value)
    ) {
        throw new Error(`Unexpected HerdR request: ${frame}`);
    }
    return value as HerdRRequest;
};

class HerdRServer {
    readonly #listener: Bun.UnixSocketListener<HerdRConnection>;
    readonly #requests: Array<ReceivedRequest> = [];
    readonly #waiters: Array<{
        readonly method: string;
        readonly resolve: (request: ReceivedRequest) => void;
    }> = [];

    constructor(path: string) {
        this.#listener = Bun.listen<HerdRConnection>({
            unix: path,
            socket: {
                open(socket) {
                    socket.data = { buffer: "", decoder: new TextDecoder() };
                },
                data: (socket, data) => {
                    const connection = socket.data;
                    connection.buffer += connection.decoder.decode(data, { stream: true });
                    for (;;) {
                        const newline = connection.buffer.indexOf("\n");
                        if (newline < 0) {
                            return;
                        }
                        const frame = connection.buffer.slice(0, newline);
                        connection.buffer = connection.buffer.slice(newline + 1);
                        if (frame.length > 0) {
                            this.#offer({ request: parseRequest(frame), socket });
                        }
                    }
                },
            },
        });
    }

    close(): void {
        this.#listener.stop();
    }

    nextRequest(method: string): Promise<ReceivedRequest> {
        const index = this.#requests.findIndex((received) => received.request.method === method);
        if (index >= 0) {
            return Promise.resolve(this.#requests.splice(index, 1)[0]!);
        }

        const pending = Promise.withResolvers<ReceivedRequest>();
        this.#waiters.push({ method, resolve: pending.resolve });
        return pending.promise;
    }

    send(socket: Bun.Socket<HerdRConnection>, value: unknown): void {
        socket.write(`${JSON.stringify(value)}\n`);
    }

    writeRaw(socket: Bun.Socket<HerdRConnection>, frame: string): void {
        socket.write(frame);
    }

    #offer(received: ReceivedRequest): void {
        const index = this.#waiters.findIndex(
            (waiter) => waiter.method === received.request.method,
        );
        if (index < 0) {
            this.#requests.push(received);
            return;
        }
        this.#waiters.splice(index, 1)[0]!.resolve(received);
    }
}

class RecorderServer {
    readonly #listener: Bun.UnixSocketListener<RecorderConnection>;
    readonly #waiters: Array<{
        readonly count: number;
        readonly resolve: () => void;
    }> = [];
    readonly records: Array<string> = [];

    constructor(path: string) {
        this.#listener = Bun.listen<RecorderConnection>({
            unix: path,
            socket: {
                open(socket) {
                    socket.data = { buffer: "", decoder: new TextDecoder() };
                },
                data: (socket, data) => {
                    const connection = socket.data;
                    connection.buffer += connection.decoder.decode(data, { stream: true });
                    for (;;) {
                        const newline = connection.buffer.indexOf("\n");
                        if (newline < 0) {
                            return;
                        }
                        const record = connection.buffer.slice(0, newline);
                        connection.buffer = connection.buffer.slice(newline + 1);
                        if (record.length > 0) {
                            this.records.push(record);
                            this.#settleWaiters();
                            socket.end("ok\n");
                        }
                    }
                },
            },
        });
    }

    close(): void {
        this.#listener.stop();
    }

    waitForCount(count: number): Promise<void> {
        if (this.records.length >= count) {
            return Promise.resolve();
        }

        const pending = Promise.withResolvers<void>();
        this.#waiters.push({ count, resolve: pending.resolve });
        return pending.promise;
    }

    #settleWaiters(): void {
        for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
            const waiter = this.#waiters[index];
            if (waiter !== undefined && this.records.length >= waiter.count) {
                this.#waiters.splice(index, 1)[0]!.resolve();
            }
        }
    }
}

const createGitRepository = async (path: string): Promise<string> => {
    const initialized = Bun.spawn(["git", "init", "--quiet", path], {
        stderr: "ignore",
        stdout: "ignore",
    });
    expect(await initialized.exited).toBe(0);
    return realpath(path);
};

const writeFakeZed = async (path: string): Promise<void> => {
    await writeFile(
        path,
        `#!/usr/bin/env bun
const recorderSocket = process.env.ZED_HERDR_RECORDER_SOCKET;
if (recorderSocket === undefined) {
    throw new Error("ZED_HERDR_RECORDER_SOCKET is required");
}
const completed = Promise.withResolvers();
void Bun.connect({
    unix: recorderSocket,
    socket: {
        open(socket) {
            socket.write(process.argv.slice(2).join(" ") + "\\n");
        },
        data(socket) {
            socket.end();
            completed.resolve();
        },
        error(_socket, error) {
            completed.reject(error);
        },
    },
}).catch(completed.reject);
await completed.promise;
`,
    );
    await chmod(path, 0o755);
};

test("daemon artifact override rejects relative and missing paths", () => {
    expect(() => resolveArtifactPath({ ZED_HERDR_TEST_DIST: "dist/index.js" })).toThrow(
        "ZED_HERDR_TEST_DIST must be an absolute path",
    );
    expect(() =>
        resolveArtifactPath({
            ZED_HERDR_TEST_DIST: join(tmpdir(), `zed-herdr-missing-${crypto.randomUUID()}.js`),
        }),
    ).toThrow("Built daemon artifact does not exist");
});

test("built daemon gates editor activation through S1, subscription acknowledgement, and S2", async () => {
    const artifactPath = resolveArtifactPath({});
    const directory = await mkdtemp(join(tmpdir(), "zh-e2e-"));
    const herdr = new HerdRServer(join(directory, "herdr.sock"));
    const recorder = new RecorderServer(join(directory, "recorder.sock"));
    const fakeZed = join(directory, "fake-zed");
    const repoAPath = join(directory, "repo-a");
    const repoBPath = join(directory, "repo-b");
    let daemon: Bun.Subprocess | undefined;

    try {
        await writeFakeZed(fakeZed);
        const [repoA, repoB] = await Promise.all([
            createGitRepository(repoAPath),
            createGitRepository(repoBPath),
        ]);
        const focusedA = snapshot(repoA, repoB, "workspace-a");
        const focusedB = snapshot(repoA, repoB, "workspace-b");

        daemon = Bun.spawn([process.execPath, artifactPath, "daemon"], {
            env: {
                ...process.env,
                HERDR_SOCKET_PATH: join(directory, "herdr.sock"),
                ZED_BIN: fakeZed,
                ZED_HERDR_RECORDER_SOCKET: join(directory, "recorder.sock"),
            },
            stderr: "ignore",
            stdin: "ignore",
            stdout: "ignore",
        });

        const initialSnapshot = await herdr.nextRequest("session.snapshot");
        herdr.send(initialSnapshot.socket, snapshotResponse(initialSnapshot.request, focusedA));

        const subscription = await herdr.nextRequest("events.subscribe");
        herdr.send(subscription.socket, subscriptionStarted(subscription.request));

        const firstAuthoritativeSnapshot = await herdr.nextRequest("session.snapshot");
        expect(recorder.records).toEqual([]);
        herdr.send(
            firstAuthoritativeSnapshot.socket,
            snapshotResponse(firstAuthoritativeSnapshot.request, focusedB),
        );

        await recorder.waitForCount(3);
        expect(recorder.records).toEqual([`-e ${repoA}`, `-e ${repoB}`, `-e ${repoB}`]);

        herdr.send(subscription.socket, focusedEvent("workspace-a"));
        const focusedASnapshot = await herdr.nextRequest("session.snapshot");
        herdr.send(focusedASnapshot.socket, snapshotResponse(focusedASnapshot.request, focusedA));

        await recorder.waitForCount(4);
        expect(recorder.records).toEqual([
            `-e ${repoA}`,
            `-e ${repoB}`,
            `-e ${repoB}`,
            `-e ${repoA}`,
        ]);

        herdr.send(subscription.socket, focusedEvent("workspace-a"));
        const duplicateSnapshot = await herdr.nextRequest("session.snapshot");
        herdr.send(duplicateSnapshot.socket, snapshotResponse(duplicateSnapshot.request, focusedA));
        herdr.writeRaw(
            subscription.socket,
            '{"event":"workspace_focused","data":{"type":"workspace_focused"}}\n',
        );
        herdr.send(subscription.socket, focusedEvent("workspace-b"));

        const interruptedSnapshot = await herdr.nextRequest("session.snapshot");
        expect(recorder.records).toEqual([
            `-e ${repoA}`,
            `-e ${repoB}`,
            `-e ${repoB}`,
            `-e ${repoA}`,
        ]);
        subscription.socket.end();
        void interruptedSnapshot;

        const reconnectInitialSnapshot = await herdr.nextRequest("session.snapshot");
        herdr.send(
            reconnectInitialSnapshot.socket,
            snapshotResponse(reconnectInitialSnapshot.request, focusedB),
        );
        const reconnectSubscription = await herdr.nextRequest("events.subscribe");
        herdr.send(
            reconnectSubscription.socket,
            subscriptionStarted(reconnectSubscription.request),
        );

        const reconnectAuthoritativeSnapshot = await herdr.nextRequest("session.snapshot");
        expect(recorder.records).toEqual([
            `-e ${repoA}`,
            `-e ${repoB}`,
            `-e ${repoB}`,
            `-e ${repoA}`,
        ]);
        herdr.send(
            reconnectAuthoritativeSnapshot.socket,
            snapshotResponse(reconnectAuthoritativeSnapshot.request, focusedB),
        );

        await recorder.waitForCount(5);
        expect(recorder.records).toEqual([
            `-e ${repoA}`,
            `-e ${repoB}`,
            `-e ${repoB}`,
            `-e ${repoA}`,
            `-e ${repoB}`,
        ]);

        daemon.kill("SIGTERM");
        expect(await daemon.exited).toBe(0);
        daemon = undefined;
    } finally {
        if (daemon !== undefined && daemon.exitCode === null) {
            daemon.kill("SIGKILL");
            await daemon.exited;
        }
        recorder.close();
        herdr.close();
        await rm(directory, { force: true, recursive: true });
    }
}, 15_000);
