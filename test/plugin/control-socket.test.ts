import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";

import { HookNotification } from "../../src/plugin/protocol.ts";
import {
    AlreadyRunning,
    CONTROL_SOCKET_MAX_BYTES,
    CONTROL_SOCKET_MODE,
    ControlProtocolError,
    UnsafeControlSocket,
    controlSocketPath,
    healthControl,
    notifyControl,
    prepareControlSocket,
    probeControlSocket,
    startControlServer,
} from "../../src/plugin/control.ts";

const makeTemporaryDirectory = (): Promise<string> => mkdtemp(`${tmpdir()}/zed-herdr-control-`);

const rawRequest = async (
    path: string,
    chunks: ReadonlyArray<string | Uint8Array>,
): Promise<string> =>
    new Promise<string>((resolveResponse, rejectResponse) => {
        const decoder = new TextDecoder();
        const requestChunks = chunks.flatMap((chunk) => {
            const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
            const parts: Array<Uint8Array> = [];
            for (let offset = 0; offset < bytes.byteLength; offset += 8 * 1024) {
                parts.push(bytes.slice(offset, offset + 8 * 1024));
            }
            return parts;
        });
        let buffer = "";
        let chunkIndex = 0;
        let chunkOffset = 0;
        let settled = false;
        const finish = (operation: () => void): void => {
            if (!settled) {
                settled = true;
                operation();
            }
        };
        const writeRequest = (socket: Bun.Socket<undefined>): void => {
            while (chunkIndex < requestChunks.length) {
                const chunk = requestChunks[chunkIndex];
                if (chunk === undefined) {
                    return;
                }
                const written = socket.write(chunk, chunkOffset);
                if (written < 0) {
                    finish(() => rejectResponse(new Error("control socket closed while writing")));
                    return;
                }
                chunkOffset += written;
                if (chunkOffset < chunk.byteLength) {
                    return;
                }
                chunkIndex += 1;
                chunkOffset = 0;
            }
        };

        void Bun.connect({
            unix: path,
            socket: {
                data(socket, chunk) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const newline = buffer.indexOf("\n");
                    if (newline >= 0) {
                        finish(() => resolveResponse(buffer.slice(0, newline)));
                        socket.end();
                    }
                },
                drain(socket) {
                    writeRequest(socket);
                },
                close(_socket, error) {
                    if (error !== null && error !== undefined) {
                        finish(() => rejectResponse(error));
                    } else {
                        finish(() =>
                            rejectResponse(new Error("control socket closed before responding")),
                        );
                    }
                },
                error(_socket, error) {
                    finish(() => rejectResponse(error));
                },
            },
        }).then(writeRequest, (error: unknown) => finish(() => rejectResponse(error)));
    });

