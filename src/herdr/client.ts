import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { homedir } from "node:os";

import {
    StaleWorkspaceGeneration,
    UnsupportedHerdRProtocol,
    WorkspaceSourceProtocolError,
    WorkspaceSourceTransportError,
} from "../domain/errors.ts";
import {
    WorkspaceDisconnected,
    WorkspaceGeneration,
    WorkspaceInvalidated,
    WorkspaceSnapshot,
    type WorkspaceSourceEvent,
} from "../domain/workspace.ts";
import { NdjsonDecoder, NdjsonFramingError } from "./ndjson.ts";
import {
    HerdRErrorResponse,
    HerdRSuccessResponse,
    isLifecycleEventName,
    LifecycleEventEnvelope,
    makeEventsSubscribeRequest,
    makeSessionSnapshotRequest,
    type HerdRRequest,
    type SessionSnapshot,
    validateHerdRProtocol,
} from "./protocol.ts";

const retryInitialDelayMs = 100;
const retryMaximumDelayMs = 5_000;
const maxLogCauseLength = 4_096;

/** Resolve HerdR's Unix socket without probing or mutating the filesystem. */
export const resolveHerdRSocketPath = (environment: NodeJS.ProcessEnv = process.env): string => {
    const configuredSocket = environment.HERDR_SOCKET_PATH;
    if (configuredSocket !== undefined && configuredSocket.length > 0) {
        return configuredSocket;
    }

    const configHome =
        environment.XDG_CONFIG_HOME && environment.XDG_CONFIG_HOME.length > 0
            ? environment.XDG_CONFIG_HOME
            : `${environment.HOME ?? homedir()}/.config`;
    const session = environment.HERDR_SESSION;

    return session !== undefined && session.length > 0
        ? `${configHome}/herdr/sessions/${session}/herdr.sock`
        : `${configHome}/herdr/herdr.sock`;
};

export interface HerdRClientService {
    readonly socketPath: string;
    readonly events: Stream.Stream<WorkspaceSourceEvent, never>;
    readonly snapshot: (
        generation: WorkspaceGeneration,
    ) => Effect.Effect<WorkspaceSnapshot, HerdRClientError>;
}

export class HerdRClient extends Context.Tag("zed-herdr/HerdRClient")<
    HerdRClient,
    HerdRClientService
>() {}

export type HerdRClientError =
    | StaleWorkspaceGeneration
    | WorkspaceSourceTransportError
    | WorkspaceSourceProtocolError
    | UnsupportedHerdRProtocol;

type SnapshotRequest = {
    readonly promise: Promise<SessionSnapshot>;
    readonly cancel: (reason: HerdRClientError) => void;
};

const boundedCause = (cause: unknown): string => {
    const rendered = cause instanceof Error ? cause.message : String(cause);
    return rendered.length <= maxLogCauseLength
        ? rendered
        : rendered.slice(rendered.length - maxLogCauseLength);
};

const transportError = (
    operation: "connect" | "request" | "subscribe" | "read",
    cause: unknown,
): WorkspaceSourceTransportError =>
    new WorkspaceSourceTransportError({
        operation,
        message: boundedCause(cause) || "HerdR transport failure",
    });

const protocolError = (
    operation: "decode" | "response" | "subscription",
    cause: unknown,
): WorkspaceSourceProtocolError =>
    new WorkspaceSourceProtocolError({
        operation,
        message: boundedCause(cause) || "HerdR protocol failure",
    });

/** The protocol union is the sole outbound method allowlist. */
const writeReadOnlyRequest = (socket: Bun.Socket, request: HerdRRequest): void => {
    socket.write(`${JSON.stringify(request)}\n`);
};

const logTransport = (
    message: "herdr_disconnected" | "herdr_reconnecting",
    cause: unknown,
): void => {
    void Effect.runPromise(
        Effect.logWarning(message).pipe(Effect.annotateLogs({ cause: boundedCause(cause) })),
    );
};

