import { expect, test } from "bun:test";
import * as Command from "@effect/platform/Command";
import * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as PlatformError from "@effect/platform/Error";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/TestClock";
import * as TestContext from "effect/TestContext";

import { makeZedEditorAdapter } from "../../src/editor/zed.ts";
import type { EditorAdapterService } from "../../src/services/editor-adapter.ts";

interface CommandCall {
    readonly args: ReadonlyArray<string>;
    readonly command: string;
    readonly shell: boolean | string;
}

interface ProcessPlan {
    readonly exitCode?: number;
    readonly exitEffect?: Effect.Effect<CommandExecutor.ExitCode, PlatformError.PlatformError>;
    readonly onKill?: () => void;
    readonly onStdoutChunk?: (chunk: Uint8Array) => void;
    readonly startError?: PlatformError.PlatformError;
    readonly stderr?: ReadonlyArray<Uint8Array>;
    readonly stdout?: ReadonlyArray<Uint8Array>;
}

interface ExecutorHarness {
    readonly calls: Array<CommandCall>;
    readonly executor: CommandExecutor.CommandExecutor;
    readonly kills: Array<CommandExecutor.Signal | undefined>;
    readonly runningStates: Array<() => boolean>;
}

const notFound = (path: string): PlatformError.PlatformError =>
    new PlatformError.SystemError({
        reason: "NotFound",
        module: "Command",
        method: "spawn",
        pathOrDescriptor: path,
    });

const permissionDenied = (path: string): PlatformError.PlatformError =>
    new PlatformError.SystemError({
        reason: "PermissionDenied",
        module: "Command",
        method: "spawn",
        pathOrDescriptor: path,
    });