const withControlServer = async (
    body: (path: string, notifications: Array<HookNotification>) => Promise<void>,
): Promise<void> => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/control.sock`;
    const notifications: Array<HookNotification> = [];
    const server = await startControlServer({
        path,
        paneId: "daemon-pane",
        notifications: {
            publish(notification) {
                notifications.push(notification);
            },
        },
    });

    try {
        await body(path, notifications);
    } finally {
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
};

test("derives a uid-and-resolved-HerdR-socket control path", () => {
    const herdRSocket = "/tmp/../tmp/herdr/session.sock";
    const digest = createHash("sha256").update(resolve(herdRSocket)).digest("hex").slice(0, 16);
    const uid = process.getuid?.();
    if (uid === undefined) {
        throw new Error("control sockets require a POSIX uid");
    }

    expect(controlSocketPath({ HERDR_SOCKET_PATH: herdRSocket })).toBe(
        `/tmp/zed-herdr-${uid}-${digest}.sock`,
    );
});

test("returns exact health and notify responses without trusting client pane fields", async () => {
    await withControlServer(async (path, notifications) => {
        const health = await rawRequest(path, [
            JSON.stringify({ type: "health", paneId: "attacker-pane" }),
            "\n",
        ]);
        const decodedHealth = JSON.parse(health) as {
            readonly ok: boolean;
            readonly daemon: {
                readonly identity: string;
                readonly paneId: string;
                readonly pid: number;
                readonly startedAt: string;
            };
        };
        expect(decodedHealth.ok).toBe(true);
        expect(decodedHealth.daemon.identity).toBe("dev.zed-herdr:daemon");
        expect(decodedHealth.daemon.paneId).toBe("daemon-pane");
        expect(decodedHealth.daemon.pid).toBe(process.pid);
        expect(decodedHealth.daemon.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        const notification = Schema.decodeUnknownSync(HookNotification)({
            workspaceId: "workspace-1",
            cwd: "/repo/one",
        });
        expect(
            await rawRequest(path, [JSON.stringify({ type: "notify", notification }), "\n"]),
        ).toBe('{"ok":true}');
        await notifyControl(path, notification);
        expect(notifications).toEqual([notification, notification]);

        const daemon = await healthControl(path);
        expect(daemon).toMatchObject({
            identity: "dev.zed-herdr:daemon",
            paneId: "daemon-pane",
            pid: process.pid,
        });
    });
});

test("incrementally decodes split unicode requests on concurrent sockets", async () => {
    await withControlServer(async (path, notifications) => {
        const first = JSON.stringify({
            type: "notify",
            notification: { workspaceId: "first", cwd: "/repo/😀" },
        });
        const second = JSON.stringify({
            type: "notify",
            notification: { workspaceId: "second", cwd: "/repo/é" },
        });
        const firstBytes = new TextEncoder().encode(`${first}\n`);
        const secondBytes = new TextEncoder().encode(`${second}\n`);

        const [firstResponse, secondResponse] = await Promise.all([
            rawRequest(path, [firstBytes.slice(0, firstBytes.length - 2), firstBytes.slice(-2)]),
            rawRequest(path, [secondBytes.slice(0, secondBytes.length - 1), secondBytes.slice(-1)]),
        ]);
        expect(firstResponse).toBe('{"ok":true}');
        expect(secondResponse).toBe('{"ok":true}');
        expect(notifications).toContainEqual(
            Schema.decodeUnknownSync(HookNotification)({ workspaceId: "first", cwd: "/repo/😀" }),
        );
        expect(notifications).toContainEqual(
            Schema.decodeUnknownSync(HookNotification)({ workspaceId: "second", cwd: "/repo/é" }),
        );
    });
});

test("uses owner-only mode and rejects invalid or oversized frames", async () => {
    await withControlServer(async (path, notifications) => {
        expect((await lstat(path)).mode & 0o777).toBe(CONTROL_SOCKET_MODE);
        expect(await rawRequest(path, ["{invalid}\n"])).toBe(
            '{"ok":false,"error":"invalid_request"}',
        );
        expect(await rawRequest(path, [new Uint8Array([0xff, 0x0a])])).toBe(
            '{"ok":false,"error":"invalid_request"}',
        );
        expect(await rawRequest(path, ["x".repeat(CONTROL_SOCKET_MAX_BYTES + 1), "\n"])).toBe(
            '{"ok":false,"error":"payload_too_large"}',
        );
        expect(await rawRequest(path, ["x".repeat(CONTROL_SOCKET_MAX_BYTES), "\n"])).toBe(
            '{"ok":false,"error":"invalid_request"}',
        );
        expect(await rawRequest(path, ["x".repeat(CONTROL_SOCKET_MAX_BYTES), "\r", "\n"])).toBe(
            '{"ok":false,"error":"invalid_request"}',
        );
        expect(
            await rawRequest(path, [
                `${JSON.stringify({
                    type: "notify",
                    notification: { workspaceId: "workspace", cwd: "/repo" },
                })}\nextra`,
            ]),
        ).toBe('{"ok":false,"error":"invalid_request"}');
        expect(notifications).toEqual([]);
    });
});

test("rejects a synchronously failing notification publisher", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/publisher-failure.sock`;
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: {
            publish() {
                throw new Error("publisher failure");
            },
        },
    });

    try {
        expect(
            await rawRequest(path, [
                JSON.stringify({
                    type: "notify",
                    notification: { workspaceId: "workspace", cwd: "/repo" },
                }),
                "\n",
            ]),
        ).toBe('{"ok":false,"error":"invalid_request"}');
    } finally {
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
});

