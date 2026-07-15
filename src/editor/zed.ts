import * as Command from "@effect/platform/Command";
import * as CommandExecutor from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { isAbsolute } from "node:path";

import { EditorAdapterError } from "../domain/errors.ts";
import { EditorAdapter } from "../services/editor-adapter.ts";
import type { EditorAdapterService } from "../services/editor-adapter.ts";

export interface ZedEditorAdapterOptions {
    readonly executable?: string;
}

const fallbackExecutable = "/Applications/Zed.app/Contents/MacOS/cli";
const stderrLimit = 4_096;
const commandTimeout = "5 seconds";

type Operation = "ensure_project" | "focus_project";

type CommandFailure =
    | { readonly _tag: "StartFailure"; readonly error: PlatformError }
    | { readonly _tag: "ProcessFailure"; readonly error: PlatformError };

type AttemptFailure = CommandFailure | { readonly _tag: "Timeout"; readonly stderr: Uint8Array };

interface CommandResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
}

const appendStderrTail = (tail: Uint8Array, chunk: Uint8Array): Uint8Array => {
    if (chunk.byteLength >= stderrLimit) {
        return chunk.slice(chunk.byteLength - stderrLimit);
    }

    const retained = Math.min(tail.byteLength, stderrLimit - chunk.byteLength);
    const result = new Uint8Array(retained + chunk.byteLength);
    result.set(tail.subarray(tail.byteLength - retained));
    result.set(chunk, retained);
    return result;
};

const decodeStderr = (stderr: Uint8Array): string => new TextDecoder().decode(stderr);

const isExecutableNotFound = (failure: AttemptFailure): boolean =>
    failure._tag === "StartFailure" &&
    failure.error._tag === "SystemError" &&
    failure.error.reason === "NotFound";

const adapterError = (
    operation: Operation,
    path: string,
    failure: AttemptFailure,
): EditorAdapterError => {
    if (failure._tag === "Timeout") {
        return new EditorAdapterError({
            operation,
            path,
            exitCode: null,
            stderr: decodeStderr(failure.stderr),
            message: "Zed command timed out after 5 seconds",
        });
    }

    return new EditorAdapterError({
        operation,
        path,
        exitCode: null,
        stderr: "",
        message:
            failure.error.message.slice(-stderrLimit) || String(failure.error).slice(-stderrLimit),
    });
};

const nonzeroExitError = (
    operation: Operation,
    path: string,
    result: CommandResult,
): EditorAdapterError =>
    new EditorAdapterError({
        operation,
        path,
        exitCode: result.exitCode,
        stderr: decodeStderr(result.stderr),

        message: `Zed exited with code ${result.exitCode}`,
    });

const runCommand = (
    executor: CommandExecutor.CommandExecutor,
    executable: string,
    path: string,
): Effect.Effect<CommandResult, AttemptFailure> =>
    Effect.scoped(
        Effect.gen(function* () {
            const stderrTail = yield* Ref.make<Uint8Array<ArrayBufferLike>>(new Uint8Array());
            const command = Command.make(executable, "-e", path);
            const process = yield* executor
                .start(command)
                .pipe(
                    Effect.mapError((error): CommandFailure => ({ _tag: "StartFailure", error })),
                );
            const stderrFiber = yield* Stream.runForEach(process.stderr, (chunk) =>
                Ref.update(stderrTail, (tail) => appendStderrTail(tail, chunk)),
            ).pipe(
                Effect.mapError((error): CommandFailure => ({ _tag: "ProcessFailure", error })),
                Effect.forkScoped,
            );
            const stdoutFiber = yield* process.stdout.pipe(
                Stream.runDrain,
                Effect.mapError(
                    (error): CommandFailure => ({ _tag: "ProcessFailure", error }),
                ),
                Effect.forkScoped,
            );
            const exitCode = yield* process.exitCode.pipe(
                Effect.mapError((error): CommandFailure => ({ _tag: "ProcessFailure", error })),
                Effect.timeoutOption(commandTimeout),
            );

            if (Option.isNone(exitCode)) {
                yield* process
                    .kill("SIGKILL")
                    .pipe(
                        Effect.mapError(
                            (error): CommandFailure => ({ _tag: "ProcessFailure", error }),
                        ),
                    );
                yield* Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)], {
                    concurrency: "unbounded",
                });
                return yield* Effect.fail({
                    _tag: "Timeout",
                    stderr: yield* Ref.get(stderrTail),
                } satisfies AttemptFailure);
            }

            yield* Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)], {
                concurrency: "unbounded",
            });
            return {
                exitCode: exitCode.value,
                stderr: yield* Ref.get(stderrTail),
            };
        }),
    );

const runZed = (
    executor: CommandExecutor.CommandExecutor,
    executable: string | undefined,
    platform: string,
    operation: Operation,
    path: string,
): Effect.Effect<void, EditorAdapterError> => {
    if (!isAbsolute(path)) {
        return Effect.fail(
            new EditorAdapterError({
                operation,
                path: path || ".",
                exitCode: null,
                stderr: "",
                message: "Zed project path must be absolute",
            }),
        );
    }

    const primary = runCommand(executor, executable ?? "zed", path);
    const attempted =
        executable === undefined && platform === "darwin"
            ? primary.pipe(
                  Effect.catchAll((failure) =>
                      isExecutableNotFound(failure)
                          ? runCommand(executor, fallbackExecutable, path)
                          : Effect.fail(failure),
                  ),
              )
            : primary;

    return attempted.pipe(
        Effect.catchAll((failure) => Effect.fail(adapterError(operation, path, failure))),
        Effect.flatMap((result) =>
            result.exitCode === 0
                ? Effect.void
                : Effect.fail(nonzeroExitError(operation, path, result)),
        ),
    );
};

/**
 * Builds the Zed adapter. A configured executable is used directly; otherwise
 * `zed` is resolved by the command executor through PATH.
 */
export const makeZedEditorAdapter = (
    executable?: string,
    platform: string = process.platform,
): Effect.Effect<EditorAdapterService, never, CommandExecutor.CommandExecutor> =>
    Effect.gen(function* () {
        const executor = yield* CommandExecutor.CommandExecutor;
        const commands = yield* Effect.makeSemaphore(1);
        const ensuredRoots = new Set<string>();

        const execute = (operation: Operation, path: string) =>
            runZed(executor, executable, platform, operation, path).pipe(commands.withPermits(1));

        return {
            ensureProject: (path) =>
                commands.withPermits(1)(
                    Effect.suspend(() =>
                        ensuredRoots.has(path)
                            ? Effect.void
                            : runZed(executor, executable, platform, "ensure_project", path).pipe(
                                  Effect.tap(() =>
                                      Effect.sync(() => {
                                          ensuredRoots.add(path);
                                      }),
                                  ),
                              ),
                    ),
                ),
            focusProject: (path) => execute("focus_project", path),
        } satisfies EditorAdapterService;
    });

/** Creates the application layer that supplies the shared EditorAdapter tag. */
export const ZedEditorAdapter = (
    executable?: string,
): Layer.Layer<EditorAdapter, never, CommandExecutor.CommandExecutor> =>
    Layer.effect(EditorAdapter, makeZedEditorAdapter(executable));

export const makeZedEditorAdapterLayer = (
    options: ZedEditorAdapterOptions = {},
): Layer.Layer<EditorAdapter, never, CommandExecutor.CommandExecutor> =>
    Layer.effect(EditorAdapter, makeZedEditorAdapter(options.executable));
