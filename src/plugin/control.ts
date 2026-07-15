import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readlink, rename, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import * as Schema from "effect/Schema";

import { resolveHerdRSocketPath } from "../herdr/client.ts";
import {
    ControlRequest,
    ControlResponse,
    type ControlResponse as ControlResponseValue,
    DaemonHealth,
    type HookNotification,
} from "./protocol.ts";

export const CONTROL_SOCKET_MAX_BYTES = 64 * 1024;
export const CONTROL_SOCKET_MODE = 0o600;
export const CONTROL_DAEMON_IDENTITY = "dev.zed-herdr:daemon" as const;

export class AlreadyRunning extends Error {
    readonly _tag = "AlreadyRunning";

    constructor(readonly path: string) {
        super(`A live Zed HerdR control daemon is already listening at ${path}`);
        this.name = "AlreadyRunning";
    }
}

export class UnsafeControlSocket extends Error {
    readonly _tag = "UnsafeControlSocket";

    constructor(
        readonly path: string,
        readonly reason:
            | "foreign_owner"
            | "not_socket"
            | "symlink"
            | "changed_inode"
            | "lstat_failed"
            | "probe_failed"
            | "not_directory"
            | "unsafe_mode"
            | "unsafe_parent",
    ) {
        super(`Refusing to alter unsafe control socket ${path}: ${reason}`);
        this.name = "UnsafeControlSocket";
    }
}

export class ControlUnavailable extends Error {
    readonly _tag = "ControlUnavailable";

    constructor(
        readonly path: string,
        readonly operation: "connect" | "read" | "timeout",
        override readonly cause?: unknown,
    ) {
        super(`Control socket ${operation} failed for ${path}`);
        this.name = "ControlUnavailable";
    }
}

export class ControlProtocolError extends Error {
    readonly _tag = "ControlProtocolError";

    constructor(
        readonly path: string,
        readonly detail: string,
    ) {
        super(`Invalid control response from ${path}: ${detail}`);
        this.name = "ControlProtocolError";
    }
}

export interface ControlNotificationSink {
    readonly publish: (notification: HookNotification) => void | Promise<void>;
}

export interface StartControlServerOptions {
    readonly path: string;
    /** Captured by the daemon at startup; clients never submit or influence this value. */
    readonly paneId: string | null;
    readonly notifications: ControlNotificationSink;
}

export interface ControlServer {
    readonly path: string;
    readonly daemon: DaemonHealth;
    close(): Promise<void>;
}

type SocketIdentity = {
    readonly dev: number;
    readonly ino: number;
};

const textEncoder = new TextEncoder();

const currentUid = (): number => {
    const uid = process.getuid?.();
    if (uid === undefined) {
        throw new UnsafeControlSocket("/tmp", "lstat_failed");
    }
    return uid;
};

const sameIdentity = (left: SocketIdentity, right: SocketIdentity): boolean =>
    left.dev === right.dev && left.ino === right.ino;

const isMissing = (error: unknown): error is NodeJS.ErrnoException =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const isAlreadyPresent = (error: unknown): error is NodeJS.ErrnoException =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";

const restoreWithoutClobbering = async (preservedPath: string, path: string): Promise<boolean> => {
    const preserved = await lstat(preservedPath);
    try {
        if (preserved.isSymbolicLink()) {
            await symlink(await readlink(preservedPath), path);
        } else if (preserved.isFile() || preserved.isSocket()) {
            await link(preservedPath, path);
        } else {
            throw new UnsafeControlSocket(path, "changed_inode");
        }
        await unlink(preservedPath);
        return true;
    } catch (error) {
        if (isAlreadyPresent(error)) {
            return false;
        }
        throw error;
    }
};

const isRefused = (error: unknown): error is NodeJS.ErrnoException =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ECONNREFUSED" || error.code === "ENOENT");

const closeSocket = (socket: Bun.Socket<undefined>): void => {
    try {
        socket.end();
    } catch {
        socket.terminate();
    }
};

/** Narrow injection seam for fail-closed liveness tests. */
export interface ControlSocketConnector {
    connect(path: string): Promise<Bun.Socket<undefined>>;
}

const bunControlSocketConnector: ControlSocketConnector = {
    connect(path) {
        return Bun.connect({
            unix: path,
            socket: {
                data() {},
            },
        });
    },
};

