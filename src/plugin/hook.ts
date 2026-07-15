import { randomUUID } from "node:crypto";
import {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
    rmdir,
    unlink,
} from "node:fs/promises";
import { join } from "node:path";

import {
    AlreadyRunning,
    controlSocketPath,
    notifyControl,
    prepareControlSocket,
} from "./control.ts";
import type { HookNotification } from "./protocol.ts";

const controlReadinessMs = 1_500;
const lockStaleMs = 5_000;
const lockPollMs = 25;
const pluginId = "dev.zed-herdr";

interface LockContents {
    readonly pid: number;
    readonly token: string;
    readonly createdAt: number;
}

interface LockIdentity {
    readonly dev: number;
    readonly ino: number;
}

export interface HookControlApi {
    readonly controlSocketPath: (environment: NodeJS.ProcessEnv) => string;
    readonly prepareControlSocket: (path: string) => Promise<void>;
    readonly notifyControl: (
        path: string,
        notification: HookNotification,
        timeoutMs?: number,
    ) => Promise<void>;
}

export type PaneOpenCommand = (argv: ReadonlyArray<string>) => Promise<void>;

export interface HookStartupOptions {
    readonly control?: HookControlApi;
    readonly environment?: NodeJS.ProcessEnv;
    readonly now?: () => number;
    readonly openPane?: PaneOpenCommand;
    readonly pid?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly token?: () => string;
}

export type HookStartupResult =
    | { readonly _tag: "Skipped"; readonly reason: "missing_workspace_or_cwd" }
    | { readonly _tag: "Notified"; readonly openedPane: boolean };

export class HookStartupError extends Error {
    readonly _tag = "HookStartupError";

    constructor(
        readonly operation: "open_pane" | "readiness" | "lock",
        message: string,
    ) {
        super(message);
        this.name = "HookStartupError";
    }
}

const defaultControl: HookControlApi = {
    controlSocketPath,
    prepareControlSocket,
    notifyControl,
};

const delay = (milliseconds: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, milliseconds);
    return promise;
};

const awaitWithinDeadline = async <Value>(
    operation: Promise<Value>,
    deadline: number,
    now: () => number,
): Promise<Value> => {
    const remaining = deadline - now();
    if (remaining <= 0) {
        throw new HookStartupError("readiness", "Timed out waiting for control socket readiness");
    }

    const timeout = Promise.withResolvers<void>();
    const timer = setTimeout(timeout.resolve, remaining);
    try {
        const result = await Promise.race([
            operation.then((value) => ({ value })),
            timeout.promise.then(() => undefined),
        ]);
        if (result === undefined) {
            throw new HookStartupError(
                "readiness",
                "Timed out waiting for control socket readiness",
            );
        }
        return result.value;
    } finally {
        clearTimeout(timer);
    }
};

