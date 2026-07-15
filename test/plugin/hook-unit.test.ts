import { expect, test, vi } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeHookNotification, HookStartupError, runHook } from "../../src/plugin/hook.ts";
import type { HookControlApi } from "../../src/plugin/hook.ts";
import {
    ControlProtocolError,
    ControlUnavailable,
    UnsafeControlSocket,
} from "../../src/plugin/control.ts";
import type { HookNotification } from "../../src/plugin/protocol.ts";

const expectNotification = (
    notification: HookNotification | undefined,
    workspaceId: string,
    cwd: string,
): void => {
    expect(
        notification?.workspaceId === undefined ? undefined : String(notification.workspaceId),
    ).toBe(workspaceId);
    expect(notification?.cwd).toBe(cwd);
};

const hookEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        data: { workspace: { workspace_id: "event-workspace" } },
    }),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/repos/event" }),
    HERDR_WORKSPACE_ID: "environment-workspace",
    ...overrides,
});
const temporaryDirectory = (): Promise<string> => mkdtemp(join(tmpdir(), "zed-herdr-hook-"));

const unavailable = async (): Promise<void> => {
    throw new ControlUnavailable("/control.sock", "connect");
};

const controlFor = (
    path: string,
    notify: HookControlApi["notifyControl"],
    prepare: HookControlApi["prepareControlSocket"] = async () => undefined,
    prepareDirectory: HookControlApi["prepareControlSocketDirectory"] = async () => undefined,
): HookControlApi => ({
    controlSocketPath: () => path,
    notifyControl: notify,
    prepareControlSocket: prepare,
    prepareControlSocketDirectory: prepareDirectory,
});

test("declares the official HerdR v0.7.3 plugin manifest", async () => {
    const manifest = await readFile(join(import.meta.dir, "../../herdr-plugin.toml"), "utf8");

    expect(Bun.TOML.parse(manifest)).toEqual({
        id: "dev.zed-herdr",
        name: "Zed Workspace Sync",
        version: "0.1.0",
        min_herdr_version: "0.7.3",
        platforms: ["macos", "linux"],
        build: [
            { command: ["bun", "install", "--frozen-lockfile"] },
            { command: ["bun", "run", "build"] },
        ],
        events: [
            { on: "workspace.created", command: ["bun", "./dist/index.js", "hook"] },
            { on: "workspace.focused", command: ["bun", "./dist/index.js", "hook"] },
        ],
        panes: [
            {
                id: "daemon",
                title: "Zed Workspace Sync",
                placement: "tab",
                command: ["bun", "./dist/index.js", "daemon"],
            },
        ],
    });
});

test("uses documented event workspace payloads before HERDR_WORKSPACE_ID and context cwd", async () => {
    expectNotification(
        decodeHookNotification(hookEnvironment()),
        "event-workspace",
        "/repos/event",
    );
    expectNotification(
        decodeHookNotification(
            hookEnvironment({
                HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
                    data: { workspace_id: "focused-workspace" },
                }),
                HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/repos/focused" }),
            }),
        ),
        "focused-workspace",
        "/repos/focused",
    );
    expectNotification(
        decodeHookNotification(
            hookEnvironment({
                HERDR_PLUGIN_EVENT_JSON: "{}",
                HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/repos/context" }),
            }),
        ),
        "environment-workspace",
        "/repos/context",
    );
    expect(
        decodeHookNotification(
            hookEnvironment({
                HERDR_PLUGIN_CONTEXT_JSON: "{}",
                PWD: "/must-not-be-used",
            }),
        ),
    ).toBeUndefined();
});

test("rejects invalid or incomplete event and context hook payload schemas", async () => {
    const environmentWithoutFallback = {
        ...hookEnvironment(),
        HERDR_WORKSPACE_ID: undefined,
    };

    for (const environment of [
        {
            ...environmentWithoutFallback,
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { workspace_id: 1 } }),
        },
        {
            ...environmentWithoutFallback,
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: {} }),
        },
        {
            ...environmentWithoutFallback,
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
                data: { workspace: { workspace_id: "" } },
            }),
        },
        {
            ...environmentWithoutFallback,
            HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "" }),
        },
        {
            ...environmentWithoutFallback,
            HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({}),
        },
    ]) {
        expect(decodeHookNotification(environment)).toBeUndefined();
    }
});