export const probeControlSocket = async (
    path: string,
    timeoutMs = 150,
    connector: ControlSocketConnector = bunControlSocketConnector,
): Promise<boolean> => {
    let timedOut = false;
    let opened: Bun.Socket<undefined> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connection = connector.connect(path);
    const timeout = new Promise<never>((_resolveTimeout, rejectTimeout) => {
        timer = setTimeout(() => {
            timedOut = true;
            rejectTimeout(new UnsafeControlSocket(path, "probe_failed"));
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            connection.then(
                (socket) => {
                    opened = socket;
                    return true;
                },
                (error: unknown) => {
                    if (isRefused(error)) {
                        return false;
                    }
                    throw new UnsafeControlSocket(path, "probe_failed");
                },
            ),
            timeout,
        ]);
    } finally {
        clearTimeout(timer);
        if (opened !== undefined) {
            closeSocket(opened);
        } else if (timedOut) {
            void connection.then(closeSocket).catch(() => undefined);
        }
    }
};

/** Derive the per-HerdR-session owner-only control socket pathname. */
export const controlSocketPath = (environment: NodeJS.ProcessEnv = process.env): string => {
    const herdRSocket = resolve(resolveHerdRSocketPath(environment));
    const digest = createHash("sha256").update(herdRSocket).digest("hex").slice(0, 16);
    const configuredRuntimeBase = environment.XDG_RUNTIME_DIR?.trim();
    const runtimeBase =
        configuredRuntimeBase === undefined || configuredRuntimeBase.length === 0
            ? dirname(herdRSocket)
            : resolve(configuredRuntimeBase);
    return join(runtimeBase, "zed-herdr", `${digest}.sock`);
};

const validateControlSocketParent = async (path: string): Promise<void> => {
    const parent = dirname(path);
    try {
        const stat = await lstat(parent);
        if (
            stat.isSymbolicLink() ||
            !stat.isDirectory() ||
            stat.uid !== currentUid() ||
            (stat.mode & 0o022) !== 0
        ) {
            throw new UnsafeControlSocket(path, "unsafe_parent");
        }
    } catch (error) {
        if (error instanceof UnsafeControlSocket) {
            throw error;
        }
        throw new UnsafeControlSocket(path, "unsafe_parent");
    }
};

const validateControlSocketDirectory = async (path: string): Promise<boolean> => {
    try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) {
            throw new UnsafeControlSocket(path, "symlink");
        }
        if (!stat.isDirectory()) {
            throw new UnsafeControlSocket(path, "not_directory");
        }
        if (stat.uid !== currentUid()) {
            throw new UnsafeControlSocket(path, "foreign_owner");
        }
        if ((stat.mode & 0o777) !== 0o700) {
            await chmod(path, 0o700);
            const tightened = await lstat(path);
            if (
                tightened.isSymbolicLink() ||
                !tightened.isDirectory() ||
                tightened.uid !== currentUid() ||
                (tightened.mode & 0o777) !== 0o700
            ) {
                throw new UnsafeControlSocket(path, "unsafe_mode");
            }
        }
        return true;
    } catch (error) {
        if (isMissing(error)) {
            return false;
        }
        if (error instanceof UnsafeControlSocket) {
            throw error;
        }
        throw new UnsafeControlSocket(path, "unsafe_mode");
    }
};

/** Prepare and revalidate the owner-only directory containing a control socket. */
export const prepareControlSocketDirectory = async (path: string): Promise<void> => {
    const directory = dirname(path);
    await validateControlSocketParent(directory);
    if (!(await validateControlSocketDirectory(directory))) {
        try {
            await mkdir(directory, { mode: 0o700 });
        } catch (error) {
            if (!isAlreadyPresent(error)) {
                throw new UnsafeControlSocket(directory, "unsafe_mode");
            }
        }
    }
    if (!(await validateControlSocketDirectory(directory))) {
        throw new UnsafeControlSocket(directory, "unsafe_mode");
    }
};

const lstatOwnedSocket = async (path: string): Promise<SocketIdentity | null> => {
    try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) {
            throw new UnsafeControlSocket(path, "symlink");
        }
        if (!stat.isSocket()) {
            throw new UnsafeControlSocket(path, "not_socket");
        }
        if (stat.uid !== currentUid()) {
            throw new UnsafeControlSocket(path, "foreign_owner");
        }
        return { dev: stat.dev, ino: stat.ino };
    } catch (error) {
        if (isMissing(error)) {
            return null;
        }
        if (error instanceof UnsafeControlSocket) {
            throw error;
        }
        throw new UnsafeControlSocket(path, "lstat_failed");
    }
};