const invokeWithinDeadline = async <Value>(
    invoke: () => Promise<Value>,
    deadline: number,
    now: () => number,
): Promise<Value> => {
    if (deadline - now() <= 0) {
        throw new HookStartupError("readiness", "Timed out waiting for control socket readiness");
    }
    return awaitWithinDeadline(invoke(), deadline, now);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    isRecord(value) ? value : undefined;

const nonEmptyText = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 && value.length <= 4_096 ? value : undefined;

const parseJson = (value: string | undefined): Record<string, unknown> | undefined => {
    if (value === undefined) {
        return undefined;
    }

    try {
        return asRecord(JSON.parse(value));
    } catch {
        return undefined;
    }
};

const eventWorkspaceId = (event: Record<string, unknown> | undefined): string | undefined => {
    const data = asRecord(event?.data);
    const workspace = asRecord(data?.workspace);
    return nonEmptyText(workspace?.workspace_id) ?? nonEmptyText(data?.workspace_id);
};

/** Decode only the documented HerdR hook payload and context variables. */
export const decodeHookNotification = (
    environment: NodeJS.ProcessEnv = process.env,
): HookNotification | undefined => {
    const workspaceId =
        eventWorkspaceId(parseJson(environment.HERDR_PLUGIN_EVENT_JSON)) ??
        nonEmptyText(environment.HERDR_WORKSPACE_ID);
    const context = parseJson(environment.HERDR_PLUGIN_CONTEXT_JSON);
    const cwd = nonEmptyText(context?.workspace_cwd);

    if (workspaceId === undefined || cwd === undefined) {
        return undefined;
    }

    return {
        workspaceId: workspaceId as HookNotification["workspaceId"],
        cwd,
    };
};

const isNodeError = (error: unknown, code: string): boolean =>
    typeof error === "object" && error !== null && "code" in error && error.code === code;

const currentUid = (): number | undefined => process.getuid?.();

const sameIdentity = (left: LockIdentity, right: LockIdentity): boolean =>
    left.dev === right.dev && left.ino === right.ino;

const lockIdentity = (stat: { readonly dev: number; readonly ino: number }): LockIdentity => ({
    dev: stat.dev,
    ino: stat.ino,
});

const parseLock = (value: string): LockContents | undefined => {
    try {
        const parsed = JSON.parse(value);
        if (
            !isRecord(parsed) ||
            typeof parsed.pid !== "number" ||
            !Number.isInteger(parsed.pid) ||
            parsed.pid < 0 ||
            typeof parsed.token !== "string" ||
            parsed.token.length === 0 ||
            typeof parsed.createdAt !== "number" ||
            !Number.isFinite(parsed.createdAt)
        ) {
            return undefined;
        }
        return {
            pid: parsed.pid,
            token: parsed.token,
            createdAt: parsed.createdAt,
        };
    } catch {
        return undefined;
    }
};

interface LockInspection {
    readonly createdAt: number;
    readonly identity: LockIdentity;
    readonly lock: LockContents | undefined;
    readonly ownerIdentity: LockIdentity | undefined;
    readonly ownerPath: string | undefined;
}

const lockOwnerPath = (path: string, token: string): string => join(path, `${token}.json`);

const inspectLock = async (path: string): Promise<LockInspection> => {
    const directory = await lstat(path);
    if (
        directory.isSymbolicLink() ||
        !directory.isDirectory() ||
        (directory.mode & 0o777) !== 0o700 ||
        (currentUid() !== undefined && directory.uid !== currentUid())
    ) {
        throw new HookStartupError("lock", `Refusing unsafe hook lock at ${path}`);
    }

    const entries = await readdir(path);
    if (entries.length === 0) {
        return {
            createdAt: directory.mtimeMs,
            identity: lockIdentity(directory),
            lock: undefined,
            ownerIdentity: undefined,
            ownerPath: undefined,
        };
    }
    if (entries.length !== 1 || !entries[0]?.endsWith(".json")) {
        throw new HookStartupError("lock", `Refusing malformed hook lock directory at ${path}`);
    }

    const ownerPath = join(path, entries[0]);
    const owner = await lstat(ownerPath);
    if (
        owner.isSymbolicLink() ||
        !owner.isFile() ||
        (owner.mode & 0o777) !== 0o600 ||
        (currentUid() !== undefined && owner.uid !== currentUid())
    ) {
        throw new HookStartupError("lock", `Refusing unsafe hook lock owner at ${path}`);
    }

    const lock = parseLock(await readFile(ownerPath, "utf8"));
    if (lock === undefined || ownerPath !== lockOwnerPath(path, lock.token)) {
        throw new HookStartupError("lock", `Refusing malformed hook lock owner at ${path}`);
    }

    return {
        createdAt: lock.createdAt,
        identity: lockIdentity(directory),
        lock,
        ownerIdentity: lockIdentity(owner),
        ownerPath,
    };
};

const removeEmptyLockDirectory = async (
    path: string,
    expectedIdentity: LockIdentity,
): Promise<boolean> => {
    let current: LockInspection;
    try {
        current = await inspectLock(path);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return false;
        }
        throw error;
    }
    if (!sameIdentity(expectedIdentity, current.identity) || current.lock !== undefined) {
        return false;
    }

    try {
        await rmdir(path);
        return true;
    } catch (error) {
        if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTEMPTY")) {
            return false;
        }
        throw error;
    }
};

const removeCapturedLock = async (path: string, current: LockInspection): Promise<boolean> => {
    if (current.lock === undefined || current.ownerPath === undefined) {
        return removeEmptyLockDirectory(path, current.identity);
    }

    try {
        await unlink(current.ownerPath);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return false;
        }
        throw error;
    }
    return removeEmptyLockDirectory(path, current.identity);
};

