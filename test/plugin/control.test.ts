import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { runCli } from "../../src/cli.ts";
import {
    CONTROL_DAEMON_IDENTITY,
    controlSocketPath,
    notifyControl,
    prepareControlSocketDirectory,
    startControlServer,
} from "../../src/plugin/control.ts";
import type { ControlServer } from "../../src/plugin/control.ts";
import { runHook } from "../../src/plugin/hook.ts";
import { HealthControlResponse, HookNotification } from "../../src/plugin/protocol.ts";

interface CliObservation {
    readonly exitCode: typeof process.exitCode;
    readonly stderr: ReadonlyArray<string>;
    readonly stdout: ReadonlyArray<string>;
}

interface IsolatedCliObservation {
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
}

const makeTemporaryDirectory = (): Promise<string> =>
    mkdtemp(join(tmpdir(), "zed-herdr-control-integration-"));

const controlEnvironment = (
    herdrSocket: string,
    overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
    HERDR_SOCKET_PATH: herdrSocket,
    ...overrides,
});

const hookEnvironment = (herdrSocket: string): NodeJS.ProcessEnv => ({
    ...controlEnvironment(herdrSocket),
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        data: { workspace: { workspace_id: "integration-workspace" } },
    }),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/repo/integration" }),
});

const createOrphanedSocket = async (path: string): Promise<void> => {
    await prepareControlSocketDirectory(path);
    const child = Bun.spawn({
        cmd: [
            process.execPath,
            "-e",
            [
                "const listener = Bun.listen({ unix: process.argv[1], socket: { data() {} } });",
                'console.log("ready");',
                "process.stdin.resume();",
            ].join(" "),
            path,
        ],
        stderr: "pipe",
        stdout: "pipe",
    });
    const reader = child.stdout.getReader();

    try {
        const { done, value } = await reader.read();
        if (done || value === undefined) {
            throw new Error("orphan socket listener exited before readiness");
        }
        expect(new TextDecoder().decode(value).trim()).toBe("ready");
    } finally {
        child.kill("SIGKILL");
        await child.exited;
    }

    const uid = process.getuid?.();
    if (uid === undefined) {
        throw new Error("control sockets require a POSIX uid");
    }
    const stat = await lstat(path);
    expect(stat.isSocket()).toBe(true);
    expect(stat.uid).toBe(uid);
};

const runHealthCli = async (environment: NodeJS.ProcessEnv): Promise<CliObservation> => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];

    console.log = (...values: Array<unknown>) => {
        stdout.push(values.map(String).join(" "));
    };
    console.error = (...values: Array<unknown>) => {
        stderr.push(values.map(String).join(" "));
    };

    try {
        process.exitCode = undefined;
        await Effect.runPromise(runCli(["health"], environment));
        return { exitCode: process.exitCode, stderr, stdout };
    } finally {
        console.log = originalLog;
        console.error = originalError;
        process.exitCode = originalExitCode;
    }
};

