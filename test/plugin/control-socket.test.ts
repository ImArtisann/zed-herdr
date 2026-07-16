import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    chmod,
    chown,
    link,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    prepareControlSocketDirectory,
    probeControlSocket,
    startControlServer,
    toggleControl,
} from "../../src/plugin/control.ts";

const makeTemporaryDirectory = (): Promise<string> => mkdtemp(`${tmpdir()}/zed-herdr-control-`);

const rawRequest = async (
    path: string,
    chunks: ReadonlyArray<string | Uint8Array>,
): Promise<string> =>
    new Promise<string>((resolveResponse, rejectResponse) => {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const requestGroups = chunks.map((chunk) => {
            const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
            const parts: Array<Uint8Array> = [];
            for (let offset = 0; offset < bytes.byteLength; offset += 8 * 1024) {
                parts.push(bytes.slice(offset, offset + 8 * 1024));
            }
            return parts;
        });
        let buffer = "";
        let groupIndex = 0;
        let chunkIndex = 0;
        let chunkOffset = 0;
        let settled = false;
        const finish = (operation: () => void): void => {
            if (!settled) {
                settled = true;
                operation();
            }
        };
        const finishResponse = (): void => {
            try {
                buffer += decoder.decode();
            } catch (error) {
                finish(() => rejectResponse(error));
                return;
            }
            if (!buffer.endsWith("\n")) {
                finish(() =>
                    rejectResponse(new Error("control socket ended without a response frame")),
                );
                return;
            }
            finish(() => resolveResponse(buffer.slice(0, -1)));
        };
        const writeRequest = (socket: Bun.Socket<undefined>): void => {
            while (groupIndex < requestGroups.length) {
                const requestGroup = requestGroups[groupIndex];
                if (requestGroup === undefined) {
                    return;
                }
                while (chunkIndex < requestGroup.length) {
                    const chunk = requestGroup[chunkIndex];
                    if (chunk === undefined) {
                        return;
                    }
                    const written = socket.write(chunk, chunkOffset);
                    if (written < 0) {
                        finish(() =>
                            rejectResponse(new Error("control socket closed while writing")),
                        );
                        return;
                    }
                    chunkOffset += written;
                    if (chunkOffset < chunk.byteLength) {
                        return;
                    }
                    chunkIndex += 1;
                    chunkOffset = 0;
                }
                groupIndex += 1;
                chunkIndex = 0;
            }
        };

        void Bun.connect({
            unix: path,
            allowHalfOpen: true,
            socket: {
                data(_socket, chunk) {
                    try {
                        buffer += decoder.decode(chunk, { stream: true });
                    } catch (error) {
                        finish(() => rejectResponse(error));
                    }
                },
                end() {
                    finishResponse();
                },
                drain(socket) {
                    writeRequest(socket);
                },
                close(_socket, error) {
                    if (error !== null && error !== undefined) {
                        finish(() => rejectResponse(error));
                    } else {
                        finishResponse();
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
    let enabled = true;
    const server = await startControlServer({
        path,
        paneId: "daemon-pane",
        notifications: {
            async publish(notification) {
                notifications.push(notification);
            },
        },
        toggleEnabled() {
            enabled = !enabled;
            return enabled;
        },
    });

    try {
        await body(path, notifications);
    } finally {
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
};

test("derives XDG and HerdR-directory control socket paths", () => {
    const herdRSocket = "/tmp/../tmp/herdr/session.sock";
    const resolvedHerdRSocket = resolve(herdRSocket);
    const digest = createHash("sha256").update(resolvedHerdRSocket).digest("hex").slice(0, 16);

    expect(
        controlSocketPath({
            HERDR_SOCKET_PATH: herdRSocket,
            XDG_RUNTIME_DIR: "/runtime/user",
        }),
    ).toBe(join("/runtime/user", "zed-herdr", `${digest}.sock`));
    expect(controlSocketPath({ HERDR_SOCKET_PATH: herdRSocket })).toBe(
        join(dirname(resolvedHerdRSocket), "zed-herdr", `${digest}.sock`),
    );
});

test("creates and tightens the owner-only control socket directory", async () => {
    const root = await makeTemporaryDirectory();
    const parent = join(root, "runtime");
    const directory = join(parent, "zed-herdr");
    const path = join(directory, "control.sock");
    const uid = process.getuid?.();

    try {
        await mkdir(parent, { mode: 0o700 });
        await chmod(parent, 0o700);
        await prepareControlSocketDirectory(path);
        expect((await lstat(directory)).isDirectory()).toBe(true);
        expect((await lstat(directory)).mode & 0o777).toBe(0o700);
        if (uid !== undefined) {
            expect((await lstat(directory)).uid).toBe(uid);
        }

        await chmod(directory, 0o755);
        await prepareControlSocketDirectory(path);
        expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("rejects control directories beneath unsafe parents and unsafe directory entries", async () => {
    const root = await makeTemporaryDirectory();
    const unsafeParent = join(root, "unsafe-parent");
    const safeChild = join(unsafeParent, "zed-herdr");
    const safeParent = join(root, "safe-parent");
    const target = join(root, "target");
    const symlinkedChild = join(safeParent, "zed-herdr");

    try {
        await mkdir(unsafeParent, { mode: 0o777 });
        await chmod(unsafeParent, 0o777);
        await mkdir(safeChild, { mode: 0o700 });
        await chmod(safeChild, 0o700);
        await expect(
            prepareControlSocketDirectory(join(safeChild, "existing-child.sock")),
        ).rejects.toMatchObject({
            _tag: "UnsafeControlSocket",
            reason: "unsafe_parent",
        } satisfies Partial<UnsafeControlSocket>);
        await rm(safeChild, { force: true, recursive: true });
        await expect(
            prepareControlSocketDirectory(join(unsafeParent, "zed-herdr", "missing-child.sock")),
        ).rejects.toMatchObject({
            _tag: "UnsafeControlSocket",
            reason: "unsafe_parent",
        } satisfies Partial<UnsafeControlSocket>);

        await mkdir(safeParent, { mode: 0o700 });
        await chmod(safeParent, 0o700);
        await mkdir(target, { mode: 0o700 });
        await chmod(target, 0o700);
        await symlink(target, symlinkedChild);
        await expect(
            prepareControlSocketDirectory(join(symlinkedChild, "symlink.sock")),
        ).rejects.toMatchObject({
            _tag: "UnsafeControlSocket",
            reason: "symlink",
        } satisfies Partial<UnsafeControlSocket>);
        await unlink(symlinkedChild);
        await writeFile(symlinkedChild, "not a directory", { mode: 0o600 });
        await expect(
            prepareControlSocketDirectory(join(symlinkedChild, "file.sock")),
        ).rejects.toMatchObject({
            _tag: "UnsafeControlSocket",
            reason: "not_directory",
        } satisfies Partial<UnsafeControlSocket>);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("rejects a foreign-owned control socket directory when ownership can be changed", async () => {
    const uid = process.getuid?.();
    if (uid !== 0) {
        return;
    }

    const root = await makeTemporaryDirectory();
    const parent = join(root, "runtime");
    const directory = join(parent, "zed-herdr");
    const path = join(directory, "control.sock");

    try {
        await mkdir(parent, { mode: 0o700 });
        await chmod(parent, 0o700);
        await mkdir(directory, { mode: 0o700 });
        await chmod(directory, 0o700);
        await chown(directory, 1, -1);
        await expect(prepareControlSocketDirectory(path)).rejects.toMatchObject({
            _tag: "UnsafeControlSocket",
            reason: "foreign_owner",
        } satisfies Partial<UnsafeControlSocket>);
    } finally {
        await chown(directory, uid, -1).catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    }
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
        expect(decodedHealth.daemon.identity).toBe("artisann.zed-herdr:daemon");
        expect(decodedHealth.daemon.paneId).toBe("daemon-pane");
        expect(decodedHealth.daemon.pid).toBe(process.pid);
        expect(decodedHealth.daemon.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        expect(
            JSON.parse(await rawRequest(path, [JSON.stringify({ type: "health" }), "\r\n"])),
        ).toEqual(decodedHealth);

        const notification = Schema.decodeUnknownSync(HookNotification)({
            workspaceId: "workspace-1",
            cwd: "/repo/one",
        });
        expect(
            await rawRequest(path, [JSON.stringify({ type: "notify", notification }), "\n"]),
        ).toBe('{"ok":true}');
        await notifyControl(path, notification);
        expect(notifications).toEqual([notification, notification]);
        expect(await toggleControl(path)).toBe(false);
        expect(await rawRequest(path, [JSON.stringify({ type: "toggle" }), "\n"])).toBe(
            '{"ok":true,"enabled":true}',
        );

        const daemon = await healthControl(path);
        expect(daemon).toMatchObject({
            identity: "artisann.zed-herdr:daemon",
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
        const validRequest = new TextEncoder().encode(
            `${JSON.stringify({
                type: "notify",
                notification: { workspaceId: "workspace", cwd: "/repo" },
            })}\n`,
        );
        const requestWithBufferedUtf8Suffix = new Uint8Array(validRequest.byteLength + 1);
        requestWithBufferedUtf8Suffix.set(validRequest);
        requestWithBufferedUtf8Suffix[validRequest.byteLength] = 0xf0;
        expect(await rawRequest(path, [requestWithBufferedUtf8Suffix])).toBe(
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
                })}\n`,
                "extra",
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
        ).toBe('{"ok":false,"error":"server_failure"}');
    } finally {
        await server.close();
        await rm(directory, { force: true, recursive: true });
    }
});

test("returns server_failure for an asynchronously rejecting notification publisher", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/publisher-async-failure.sock`;
    const server = await startControlServer({
        path,
        paneId: null,
        notifications: {
            async publish() {
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
        ).toBe('{"ok":false,"error":"server_failure"}');
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
                notifications: { async publish() {} },
            }),
        ).rejects.toBeInstanceOf(ControlProtocolError);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("refuses live and unsafe paths while recovering an unbound socket pathname", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/control.sock`;
    const live = await startControlServer({
        path,
        paneId: null,
        notifications: { async publish() {} },
    });

    try {
        await expect(prepareControlSocket(path)).rejects.toBeInstanceOf(AlreadyRunning);
    } finally {
        await live.close();
    }

    const liveTarget = `${directory}/live-target.sock`;
    const liveTargetServer = await startControlServer({
        path: liveTarget,
        paneId: null,
        notifications: { async publish() {} },
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

test("rejects response bytes written after a completed response frame", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/trailing-response.sock`;
    const listener = Bun.listen({
        unix: path,
        allowHalfOpen: true,
        socket: {
            data(socket) {
                socket.write('{"ok":false,"error":"invalid_request"}\n');
                socket.write("extra");
                socket.end();
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

test("rejects an incomplete UTF-8 suffix after a completed response frame", async () => {
    const directory = await makeTemporaryDirectory();
    const path = `${directory}/buffered-utf8-response.sock`;
    const response = new TextEncoder().encode('{"ok":false,"error":"invalid_request"}\n');
    const responseWithBufferedUtf8Suffix = new Uint8Array(response.byteLength + 1);
    responseWithBufferedUtf8Suffix.set(response);
    responseWithBufferedUtf8Suffix[response.byteLength] = 0xf0;
    const listener = Bun.listen({
        unix: path,
        socket: {
            data(socket) {
                socket.end(responseWithBufferedUtf8Suffix);
            },
        },
    });

    try {
        await expect(healthControl(path)).rejects.toMatchObject({
            _tag: "ControlProtocolError",
            detail: "trailing response bytes",
        } satisfies Partial<ControlProtocolError>);
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
        notifications: { async publish() {} },
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
        notifications: { async publish() {} },
    });

    await unlink(path);
    await symlink(target, path);
    await server.close();
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(path, "utf8")).toBe("replacement");
    await rm(directory, { force: true, recursive: true });
});