const removeStaleLock = async (path: string, now: number): Promise<boolean> => {
    let initial: LockInspection;
    try {
        initial = await inspectLock(path);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return false;
        }
        throw error;
    }

    if (now - initial.createdAt < lockStaleMs) {
        return false;
    }

    let current: LockInspection;
    try {
        current = await inspectLock(path);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return false;
        }
        throw error;
    }

    if (!sameIdentity(initial.identity, current.identity)) {
        return false;
    }
    if (
        initial.lock !== undefined &&
        (current.lock === undefined ||
            current.lock.token !== initial.lock.token ||
            initial.ownerIdentity === undefined ||
            current.ownerIdentity === undefined ||
            initial.ownerPath !== current.ownerPath ||
            !sameIdentity(initial.ownerIdentity, current.ownerIdentity))
    ) {
        return false;
    }
    if (initial.lock === undefined && current.lock !== undefined) {
        return false;
    }

    return removeCapturedLock(path, current);
};

const writeLockOwner = async (path: string, contents: LockContents): Promise<void> => {
    const ownerPath = lockOwnerPath(path, contents.token);
    const file = await open(ownerPath, "wx", 0o600);
    try {
        await file.writeFile(JSON.stringify(contents));
    } finally {
        await file.close();
    }
    await chmod(ownerPath, 0o600);
};

const acquireLock = async (
    path: string,
    contents: LockContents,
    deadline: number,
    now: () => number,
    sleep: (milliseconds: number) => Promise<void>,
): Promise<void> => {
    const candidate = `${path}.${contents.token}.tmp`;
    for (;;) {
        try {
            await mkdir(candidate, { mode: 0o700 });
            await chmod(candidate, 0o700);
        } catch (error) {
            throw new HookStartupError(
                "lock",
                `Unable to create hook lock candidate at ${path}: ${String(error)}`,
            );
        }

        try {
            await writeLockOwner(candidate, contents);
        } catch (error) {
            await rm(candidate, { recursive: true, force: true });
            throw new HookStartupError(
                "lock",
                `Unable to write hook lock owner at ${path}: ${String(error)}`,
            );
        }

        let canonicalExists = false;
        try {
            await lstat(path);
            canonicalExists = true;
        } catch (error) {
            if (!isNodeError(error, "ENOENT")) {
                await rm(candidate, { recursive: true, force: true });
                throw new HookStartupError(
                    "lock",
                    `Unable to inspect hook lock at ${path}: ${String(error)}`,
                );
            }
        }

        if (!canonicalExists) {
            try {
                await rename(candidate, path);
                return;
            } catch (error) {
                await rm(candidate, { recursive: true, force: true });
                if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOTEMPTY")) {
                    throw new HookStartupError(
                        "lock",
                        `Unable to acquire hook lock at ${path}: ${String(error)}`,
                    );
                }
            }
        } else {
            await rm(candidate, { recursive: true, force: true });
        }

        await removeStaleLock(path, now());
        if (now() >= deadline) {
            throw new HookStartupError(
                "readiness",
                "Timed out waiting for control socket readiness",
            );
        }
        await sleep(lockPollMs);
    }
};

const releaseLock = async (path: string, token: string): Promise<void> => {
    let current: LockInspection;
    try {
        current = await inspectLock(path);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return;
        }
        throw error;
    }

    if (current.lock === undefined || current.lock.token !== token) {
        return;
    }

    let final: LockInspection;
    try {
        final = await inspectLock(path);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) {
            return;
        }
        throw error;
    }
    if (
        final.lock === undefined ||
        final.lock.token !== token ||
        current.ownerIdentity === undefined ||
        final.ownerIdentity === undefined ||
        current.ownerPath !== final.ownerPath ||
        !sameIdentity(current.identity, final.identity) ||
        !sameIdentity(current.ownerIdentity, final.ownerIdentity)
    ) {
        return;
    }

    await removeCapturedLock(path, final);
};