/**
 * Safely clear an orphaned socket. It never unlinks a path without first proving it
 * is the same current-user Unix socket that was found after a failed liveness probe.
 */
export const prepareControlSocket = async (path: string): Promise<void> => {
    const before = await lstatOwnedSocket(path);

    if (await probeControlSocket(path)) {
        const live = await lstatOwnedSocket(path);
        if (live === null || (before !== null && !sameIdentity(before, live))) {
            throw new UnsafeControlSocket(path, "changed_inode");
        }
        throw new AlreadyRunning(path);
    }

    const afterFirstProbe = await lstatOwnedSocket(path);
    if (
        (before === null && afterFirstProbe !== null) ||
        (before !== null && (afterFirstProbe === null || !sameIdentity(before, afterFirstProbe)))
    ) {
        throw new UnsafeControlSocket(path, "changed_inode");
    }
    if (afterFirstProbe === null) {
        if (await probeControlSocket(path)) {
            const live = await lstatOwnedSocket(path);
            if (live === null) {
                throw new UnsafeControlSocket(path, "changed_inode");
            }
            throw new AlreadyRunning(path);
        }
        return;
    }

    if (await probeControlSocket(path)) {
        const live = await lstatOwnedSocket(path);
        if (live === null || !sameIdentity(afterFirstProbe, live)) {
            throw new UnsafeControlSocket(path, "changed_inode");
        }
        throw new AlreadyRunning(path);
    }

    const afterSecondProbe = await lstatOwnedSocket(path);
    if (afterSecondProbe === null || !sameIdentity(afterFirstProbe, afterSecondProbe)) {
        throw new UnsafeControlSocket(path, "changed_inode");
    }

    const quarantinePath = `${path}.quarantine-${crypto.randomUUID()}`;
    try {
        await rename(path, quarantinePath);
    } catch (error) {
        if (isMissing(error)) {
            throw new UnsafeControlSocket(path, "changed_inode");
        }
        throw error;
    }

    let matchesExpectedInode = false;
    try {
        const quarantined = await lstat(quarantinePath);
        matchesExpectedInode =
            quarantined.dev === afterSecondProbe.dev && quarantined.ino === afterSecondProbe.ino;
    } catch {
        // The pathname was removed or replaced after atomic capture. Do not touch the canonical path.
    }
    if (!matchesExpectedInode) {
        await restoreWithoutClobbering(quarantinePath, path);
        throw new UnsafeControlSocket(path, "changed_inode");
    }
    await unlink(quarantinePath);
};

const encodeResponse = (response: ControlResponseValue): string => `${JSON.stringify(response)}\n`;