const runIsolatedHealthCli = async (herdrSocket: string): Promise<IsolatedCliObservation> => {
    const child = Bun.spawn({
        cmd: [process.execPath, "index.ts", "health"],
        env: { ...process.env, HERDR_SOCKET_PATH: herdrSocket },
        stderr: "pipe",
        stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { exitCode, stderr, stdout };
};

test("health CLI reports the real daemon and rejects absent or invalid control sockets", async () => {
    const directory = await makeTemporaryDirectory();
    const herdrSocket = join(directory, "herdr.sock");
    const path = controlSocketPath(controlEnvironment(herdrSocket));
    let server: ControlServer | undefined;

    try {
        const started = await startControlServer({
            path,
            paneId: "injected-daemon-pane",
            notifications: { async publish() {} },
        });
        server = started;

        const healthy = await runHealthCli(controlEnvironment(herdrSocket));
        const expectedResponse = { ok: true as const, daemon: started.daemon };
        expect(healthy.exitCode).toBeUndefined();
        expect(healthy.stderr).toEqual([]);
        expect(healthy.stdout).toEqual([JSON.stringify(expectedResponse)]);
        const response = Schema.decodeUnknownSync(HealthControlResponse)(
            JSON.parse(healthy.stdout[0] ?? ""),
        );
        expect(response).toEqual(expectedResponse);
        expect(response.daemon.identity).toBe(CONTROL_DAEMON_IDENTITY);
        expect(response.daemon.paneId).toBe("injected-daemon-pane");

        await server.close();
        server = undefined;

        const absent = await runIsolatedHealthCli(herdrSocket);
        expect(absent.exitCode).toBe(1);
        expect(absent.stdout).toBe("");

        await writeFile(path, "not a socket", { mode: 0o600 });
        const invalid = await runIsolatedHealthCli(herdrSocket);
        expect(invalid.exitCode).toBe(1);
        expect(invalid.stdout).toBe("");
    } finally {
        await server?.close();
        await rm(path, { force: true });
        await rm(directory, { force: true, recursive: true });
    }
}, 3_000);

test("direct daemon startup replaces an orphaned socket and cleans its bound inode", async () => {
    const directory = await makeTemporaryDirectory();
    const herdrSocket = join(directory, "herdr.sock");
    const path = controlSocketPath(controlEnvironment(herdrSocket));
    let server: ControlServer | undefined;

    try {
        await createOrphanedSocket(path);
        server = await startControlServer({
            path,
            paneId: null,
            notifications: { async publish() {} },
        });

        const bound = await lstat(path);
        expect(bound.isSocket()).toBe(true);
        expect(await readFile(`${path}.lock`, "utf8").catch(() => undefined)).toBeUndefined();

        await server.close();
        server = undefined;
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await server?.close();
        await rm(path, { force: true });
        await rm(directory, { force: true, recursive: true });
    }
}, 3_000);

test("hook recovers an orphan, opens one daemon, waits for readiness, and publishes its cwd hint", async () => {
    const directory = await makeTemporaryDirectory();
    const herdrSocket = join(directory, "herdr.sock");
    const environment = hookEnvironment(herdrSocket);
    const path = controlSocketPath(environment);
    const notifications: Array<HookNotification> = [];
    const paneCommands: Array<ReadonlyArray<string>> = [];
    let server: ControlServer | undefined;

    try {
        await createOrphanedSocket(path);

        const result = await runHook({
            environment,
            openPane: async (command) => {
                paneCommands.push(command);
                server = await startControlServer({
                    path,
                    paneId: "hook-created-pane",
                    notifications: {
                        async publish(notification) {
                            notifications.push(notification);
                        },
                    },
                });
            },
        });

        expect(result).toEqual({ _tag: "Notified", openedPane: true });
        expect(paneCommands).toEqual([
            [
                "herdr",
                "plugin",
                "pane",
                "open",
                "--plugin",
                "artisann.zed-herdr",
                "--entrypoint",
                "daemon",
                "--placement",
                "tab",
                "--workspace",
                "integration-workspace",
                "--no-focus",
            ],
        ]);
        expect(notifications).toEqual([
            Schema.decodeUnknownSync(HookNotification)({
                workspaceId: "integration-workspace",
                cwd: "/repo/integration",
            }),
        ]);
        await expect(readFile(`${path}.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await server?.close();
        await unlink(`${path}.lock`).catch(() => undefined);
        await rm(path, { force: true });
        await rm(directory, { force: true, recursive: true });
    }
}, 3_000);

test("buffers a control notification received before hint stream consumption", async () => {
    const directory = await makeTemporaryDirectory();
    const herdrSocket = join(directory, "herdr.sock");
    const path = controlSocketPath(controlEnvironment(herdrSocket));
    const queue = await Effect.runPromise(Queue.unbounded<HookNotification>());
    let server: ControlServer | undefined;

    try {
        server = await startControlServer({
            path,
            paneId: null,
            notifications: {
                async publish(notification) {
                    await Effect.runPromise(Queue.offer(queue, notification).pipe(Effect.asVoid));
                },
            },
        });

        const notification = Schema.decodeUnknownSync(HookNotification)({
            workspaceId: "early-workspace",
            cwd: "/repo/early",
        });
        await notifyControl(path, notification);

        let received: HookNotification | undefined;
        await Effect.runPromise(
            Stream.runForEach(Stream.fromQueue(queue).pipe(Stream.take(1)), (hint) =>
                Effect.sync(() => {
                    received = hint;
                }),
            ),
        );
        expect(received).toEqual(notification);
    } finally {
        await server?.close();
        await Effect.runPromise(Queue.shutdown(queue));
        await rm(path, { force: true });
        await rm(directory, { force: true, recursive: true });
    }
});