const makeExecutor = (plans: ReadonlyArray<ProcessPlan>): ExecutorHarness => {
    const calls: Array<CommandCall> = [];
    const kills: Array<CommandExecutor.Signal | undefined> = [];
    const runningStates: Array<() => boolean> = [];
    let planIndex = 0;

    const executor = CommandExecutor.makeExecutor((command) =>
        Effect.suspend(() => {
            const standardCommand = Command.flatten(command)[0];
            calls.push({
                command: standardCommand.command,
                args: standardCommand.args,
                shell: standardCommand.shell,
            });
            const plan = plans[planIndex++] ?? {};
            if (plan.startError !== undefined) {
                return Effect.fail(plan.startError);
            }

            let running = true;
            const exitCode = (
                plan.exitEffect ?? Effect.succeed(CommandExecutor.ExitCode(plan.exitCode ?? 0))
            ).pipe(
                Effect.tap(() =>
                    Effect.sync(() => {
                        running = false;
                    }),
                ),
            );
            const process = {
                [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
                pid: CommandExecutor.ProcessId(planIndex),
                exitCode,
                isRunning: Effect.sync(() => running),
                kill: (signal?: CommandExecutor.Signal) =>
                    Effect.sync(() => {
                        running = false;
                        kills.push(signal);
                        plan.onKill?.();
                    }),
                stderr: Stream.fromIterable(plan.stderr ?? []),
                stdin: Sink.drain,
                stdout: Stream.fromIterable(plan.stdout ?? []).pipe(
                    Stream.tap((chunk) =>
                        Effect.sync(() => {
                            plan.onStdoutChunk?.(chunk);
                        }),
                    ),
                ),
            } as unknown as CommandExecutor.Process;
            runningStates.push(() => running);
            return Effect.addFinalizer(() =>
                Effect.suspend(() => (running ? process.kill().pipe(Effect.ignore) : Effect.void)),
            ).pipe(Effect.as(process));
        }),
    );

    return { calls, executor, kills, runningStates };
};

const withAdapter = <Value, Failure>(
    harness: ExecutorHarness,
    body: (adapter: EditorAdapterService) => Effect.Effect<Value, Failure>,
    executable?: string,
    platform?: string,
): Promise<Value> =>
    Effect.runPromise(
        makeZedEditorAdapter(executable, platform).pipe(
            Effect.provideService(CommandExecutor.CommandExecutor, harness.executor),
            Effect.flatMap(body),
        ),
    );

test("uses the configured executable for exact shell-free Zed argv", async () => {
    const harness = makeExecutor([{}]);

    await withAdapter(harness, (adapter) => adapter.ensureProject("/repos/alpha"), "/tools/zed");

    expect(harness.calls).toEqual([
        { command: "/tools/zed", args: ["-e", "/repos/alpha"], shell: false },
    ]);
});

test("drains every stdout chunk before a successful command completes", async () => {
    const encoder = new TextEncoder();
    const stdout = [encoder.encode("opened "), encoder.encode("workspace\n")];
    const drained: Array<Uint8Array> = [];
    const harness = makeExecutor([
        {
            stdout,
            onStdoutChunk: (chunk) => drained.push(chunk),
        },
    ]);

    await withAdapter(harness, (adapter) => adapter.ensureProject("/repos/alpha"), "/tools/zed");

    expect(drained).toEqual(stdout);
    expect(harness.kills).toEqual([]);
});

test("uses PATH-resolved zed by default without probes or shell commands", async () => {
    const harness = makeExecutor([{}]);

    await withAdapter(
        harness,
        (adapter) => adapter.focusProject("/repos/alpha"),
        undefined,
        "linux",
    );

    expect(harness.calls).toEqual([{ command: "zed", args: ["-e", "/repos/alpha"], shell: false }]);
});

test("uses the macOS bundled CLI only after PATH zed is not found", async () => {
    const harness = makeExecutor([{ startError: notFound("zed") }, {}]);

    await withAdapter(
        harness,
        (adapter) => adapter.focusProject("/repos/alpha"),
        undefined,
        "darwin",
    );

    expect(harness.calls.map((call) => call.command)).toEqual([
        "zed",
        "/Applications/Zed.app/Contents/MacOS/cli",
    ]);
    expect(harness.calls.every((call) => call.args[0] === "-e" && call.shell === false)).toBe(true);
});

test("does not fall back for configured binaries, non-macOS hosts, or non-not-found failures", async () => {
    const configured = makeExecutor([{ startError: notFound("/tools/zed") }]);
    const linux = makeExecutor([{ startError: notFound("zed") }]);
    const denied = makeExecutor([{ startError: permissionDenied("zed") }]);

    for (const [harness, executable, platform] of [
        [configured, "/tools/zed", "darwin"],
        [linux, undefined, "linux"],
        [denied, undefined, "darwin"],
    ] as const) {
        const result = await withAdapter(
            harness,
            (adapter) => adapter.ensureProject("/repos/alpha").pipe(Effect.either),
            executable,
            platform,
        );
        expect(result._tag).toBe("Left");
        expect(harness.calls).toHaveLength(1);
    }
});

test("serializes registrations and caches only successful ensure roots", async () => {
    const gate = await Effect.runPromise(Deferred.make<CommandExecutor.ExitCode>());
    const harness = makeExecutor([{ exitEffect: Deferred.await(gate) }, {}, { exitCode: 3 }, {}]);

    await Effect.runPromise(
        makeZedEditorAdapter().pipe(
            Effect.provideService(CommandExecutor.CommandExecutor, harness.executor),
            Effect.flatMap((adapter) =>
                Effect.gen(function* () {
                    const first = yield* adapter.ensureProject("/repos/alpha").pipe(Effect.fork);
                    const second = yield* adapter.focusProject("/repos/beta").pipe(Effect.fork);
                    yield* Effect.yieldNow();
                    yield* Effect.yieldNow();
                    expect(harness.calls).toHaveLength(1);

                    yield* Deferred.succeed(gate, CommandExecutor.ExitCode(0));
                    yield* Fiber.join(first);
                    yield* Fiber.join(second);
                    yield* adapter.ensureProject("/repos/alpha");

                    const failed = yield* adapter.ensureProject("/repos/retry").pipe(Effect.either);
                    expect(failed._tag).toBe("Left");
                    yield* adapter.ensureProject("/repos/retry");
                }),
            ),
        ),
    );

    expect(harness.calls.map((call) => call.args[1])).toEqual([
        "/repos/alpha",
        "/repos/beta",
        "/repos/retry",
        "/repos/retry",
    ]);
});

test("reports nonzero exits with exit code and final stderr tail", async () => {
    const harness = makeExecutor([
        {
            exitCode: 9,
            stderr: [new TextEncoder().encode("zed denied")],
        },
    ]);

    const result = await withAdapter(harness, (adapter) =>
        adapter.focusProject("/repos/alpha").pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
        expect(result.left.exitCode).toBe(9);
        expect(result.left.stderr).toBe("zed denied");
        expect(result.left.operation).toBe("focus_project");
    }
});

test("kills and awaits the scoped process when the five-second timeout expires", async () => {
    const completed = await Effect.runPromise(Deferred.make<CommandExecutor.ExitCode>());
    const harness = makeExecutor([
        {
            exitEffect: Deferred.await(completed),
            onKill: () => {
                Deferred.unsafeDone(completed, Effect.succeed(CommandExecutor.ExitCode(143)));
            },
        },
    ]);

    await Effect.runPromise(
        makeZedEditorAdapter()
            .pipe(
                Effect.provideService(CommandExecutor.CommandExecutor, harness.executor),
                Effect.flatMap((adapter) =>
                    Effect.gen(function* () {
                        const fiber = yield* adapter
                            .ensureProject("/repos/alpha")
                            .pipe(Effect.fork);
                        yield* Effect.yieldNow();
                        yield* TestClock.adjust("5 seconds");
                        const exit = yield* Fiber.await(fiber);
                        expect(Exit.isFailure(exit)).toBe(true);
                        expect(harness.kills).toEqual(["SIGKILL"]);
                        expect(harness.runningStates).toHaveLength(1);
                        expect(harness.runningStates[0]?.()).toBe(false);
                    }),
                ),
            )
            .pipe(Effect.provide(TestContext.TestContext)),
    );
});

test("bounds incrementally drained stderr to its final 4096 bytes", async () => {
    const prefix = new Uint8Array(2_048).fill(65);
    const suffix = new Uint8Array(4_096).fill(66);
    const harness = makeExecutor([{ exitCode: 1, stderr: [prefix, suffix] }]);

    const result = await withAdapter(harness, (adapter) =>
        adapter.ensureProject("/repos/alpha").pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
        expect(result.left.stderr).toHaveLength(4_096);
        expect(result.left.stderr).toBe("B".repeat(4_096));
    }
});