const defaultOpenPane = async (
    argv: ReadonlyArray<string>,
    deadline: number,
    now: () => number,
): Promise<void> => {
    if (deadline - now() <= 0) {
        throw new HookStartupError("readiness", "Timed out waiting for control socket readiness");
    }

    let child: Bun.Subprocess;
    try {
        child = Bun.spawn({ cmd: [...argv], stdout: "ignore", stderr: "ignore" });
    } catch (error) {
        throw new HookStartupError("open_pane", `Unable to start HerdR: ${String(error)}`);
    }

    let exitCode: number;
    try {
        exitCode = await awaitWithinDeadline(child.exited, deadline, now);
    } catch (error) {
        try {
            child.kill("SIGKILL");
        } catch {
            // The child may have already exited between the timeout and kill.
        }
        void child.exited.catch(() => undefined);
        throw error;
    }
    if (exitCode !== 0) {
        throw new HookStartupError("open_pane", `HerdR pane open exited with code ${exitCode}`);
    }
};

const paneOpenArgv = (
    workspaceId: string,
    environment: NodeJS.ProcessEnv,
): ReadonlyArray<string> => [
    nonEmptyText(environment.HERDR_BIN_PATH) ?? "herdr",
    "plugin",
    "pane",
    "open",
    "--plugin",
    pluginId,
    "--entrypoint",
    "daemon",
    "--placement",
    "tab",
    "--workspace",
    workspaceId,
    "--no-focus",
];

const notifyUntilReady = async (
    control: HookControlApi,
    path: string,
    notification: HookNotification,
    deadline: number,
    now: () => number,
    sleep: (milliseconds: number) => Promise<void>,
): Promise<void> => {
    for (;;) {
        const remaining = deadline - now();
        if (remaining <= 0) {
            throw new HookStartupError(
                "readiness",
                "Timed out waiting for control socket readiness",
            );
        }
        try {
            await control.notifyControl(path, notification, remaining);
            return;
        } catch {
            if (now() >= deadline) {
                throw new HookStartupError(
                    "readiness",
                    "Timed out waiting for control socket readiness",
                );
            }
            await sleep(lockPollMs);
        }
    }
};

/**
 * Start this plugin's daemon only when needed, then publish the hook's cwd hint.
 * The lock spans pane creation and control readiness so concurrent HerdR hooks open
 * at most one unfocused daemon pane.
 */
export const runHook = async (options: HookStartupOptions = {}): Promise<HookStartupResult> => {
    const environment = options.environment ?? process.env;
    const notification = decodeHookNotification(environment);
    if (notification === undefined) {
        return { _tag: "Skipped", reason: "missing_workspace_or_cwd" };
    }

    const control = options.control ?? defaultControl;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? delay;
    const token = options.token ?? randomUUID;
    const path = control.controlSocketPath(environment);
    const deadline = now() + controlReadinessMs;

    try {
        const remaining = deadline - now();
        if (remaining <= 0) {
            throw new HookStartupError(
                "readiness",
                "Timed out waiting for control socket readiness",
            );
        }
        await control.notifyControl(path, notification, remaining);
        return { _tag: "Notified", openedPane: false };
    } catch {
        if (now() >= deadline) {
            throw new HookStartupError(
                "readiness",
                "Timed out waiting for control socket readiness",
            );
        }
        // An absent or not-yet-ready daemon is resolved under the per-session lock.
    }

    const lockPath = `${path}.lock`;
    const lockToken = token();
    await acquireLock(
        lockPath,
        { pid: options.pid ?? process.pid, token: lockToken, createdAt: now() },
        deadline,
        now,
        sleep,
    );

    try {
        const remaining = deadline - now();
        if (remaining <= 0) {
            throw new HookStartupError(
                "readiness",
                "Timed out waiting for control socket readiness",
            );
        }
        try {
            await control.notifyControl(path, notification, remaining);
            return { _tag: "Notified", openedPane: false };
        } catch {
            // Recheck under the lock before altering an orphaned socket or opening a pane.
        }

        let openedPane = false;
        try {
            await invokeWithinDeadline(() => control.prepareControlSocket(path), deadline, now);
            const argv = paneOpenArgv(notification.workspaceId, environment);
            const openPane = options.openPane;
            if (openPane === undefined) {
                await defaultOpenPane(argv, deadline, now);
            } else {
                await invokeWithinDeadline(() => openPane(argv), deadline, now);
            }
            openedPane = true;
        } catch (error) {
            if (
                !(error instanceof AlreadyRunning) &&
                !(isRecord(error) && error._tag === "AlreadyRunning")
            ) {
                throw error;
            }
        }

        await notifyUntilReady(control, path, notification, deadline, now, sleep);
        return { _tag: "Notified", openedPane };
    } finally {
        await releaseLock(lockPath, lockToken);
    }
};