const writeAndClose = (
    socket: Bun.Socket<ConnectionState>,
    response: ControlResponseValue,
): void => {
    socket.end(encodeResponse(response));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, expected: ReadonlyArray<string>): boolean => {
    const actual = Object.keys(value);
    return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

const isExactControlResponse = (value: unknown): value is Record<string, unknown> => {
    if (!isRecord(value)) {
        return false;
    }
    if (value.ok === true) {
        if (hasExactKeys(value, ["ok"])) {
            return true;
        }
        const daemon = value.daemon;
        return (
            hasExactKeys(value, ["ok", "daemon"]) &&
            isRecord(daemon) &&
            hasExactKeys(daemon, ["identity", "paneId", "pid", "startedAt"])
        );
    }
    return value.ok === false && hasExactKeys(value, ["ok", "error"]);
};

type ConnectionState = {
    buffer: string;
    bytes: number;
    completed: boolean;
    decoder: TextDecoder;
    scheduled: boolean;
};

const responseFor = (
    encoded: string,
    notificationSink: ControlNotificationSink,
    daemon: DaemonHealth,
    socket: Bun.Socket<ConnectionState>,
): void => {
    let raw: unknown;
    try {
        raw = JSON.parse(encoded);
    } catch {
        writeAndClose(socket, { ok: false, error: "invalid_request" });
        return;
    }

    const decoded = Schema.decodeUnknownEither(ControlRequest)(raw);
    if (decoded._tag === "Left") {
        writeAndClose(socket, { ok: false, error: "invalid_request" });
        return;
    }

    if (decoded.right.type === "health") {
        writeAndClose(socket, { ok: true, daemon });
        return;
    }

    let published: void | Promise<void>;
    try {
        published = notificationSink.publish(decoded.right.notification);
    } catch {
        writeAndClose(socket, { ok: false, error: "server_failure" });
        return;
    }
    void Promise.resolve(published).then(
        () => writeAndClose(socket, { ok: true }),
        () => writeAndClose(socket, { ok: false, error: "server_failure" }),
    );
};

/** Bind the daemon's owner-only Unix listener and return an inode-safe finalizer. */
export const startControlServer = async (
    options: StartControlServerOptions,
): Promise<ControlServer> => {
    const daemonResult = Schema.decodeUnknownEither(DaemonHealth)({
        identity: CONTROL_DAEMON_IDENTITY,
        paneId: options.paneId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
    });
    if (daemonResult._tag === "Left") {
        throw new ControlProtocolError(options.path, "invalid daemon health");
    }
    const daemon = daemonResult.right;

    await prepareControlSocketDirectory(options.path);
    await prepareControlSocket(options.path);

    const listener = (() => {
        const processBufferedRequest = (socket: Bun.Socket<ConnectionState>): void => {
            if (socket.data.completed) {
                return;
            }
            const newline = socket.data.buffer.indexOf("\n");
            if (newline < 0 || socket.data.buffer.slice(newline + 1).length > 0) {
                socket.data.completed = true;
                writeAndClose(socket, { ok: false, error: "invalid_request" });
                return;
            }
            const frame = socket.data.buffer.slice(0, newline).replace(/\r$/, "");
            if (textEncoder.encode(frame).byteLength > CONTROL_SOCKET_MAX_BYTES) {
                socket.data.completed = true;
                writeAndClose(socket, { ok: false, error: "payload_too_large" });
                return;
            }
            socket.data.completed = true;
            responseFor(frame, options.notifications, daemon, socket);
        };
        const priorUmask = process.umask(0o177);
        try {
            return Bun.listen<ConnectionState>({
                unix: options.path,
                allowHalfOpen: true,
                socket: {
                    open(socket) {
                        socket.data = {
                            buffer: "",
                            bytes: 0,
                            completed: false,
                            decoder: new TextDecoder("utf-8", { fatal: true }),
                            scheduled: false,
                        };
                    },
                    data(socket, chunk) {
                        if (socket.data.completed) {
                            return;
                        }
                        socket.data.bytes += chunk.byteLength;
                        try {
                            socket.data.buffer += socket.data.decoder.decode(chunk, {
                                stream: true,
                            });
                        } catch {
                            socket.data.completed = true;
                            writeAndClose(socket, { ok: false, error: "invalid_request" });
                            return;
                        }

                        const newline = socket.data.buffer.indexOf("\n");
                        if (newline >= 0) {
                            if (socket.data.buffer.slice(newline + 1).length > 0) {
                                socket.data.completed = true;
                                writeAndClose(socket, { ok: false, error: "invalid_request" });
                                return;
                            }
                            const frame = socket.data.buffer.slice(0, newline).replace(/\r$/, "");
                            if (textEncoder.encode(frame).byteLength > CONTROL_SOCKET_MAX_BYTES) {
                                socket.data.completed = true;
                                writeAndClose(socket, { ok: false, error: "payload_too_large" });
                                return;
                            }
                            if (!socket.data.scheduled) {
                                socket.data.scheduled = true;
                                setImmediate(() => processBufferedRequest(socket));
                            }
                            return;
                        }

                        if (
                            socket.data.bytes >
                            CONTROL_SOCKET_MAX_BYTES +
                                (socket.data.buffer.endsWith("\r") ? 1 : 0)
                        ) {
                            socket.data.completed = true;
                            writeAndClose(socket, { ok: false, error: "payload_too_large" });
                        }
                    },
                    end(socket) {
                        if (socket.data.completed) {
                            return;
                        }
                        try {
                            socket.data.buffer += socket.data.decoder.decode();
                        } catch {
                            socket.data.completed = true;
                            writeAndClose(socket, { ok: false, error: "invalid_request" });
                            return;
                        }
                        processBufferedRequest(socket);
                    },
                },
            });
        } finally {
            process.umask(priorUmask);
        }
    })();

    try {
        const boundStat = await lstat(options.path);
        if (
            !boundStat.isSocket() ||
            boundStat.isSymbolicLink() ||
            boundStat.uid !== currentUid() ||
            (boundStat.mode & 0o777) !== CONTROL_SOCKET_MODE
        ) {
            throw new UnsafeControlSocket(options.path, "lstat_failed");
        }
        const identity: SocketIdentity = { dev: boundStat.dev, ino: boundStat.ino };

        let listenerStopped = false;
        let closing: Promise<void> | null = null;
        return {
            path: options.path,
            daemon,
            close(): Promise<void> {
                if (listenerStopped) {
                    return Promise.resolve();
                }
                if (closing !== null) {
                    return closing;
                }

                closing = (async () => {
                    const preservedPaths: Array<string> = [];
                    try {
                        for (;;) {
                            const preservedPath = `${options.path}.preserve-${crypto.randomUUID()}`;
                            try {
                                await rename(options.path, preservedPath);
                                preservedPaths.push(preservedPath);
                            } catch (error) {
                                if (!isMissing(error)) {
                                    throw error;
                                }
                            }

                            try {
                                const guard = await open(options.path, "wx", CONTROL_SOCKET_MODE);
                                await guard.close();
                                break;
                            } catch (error) {
                                if (!isAlreadyPresent(error)) {
                                    throw error;
                                }
                            }
                        }
                    } finally {
                        listener.stop(true);
                        listenerStopped = true;
                    }

                    for (const preservedPath of preservedPaths) {
                        let preserved: SocketIdentity | null = null;
                        try {
                            const stat = await lstat(preservedPath);
                            preserved = { dev: stat.dev, ino: stat.ino };
                        } catch (error) {
                            if (!isMissing(error)) {
                                throw error;
                            }
                        }
                        if (preserved === null) {
                            continue;
                        }
                        if (sameIdentity(identity, preserved)) {
                            await unlink(preservedPath);
                            continue;
                        }
                        await restoreWithoutClobbering(preservedPath, options.path);
                    }
                })();
                return closing;
            },
        };
    } catch (error) {
        const preservedPaths: Array<string> = [];
        try {
            for (;;) {
                const preservedPath = `${options.path}.startup-preserve-${crypto.randomUUID()}`;
                try {
                    await rename(options.path, preservedPath);
                    preservedPaths.push(preservedPath);
                } catch (renameError) {
                    if (!isMissing(renameError)) {
                        throw renameError;
                    }
                }

                try {
                    const guard = await open(options.path, "wx", CONTROL_SOCKET_MODE);
                    await guard.close();
                    break;
                } catch (guardError) {
                    if (!isAlreadyPresent(guardError)) {
                        throw guardError;
                    }
                }
            }
        } finally {
            listener.stop(true);
        }

        for (const preservedPath of preservedPaths) {
            await restoreWithoutClobbering(preservedPath, options.path);
        }
        throw error;
    }
};

const requestControl = async (
    path: string,
    request: unknown,
    timeoutMs: number,
): Promise<ControlResponseValue> => {
    const identity = await lstatOwnedSocket(path);
    if (identity === null) {
        throw new ControlUnavailable(path, "connect");
    }
    return new Promise<ControlResponseValue>((resolveResponse, rejectResponse) => {
        let socket: Bun.Socket<undefined> | undefined;
        let settled = false;
        let buffer = "";
        let bytes = 0;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const finish = (result: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            result();
        };
        const timer = setTimeout(() => {
            socket?.terminate();
            finish(() => rejectResponse(new ControlUnavailable(path, "timeout")));
        }, timeoutMs);
        const finishResponse = (
            client: Bun.Socket<undefined>,
            incompleteIsUnavailable: boolean,
        ): void => {
            if (settled) {
                return;
            }
            try {
                buffer += decoder.decode();
            } catch {
                finish(() => rejectResponse(new ControlProtocolError(path, "invalid UTF-8")));
                client.terminate();
                return;
            }
            const newline = buffer.indexOf("\n");
            if (newline < 0) {
                finish(() =>
                    rejectResponse(
                        incompleteIsUnavailable
                            ? new ControlUnavailable(path, "read")
                            : new ControlProtocolError(path, "invalid response framing"),
                    ),
                );
                client.terminate();
                return;
            }
            if (buffer.slice(newline + 1).length > 0) {
                finish(() =>
                    rejectResponse(new ControlProtocolError(path, "invalid response framing")),
                );
                client.terminate();
                return;
            }
            const frame = buffer.slice(0, newline).replace(/\r$/, "");
            if (textEncoder.encode(frame).byteLength > CONTROL_SOCKET_MAX_BYTES) {
                finish(() =>
                    rejectResponse(new ControlProtocolError(path, "response exceeds 64KiB")),
                );
                client.terminate();
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(frame);
            } catch {
                finish(() => rejectResponse(new ControlProtocolError(path, "invalid JSON")));
                client.terminate();
                return;
            }
            if (!isExactControlResponse(parsed)) {
                finish(() =>
                    rejectResponse(new ControlProtocolError(path, "unexpected response shape")),
                );
                client.terminate();
                return;
            }
            const decoded = Schema.decodeUnknownEither(ControlResponse)(parsed);
            if (decoded._tag === "Left") {
                finish(() => rejectResponse(new ControlProtocolError(path, "invalid response")));
                client.terminate();
                return;
            }
            finish(() => resolveResponse(decoded.right));
            client.terminate();
        };

        void Bun.connect({
            unix: path,
            allowHalfOpen: true,
            socket: {
                data(client, chunk) {
                    if (settled) {
                        return;
                    }
                    bytes += chunk.byteLength;
                    try {
                        buffer += decoder.decode(chunk, { stream: true });
                    } catch {
                        finish(() =>
                            rejectResponse(new ControlProtocolError(path, "invalid UTF-8")),
                        );
                        client.terminate();
                        return;
                    }

                    const newline = buffer.indexOf("\n");
                    if (newline >= 0) {
                        if (buffer.slice(newline + 1).length > 0) {
                            finish(() =>
                                rejectResponse(
                                    new ControlProtocolError(path, "trailing response bytes"),
                                ),
                            );
                            client.terminate();
                            return;
                        }
                        const frame = buffer.slice(0, newline).replace(/\r$/, "");
                        if (textEncoder.encode(frame).byteLength > CONTROL_SOCKET_MAX_BYTES) {
                            finish(() =>
                                rejectResponse(
                                    new ControlProtocolError(path, "response exceeds 64KiB"),
                                ),
                            );
                            client.terminate();
                        }
                        return;
                    }

                    if (bytes > CONTROL_SOCKET_MAX_BYTES + (buffer.endsWith("\r") ? 1 : 0)) {
                        finish(() =>
                            rejectResponse(
                                new ControlProtocolError(path, "response exceeds 64KiB"),
                            ),
                        );
                        client.terminate();
                    }
                },
                end(client) {
                    finishResponse(client, false);
                },
                close(client, closeError) {
                    if (closeError !== null && closeError !== undefined) {
                        finish(() =>
                            rejectResponse(new ControlUnavailable(path, "read", closeError)),
                        );
                        return;
                    }
                    finishResponse(client, true);
                },
                error(_client, socketError) {
                    finish(() => rejectResponse(new ControlUnavailable(path, "read", socketError)));
                },
            },
        }).then(
            (connected) => {
                socket = connected;
                if (settled) {
                    connected.terminate();
                    return;
                }
                void lstatOwnedSocket(path).then(
                    (current) => {
                        if (settled) {
                            connected.terminate();
                            return;
                        }
                        if (current === null || !sameIdentity(identity, current)) {
                            finish(() => rejectResponse(new ControlUnavailable(path, "connect")));
                            connected.terminate();
                            return;
                        }
                        connected.write(`${JSON.stringify(request)}\n`);
                    },
                    (lstatError: unknown) => {
                        finish(() => rejectResponse(lstatError));
                        connected.terminate();
                    },
                );
            },
            (connectError: unknown) =>
                finish(() => rejectResponse(new ControlUnavailable(path, "connect", connectError))),
        );
    });
};

export const notifyControl = async (
    path: string,
    notification: HookNotification,
    timeoutMs = 1_500,
): Promise<void> => {
    const response = await requestControl(path, { type: "notify", notification }, timeoutMs);
    if (response.ok !== true || "daemon" in response) {
        throw new ControlProtocolError(path, "notify was not acknowledged");
    }
};

export const healthControl = async (path: string, timeoutMs = 500): Promise<DaemonHealth> => {
    const response = await requestControl(path, { type: "health" }, timeoutMs);
    if (response.ok !== true || !("daemon" in response)) {
        throw new ControlProtocolError(path, "health was not acknowledged");
    }
    return response.daemon;
};