test("notifies an existing daemon without opening a pane", async () => {
    const directory = await temporaryDirectory();
    try {
        const notifications: Array<unknown> = [];
        let opens = 0;
        const result = await runHook({
            control: controlFor(join(directory, "control.sock"), async (_path, notification) => {
                notifications.push(notification);
            }),
            environment: hookEnvironment(),
            openPane: async () => {
                opens += 1;
            },
        });

        expect(result).toEqual({ _tag: "Notified", openedPane: false });
        expect(opens).toBe(0);
        expect(notifications).toEqual([{ workspaceId: "event-workspace", cwd: "/repos/event" }]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("bounds a stalled existing control socket within the single hook deadline", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const timeouts: Array<number | undefined> = [];
        let now = 0;
        let opens = 0;
        const control = controlFor(path, async (_path, _notification, timeoutMs) => {
            timeouts.push(timeoutMs);
            now += timeoutMs ?? 0;
            await unavailable();
        });

        await expect(
            runHook({
                control,
                environment: hookEnvironment(),
                now: () => now,
                openPane: async () => {
                    opens += 1;
                },
            }),
        ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "readiness" });
        expect(timeouts).toEqual([1_500]);
        expect(opens).toBe(0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("does not invoke an opener after the shared deadline expires", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        let now = 0;
        let notifications = 0;
        let opens = 0;
        const control = controlFor(path, async () => {
            notifications += 1;
            if (notifications === 2) {
                now = 1_500;
            }
            await unavailable();
        });

        await expect(
            runHook({
                control,
                environment: hookEnvironment(),
                now: () => now,
                openPane: async () => {
                    opens += 1;
                },
            }),
        ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "readiness" });
        expect(opens).toBe(0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("propagates protocol and unsafe control errors without retrying or opening a pane", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        for (const failure of [
            new ControlProtocolError(path, "malformed response"),
            new UnsafeControlSocket(path, "unsafe_mode"),
        ]) {
            let notifications = 0;
            let opens = 0;

            await expect(
                runHook({
                    control: controlFor(path, async () => {
                        notifications += 1;
                        throw failure;
                    }),
                    environment: hookEnvironment(),
                    openPane: async () => {
                        opens += 1;
                    },
                }),
            ).rejects.toBe(failure);
            expect(notifications).toBe(1);
            expect(opens).toBe(0);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("rejects an unsafe control parent before attempting notification or pane opening", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const failure = new UnsafeControlSocket(path, "unsafe_parent");
        let directoryPreparations = 0;
        let notifications = 0;
        let opens = 0;

        await expect(
            runHook({
                control: controlFor(
                    path,
                    async () => {
                        notifications += 1;
                    },
                    async () => undefined,
                    async () => {
                        directoryPreparations += 1;
                        throw failure;
                    },
                ),
                environment: hookEnvironment(),
                openPane: async () => {
                    opens += 1;
                },
            }),
        ).rejects.toBe(failure);
        expect(directoryPreparations).toBe(1);
        expect(notifications).toBe(0);
        expect(opens).toBe(0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("opens the exact unfocused daemon argv once while twenty hooks contend", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const opening = Promise.withResolvers<void>();
        const opened = Promise.withResolvers<void>();
        const argv: Array<ReadonlyArray<string>> = [];
        const notifications: Array<unknown> = [];
        let ready = false;
        const control = controlFor(path, async (_path, notification) => {
            if (!ready) {
                await unavailable();
            }
            notifications.push(notification);
        });

        const runs = Array.from({ length: 20 }, () =>
            runHook({
                control,
                environment: hookEnvironment({ HERDR_BIN_PATH: "/custom/herdr" }),
                openPane: async (command) => {
                    argv.push(command);
                    opening.resolve();
                    await opened.promise;
                    ready = true;
                },
            }),
        );
        await opening.promise;
        opened.resolve();

        expect(await Promise.all(runs)).toHaveLength(20);
        expect(argv).toEqual([
            [
                "/custom/herdr",
                "plugin",
                "pane",
                "open",
                "--plugin",
                "dev.zed-herdr",
                "--entrypoint",
                "daemon",
                "--placement",
                "tab",
                "--workspace",
                "event-workspace",
                "--no-focus",
            ],
        ]);
        expect(notifications).toHaveLength(20);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("fails closed on a non-owner-only canonical lock directory", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const lockPath = `${path}.lock`;
        await mkdir(lockPath, { mode: 0o700 });
        await chmod(lockPath, 0o755);

        await expect(
            runHook({
                control: controlFor(path, unavailable),
                environment: hookEnvironment(),
            }),
        ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "lock" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("rejects invalid and incomplete lock owner schemas", async () => {
    const directory = await temporaryDirectory();
    try {
        const invalidLocks = [
            { pid: "not-an-integer", token: "invalid-owner", createdAt: Date.now() },
            { pid: 1, token: "incomplete-owner" },
        ];

        for (const [index, contents] of invalidLocks.entries()) {
            const path = join(directory, `control-${index}.sock`);
            const lockPath = `${path}.lock`;
            const token = contents.token;
            await mkdir(lockPath, { mode: 0o700 });
            await chmod(lockPath, 0o700);
            await writeFile(join(lockPath, `${token}.json`), JSON.stringify(contents), {
                mode: 0o600,
            });
            await chmod(join(lockPath, `${token}.json`), 0o600);

            let opens = 0;
            await expect(
                runHook({
                    control: controlFor(path, unavailable),
                    environment: hookEnvironment(),
                    openPane: async () => {
                        opens += 1;
                    },
                }),
            ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "lock" });
            expect(opens).toBe(0);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("takes over a stale lock and never releases a resumed holder token", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const lockPath = `${path}.lock`;
        await mkdir(lockPath, { mode: 0o700 });
        await chmod(lockPath, 0o700);
        await writeFile(
            join(lockPath, "stale-token.json"),
            JSON.stringify({ pid: 1, token: "stale-token", createdAt: Date.now() - 5_001 }),
            { mode: 0o600 },
        );
        await chmod(join(lockPath, "stale-token.json"), 0o600);
        let ready = false;
        const control = controlFor(path, async () => {
            if (!ready) {
                await unavailable();
            }
        });

        await runHook({
            control,
            environment: hookEnvironment(),
            token: () => "owner-token",
            openPane: async () => {
                await rm(join(lockPath, "owner-token.json"));
                await writeFile(
                    join(lockPath, "resumed-token.json"),
                    JSON.stringify({ pid: 2, token: "resumed-token", createdAt: Date.now() }),
                );
                await chmod(join(lockPath, "resumed-token.json"), 0o600);
                ready = true;
            },
        });

        expect(
            JSON.parse(await readFile(join(lockPath, "resumed-token.json"), "utf8")),
        ).toMatchObject({
            token: "resumed-token",
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("takes over a stale empty lock directory without treating a fresh pending directory as stale", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const lockPath = `${path}.lock`;
        await mkdir(lockPath, { mode: 0o700 });
        const stale = new Date(Date.now() - 5_001);
        await utimes(lockPath, stale, stale);
        let ready = false;
        let opens = 0;

        await runHook({
            control: controlFor(path, async () => {
                if (!ready) {
                    await unavailable();
                }
            }),
            environment: hookEnvironment(),
            openPane: async () => {
                opens += 1;
                ready = true;
            },
        });

        expect(opens).toBe(1);
        await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("retries ControlUnavailable through the 1.5-second readiness deadline and releases its lock", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        let now = 0;
        let notifications = 0;
        let sleeps = 0;
        let opens = 0;
        const control = controlFor(path, async () => {
            notifications += 1;
            await unavailable();
        });

        await expect(
            runHook({
                control,
                environment: hookEnvironment(),
                now: () => now,
                sleep: async (milliseconds) => {
                    sleeps += 1;
                    now += milliseconds;
                },
                openPane: async () => {
                    opens += 1;
                },
            }),
        ).rejects.toMatchObject({ _tag: "HookStartupError", operation: "readiness" });
        expect(now).toBe(1_500);
        expect(sleeps).toBe(60);
        expect(notifications).toBe(62);
        expect(opens).toBe(1);
        await expect(readFile(`${path}.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("bounds a hanging injected pane opener by the shared readiness deadline", async () => {
    const directory = await temporaryDirectory();
    vi.useFakeTimers();
    try {
        const path = join(directory, "control.sock");
        const opening = Promise.withResolvers<void>();
        const never = Promise.withResolvers<void>();
        const execution = runHook({
            control: controlFor(path, unavailable),
            environment: hookEnvironment(),
            openPane: async () => {
                opening.resolve();
                await never.promise;
            },
        });

        await opening.promise;
        vi.advanceTimersByTime(1_500);
        await expect(execution).rejects.toMatchObject({
            _tag: "HookStartupError",
            operation: "readiness",
        });
        await expect(readFile(`${path}.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        vi.useRealTimers();
        await rm(directory, { recursive: true, force: true });
    }
});
test("surfaces pane command failures without leaving its lock behind", async () => {
    const directory = await temporaryDirectory();
    try {
        const path = join(directory, "control.sock");
        const control = controlFor(path, unavailable);

        await expect(
            runHook({
                control,
                environment: hookEnvironment(),
                openPane: async () => {
                    throw new HookStartupError("open_pane", "herdr failed");
                },
            }),
        ).rejects.toThrow("herdr failed");
        await expect(readFile(`${path}.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