const decodeGeneration = (value: number): WorkspaceGeneration =>
    Schema.decodeUnknownSync(WorkspaceGeneration)(value);

const decodeCoreSnapshot = (snapshot: SessionSnapshot): Either.Either<WorkspaceSnapshot, unknown> =>
    Schema.decodeUnknownEither(WorkspaceSnapshot)({
        focusedWorkspaceId: snapshot.focused_workspace_id ?? null,
        workspaces: snapshot.workspaces.map((workspace) => ({
            workspaceId: workspace.workspace_id,
            name: workspace.label,
            checkoutPath: workspace.worktree?.checkout_path ?? null,
            isLinkedWorktree: workspace.worktree?.is_linked_worktree ?? false,
        })),
    });

class LiveHerdRClient implements HerdRClientService {
    readonly socketPath: string;
    readonly events: Stream.Stream<WorkspaceSourceEvent, never>;

    #generation = 0;
    #liveGeneration: WorkspaceGeneration | null = null;
    #subscription: Bun.Socket | null = null;
    #requests = new Map<WorkspaceGeneration, Set<Bun.Socket>>();
    #requestCancellers = new Map<WorkspaceGeneration, Set<(reason: HerdRClientError) => void>>();

    #stopped = false;
    #cancelSleep: (() => void) | null = null;
    readonly #eventPubSub: PubSub.PubSub<WorkspaceSourceEvent>;