test("rejects an oversized daemon pane id before binding", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/invalid-pane.sock`;

    try {
        await expect(
            startControlServer({
                path,
                paneId: "x".repeat(4_097),
                notifications: { publish() {} },
            }),
        ).rejects.toBeInstanceOf(ControlProtocolError);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("refuses live and unsafe paths while recovering an unbound socket pathname", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/control.sock`;
    const live = await startControlServer({ path, paneId: null, notifications: { publish() {} } });

    try {
        await expect(prepareControlSocket(path)).rejects.toBeInstanceOf(AlreadyRunning);
    } finally {
        await live.close();
    }

    const liveTarget = `${directory}/live-target.sock`;
    const liveTargetServer = await startControlServer({
        path: liveTarget,
        paneId: null,
        notifications: { publish() {} },
    });
    await symlink(liveTarget, path);
    try {
        await expect(prepareControlSocket(path)).rejects.toMatchObject({
            _tag: "UnsafeControlSocket",
            reason: "symlink",
        } satisfies Partial<UnsafeControlSocket>);
        await expect(healthControl(path)).rejects.toMatchObject({
            _tag: "UnsafeControlSocket",
            reason: "symlink",
        } satisfies Partial<UnsafeControlSocket>);
    } finally {
        await unlink(path);
        await liveTargetServer.close();
    }

    await writeFile(path, "not a socket");
    await expect(prepareControlSocket(path)).rejects.toMatchObject({
        _tag: "UnsafeControlSocket",
        reason: "not_socket",
    } satisfies Partial<UnsafeControlSocket>);
    await unlink(path);

    const target = `${directory}/target`;
    await writeFile(target, "target");
    await symlink(target, path);
    await expect(prepareControlSocket(path)).rejects.toMatchObject({
        _tag: "UnsafeControlSocket",
        reason: "symlink",
    } satisfies Partial<UnsafeControlSocket>);
    await unlink(path);

    await expect(prepareControlSocket(path)).resolves.toBeUndefined();
    await rm(directory, { force: true, recursive: true });
});

test("atomically removes a current-user orphan socket without touching its pathname race", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/control.sock`;
    const originalPath = `${directory}/orphan-source.sock`;
    const listener = Bun.listen({
        unix: originalPath,
        socket: {
            data() {},
        },
    });
    await link(originalPath, path);
    listener.stop(true);

    try {
        await prepareControlSocket(path);
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("fails closed on an ambiguous liveness probe error", async () => {
    const deniedConnector = {
        connect() {
            return Promise.reject(
                Object.assign(new Error("permission denied"), { code: "EACCES" }),
            );
        },
    };

    await expect(
        probeControlSocket("/tmp/zed-herdr-ambiguous.sock", 150, deniedConnector),
    ).rejects.toMatchObject({
        _tag: "UnsafeControlSocket",
        reason: "probe_failed",
    } satisfies Partial<UnsafeControlSocket>);
});

test("rejects a newline-terminated oversized control response", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/oversized-response.sock`;
    const encodedResponse = new TextEncoder().encode(
        `${"x".repeat(CONTROL_SOCKET_MAX_BYTES + 1)}\n`,
    );
    const responseChunks: Array<Uint8Array> = [];
    for (let offset = 0; offset < encodedResponse.byteLength; offset += 8 * 1024) {
        responseChunks.push(encodedResponse.slice(offset, offset + 8 * 1024));
    }
    const writeResponse = (socket: Bun.Socket<{ offset: number }>): void => {
        while (socket.data.offset < responseChunks.length) {
            const responseChunk = responseChunks[socket.data.offset];
            if (responseChunk === undefined) {
                return;
            }
            const written = socket.write(responseChunk);

            if (written < responseChunk.byteLength) {
                return;
            }
            socket.data.offset += 1;
        }
        socket.end();
    };
    const listener = Bun.listen<{ offset: number }>({
        unix: path,
        socket: {
            open(socket) {
                socket.data = { offset: 0 };
            },
            data(socket) {
                writeResponse(socket);
            },
            drain(socket) {
                writeResponse(socket);
            },
        },
    });

    try {
        await expect(healthControl(path)).rejects.toBeInstanceOf(ControlProtocolError);
    } finally {
        listener.stop(true);
        await rm(directory, { force: true, recursive: true });
    }
});

test("rejects a notify acknowledgement carrying malformed daemon fields", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/malformed-notify.sock`;
    const listener = Bun.listen({
        unix: path,
        socket: {
            data(socket) {
                socket.end('{"ok":true,"daemon":"spoofed"}\n');
            },
        },
    });
    const notification = Schema.decodeUnknownSync(HookNotification)({
        workspaceId: "workspace",
        cwd: "/repo",
    });

    try {
        await expect(notifyControl(path, notification)).rejects.toBeInstanceOf(
            ControlProtocolError,
        );
    } finally {
        listener.stop(true);
        await rm(directory, { force: true, recursive: true });
    }
});

test("finalization never unlinks a replacement inode", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/control.sock`;
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: { publish() {} },
    });

    await unlink(path);
    await writeFile(path, "replacement");
    await server.close();
    expect(await readFile(path, "utf8")).toBe("replacement");
    await rm(directory, { force: true, recursive: true });
});

test("finalization restores a symlink replacement without dereferencing it", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/control.sock`;
    const target = `${directory}/replacement-target`;
    await writeFile(target, "replacement");
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: { publish() {} },
    });

    await unlink(path);
    await symlink(target, path);
    await server.close();
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(path, "utf8")).toBe("replacement");
    await rm(directory, { force: true, recursive: true });
});