    constructor(eventPubSub: PubSub.PubSub<WorkspaceSourceEvent>, environment: NodeJS.ProcessEnv) {
        this.#eventPubSub = eventPubSub;
        this.socketPath = resolveHerdRSocketPath(environment);
        this.events = Stream.fromPubSub(this.#eventPubSub);
        this.snapshot = this.snapshot.bind(this);
    }

    start(): void {
        void this.#run();
    }

    close(): void {
        this.#stopped = true;
        this.#cancelSleep?.();
        this.#cancelSleep = null;
        this.#subscription?.terminate();
        this.#subscription = null;
        for (const [generation, cancellers] of this.#requestCancellers) {
            for (const cancel of cancellers) {
                cancel(new StaleWorkspaceGeneration({ generation }));
            }
        }
        for (const sockets of this.#requests.values()) {
            for (const socket of sockets) {
                socket.terminate();
            }
        }
        this.#requests.clear();
        this.#requestCancellers.clear();

        this.#liveGeneration = null;
    }

    snapshot(generation: WorkspaceGeneration): Effect.Effect<WorkspaceSnapshot, HerdRClientError> {
        return this.#requestLiveSnapshot(generation).pipe(
            Effect.flatMap(validateHerdRProtocol),
            Effect.flatMap((snapshot) =>
                this.#ensureLive(generation).pipe(
                    Effect.flatMap(() => {
                        const decoded = decodeCoreSnapshot(snapshot);
                        return Either.isRight(decoded)
                            ? Effect.succeed(decoded.right)
                            : Effect.fail(protocolError("decode", decoded.left));
                    }),
                ),
            ),
        );
    }

    #ensureLive(generation: WorkspaceGeneration): Effect.Effect<void, StaleWorkspaceGeneration> {
        return this.#liveGeneration === generation
            ? Effect.void
            : Effect.fail(new StaleWorkspaceGeneration({ generation }));
    }

    #requestLiveSnapshot(
        generation: WorkspaceGeneration,
    ): Effect.Effect<SessionSnapshot, HerdRClientError> {
        return Effect.async((resume, signal) => {
            if (this.#liveGeneration !== generation) {
                resume(Effect.fail(new StaleWorkspaceGeneration({ generation })));
                return;
            }

            const request = this.#newSnapshotRequest(generation);
            const onAbort = () => request.cancel(new StaleWorkspaceGeneration({ generation }));
            signal.addEventListener("abort", onAbort, { once: true });
            void request.promise
                .then(
                    (snapshot) => resume(Effect.succeed(snapshot)),
                    (error: unknown) => resume(Effect.fail(this.#asClientError(error, "request"))),
                )
                .finally(() => signal.removeEventListener("abort", onAbort));

            return Effect.sync(onAbort);
        });
    }

    async #run(): Promise<void> {
        let failures = 0;

        while (!this.#stopped) {
            const generation = decodeGeneration(++this.#generation);
            try {
                await this.#bootstrap(generation);
                failures = 0;
            } catch (cause) {
                if (this.#stopped) {
                    return;
                }
                failures += 1;
                logTransport("herdr_disconnected", cause);
            }

            if (this.#stopped) {
                return;
            }

            const exponent = Math.max(0, Math.min(failures - 1, 6));
            const cap = Math.min(retryMaximumDelayMs, retryInitialDelayMs * 2 ** exponent);
            const delay = Math.min(
                retryMaximumDelayMs,
                Math.floor(cap * (0.8 + Math.random() * 0.4)),
            );
            logTransport("herdr_reconnecting", `delay_ms=${delay}`);
            await this.#sleep(delay);
        }
    }

    async #bootstrap(generation: WorkspaceGeneration): Promise<void> {
        const firstSnapshot = this.#newSnapshotRequest(generation);
        const initial = await firstSnapshot.promise;
        const validated = await Effect.runPromise(validateHerdRProtocol(initial));
        // S1 establishes protocol compatibility only; core state is intentionally discarded.
        void validated;
        await this.#subscribe(generation);
    }

    #subscribe(generation: WorkspaceGeneration): Promise<void> {
        const acknowledged = Promise.withResolvers<void>();
        const finished = Promise.withResolvers<void>();
        const id = crypto.randomUUID();
        const decoder = new NdjsonDecoder();
        let socket: Bun.Socket | null = null;
        let acked = false;
        let settled = false;

        const finish = (cause: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (this.#subscription === socket) {
                this.#subscription = null;
            }
            this.#disconnect(generation);
            const failure = this.#asClientError(cause, "subscribe");
            if (!acked) {
                acknowledged.reject(failure);
            } else {
                finished.reject(failure);
            }
        };

        const acceptFrame = (frame: string): void => {
            if (frame.length === 0) {
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(frame);
            } catch (cause) {
                void Effect.runPromise(
                    Effect.logWarning("herdr_malformed_frame", { cause: boundedCause(cause) }),
                );
                return;
            }

            const success = Schema.decodeUnknownEither(HerdRSuccessResponse)(parsed);
            if (Either.isRight(success) && success.right.id === id) {
                if (success.right.result.type !== "subscription_started") {
                    finish(protocolError("subscription", "unexpected subscription response"));
                    return;
                }
                if (!acked) {
                    acked = true;
                    this.#liveGeneration = generation;
                    this.#publish(WorkspaceInvalidated.make({ generation }));
                    acknowledged.resolve();
                }
                return;
            }

            const failure = Schema.decodeUnknownEither(HerdRErrorResponse)(parsed);
            if (Either.isRight(failure) && failure.right.id === id) {
                finish(protocolError("response", failure.right.error.message));
                return;
            }

            if (
                parsed !== null &&
                typeof parsed === "object" &&
                "id" in parsed &&
                parsed.id === id
            ) {
                void Effect.runPromise(
                    Effect.logWarning("herdr_malformed_frame", {
                        cause: "malformed subscription response",
                    }),
                );
                return;
            }
            if (parsed === null || typeof parsed !== "object" || !("event" in parsed)) {
                return;
            }
            const eventName = parsed.event;
            if (!isLifecycleEventName(eventName)) {
                return;
            }
            const event = Schema.decodeUnknownEither(LifecycleEventEnvelope)(parsed);
            if (!Either.isRight(event)) {
                void Effect.runPromise(
                    Effect.logWarning("herdr_malformed_frame", { cause: boundedCause(event.left) }),
                );
                return;
            }
            if (acked) {
                this.#publish(WorkspaceInvalidated.make({ generation }));
            }
        };
        const finishAfterDecoderEnd = (cause: unknown): void => {
            try {
                for (const frame of decoder.end()) {
                    acceptFrame(frame);
                }
            } catch (error) {
                finish(error instanceof NdjsonFramingError ? error : transportError("read", error));
                return;
            }
            finish(cause);
        };

        void Bun.connect({
            unix: this.socketPath,
            socket: {
                binaryType: "uint8array",
                data: (_socket, data) => {
                    try {
                        for (const frame of decoder.push(data)) {
                            acceptFrame(frame);
                        }
                    } catch (cause) {
                        if (cause instanceof NdjsonFramingError) {
                            finish(cause);
                        } else {
                            finish(transportError("read", cause));
                        }
                    }
                },
                close: (_socket, error) =>
                    finishAfterDecoderEnd(error ?? new Error("HerdR subscription closed")),
                end: () => finishAfterDecoderEnd(new Error("HerdR subscription ended")),
                error: (_socket, error) => finish(error),
            },
        }).then(
            (connected) => {
                socket = connected;
                this.#subscription = connected;
                if (settled || this.#stopped) {
                    connected.terminate();
                    return;
                }
                writeReadOnlyRequest(connected, makeEventsSubscribeRequest(id));
            },
            (cause: unknown) => finish(transportError("connect", cause)),
        );

        return acknowledged.promise.then(() => finished.promise);
    }

    #newSnapshotRequest(generation: WorkspaceGeneration): SnapshotRequest {
        const result = Promise.withResolvers<SessionSnapshot>();
        const id = crypto.randomUUID();
        const decoder = new NdjsonDecoder();
        let socket: Bun.Socket | null = null;
        let completed = false;

        const remove = (): void => {
            const cancellers = this.#requestCancellers.get(generation);
            cancellers?.delete(cancel);
            if (cancellers?.size === 0) {
                this.#requestCancellers.delete(generation);
            }
            if (socket === null) {
                return;
            }
            const sockets = this.#requests.get(generation);
            sockets?.delete(socket);
            if (sockets?.size === 0) {
                this.#requests.delete(generation);
            }
        };

        const settle = (outcome: Either.Either<SessionSnapshot, HerdRClientError>): void => {
            if (completed) {
                return;
            }
            completed = true;
            remove();
            socket?.terminate();
            if (Either.isRight(outcome)) {
                result.resolve(outcome.right);
            } else {
                result.reject(outcome.left);
            }
        };

        const cancel = (reason: HerdRClientError): void => settle(Either.left(reason));
        let cancellers = this.#requestCancellers.get(generation);
        if (cancellers === undefined) {
            cancellers = new Set();
            this.#requestCancellers.set(generation, cancellers);
        }
        cancellers.add(cancel);

        const acceptFrame = (frame: string): void => {
            if (frame.length === 0) {
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(frame);
            } catch (cause) {
                void Effect.runPromise(
                    Effect.logWarning("herdr_malformed_frame", { cause: boundedCause(cause) }),
                );
                return;
            }

            const success = Schema.decodeUnknownEither(HerdRSuccessResponse)(parsed);
            if (Either.isRight(success) && success.right.id === id) {
                if (success.right.result.type !== "session_snapshot") {
                    settle(Either.left(protocolError("response", "unexpected snapshot response")));
                    return;
                }
                settle(Either.right(success.right.result.snapshot));
                return;
            }

            const failure = Schema.decodeUnknownEither(HerdRErrorResponse)(parsed);
            if (Either.isRight(failure) && failure.right.id === id) {
                settle(Either.left(protocolError("response", failure.right.error.message)));
                return;
            }
            if (
                parsed !== null &&
                typeof parsed === "object" &&
                "id" in parsed &&
                parsed.id === id
            ) {
                void Effect.runPromise(
                    Effect.logWarning("herdr_malformed_frame", {
                        cause: "malformed snapshot response",
                    }),
                );
            }
        };
        const finishAfterDecoderEnd = (cause: unknown): void => {
            try {
                for (const frame of decoder.end()) {
                    acceptFrame(frame);
                }
            } catch (error) {
                settle(
                    Either.left(
                        error instanceof NdjsonFramingError
                            ? protocolError("decode", error)
                            : transportError("read", error),
                    ),
                );
                return;
            }
            settle(Either.left(transportError("read", cause)));
        };

        void Bun.connect({
            unix: this.socketPath,
            socket: {
                binaryType: "uint8array",
                data: (_socket, data) => {
                    try {
                        for (const frame of decoder.push(data)) {
                            acceptFrame(frame);
                        }
                    } catch (cause) {
                        settle(
                            Either.left(
                                cause instanceof NdjsonFramingError
                                    ? protocolError("decode", cause)
                                    : transportError("read", cause),
                            ),
                        );
                    }
                },
                close: (_socket, error) =>
                    finishAfterDecoderEnd(error ?? new Error("HerdR request closed")),
                end: () => finishAfterDecoderEnd(new Error("HerdR request ended")),
                error: (_socket, error) => settle(Either.left(transportError("read", error))),
            },
        }).then(
            (connected) => {
                socket = connected;
                if (completed || this.#stopped) {
                    connected.terminate();
                    return;
                }
                let sockets = this.#requests.get(generation);
                if (sockets === undefined) {
                    sockets = new Set();
                    this.#requests.set(generation, sockets);
                }
                sockets.add(connected);
                writeReadOnlyRequest(connected, makeSessionSnapshotRequest(id));
            },
            (cause: unknown) => settle(Either.left(transportError("connect", cause))),
        );

        return { promise: result.promise, cancel };
    }

    #disconnect(generation: WorkspaceGeneration): void {
        if (this.#liveGeneration !== generation) {
            return;
        }
        this.#liveGeneration = null;
        const cancellers = this.#requestCancellers.get(generation);
        if (cancellers !== undefined) {
            for (const cancel of cancellers) {
                cancel(new StaleWorkspaceGeneration({ generation }));
            }
        }

        const sockets = this.#requests.get(generation);
        if (sockets !== undefined) {
            for (const socket of sockets) {
                socket.terminate();
            }
            this.#requests.delete(generation);
        }
        this.#publish(WorkspaceDisconnected.make({ generation }));
    }

    #publish(event: WorkspaceSourceEvent): void {
        void Effect.runPromise(PubSub.publish(this.#eventPubSub, event));
    }

    #sleep(milliseconds: number): Promise<void> {
        const sleep = Promise.withResolvers<void>();
        const timer = setTimeout(sleep.resolve, milliseconds);
        this.#cancelSleep = () => {
            clearTimeout(timer);
            sleep.resolve();
        };
        return sleep.promise.finally(() => {
            if (this.#cancelSleep !== null) {
                this.#cancelSleep = null;
            }
        });
    }

    #asClientError(
        cause: unknown,
        operation: "connect" | "request" | "subscribe" | "read",
    ): HerdRClientError {
        if (cause instanceof StaleWorkspaceGeneration) {
            return cause;
        }
        if (cause instanceof WorkspaceSourceTransportError) {
            return cause;
        }
        if (cause instanceof WorkspaceSourceProtocolError) {
            return cause;
        }
        if (cause instanceof UnsupportedHerdRProtocol) {
            return cause;
        }
        return transportError(operation, cause);
    }
}

/** A scoped, reconnecting Unix-socket HerdR client. */
export const makeHerdRClient = (environment: NodeJS.ProcessEnv = process.env) =>
    Effect.gen(function* () {
        const events = yield* PubSub.unbounded<WorkspaceSourceEvent>({ replay: 1 });
        const client = new LiveHerdRClient(events, environment);
        client.start();
        yield* Effect.addFinalizer(() =>
            Effect.sync(() => client.close()).pipe(Effect.zipRight(PubSub.shutdown(events))),
        );
        return client satisfies HerdRClientService;
    });

export const HerdRClientLive = Layer.scoped(HerdRClient, makeHerdRClient());
