import { expect, test } from "bun:test";
import * as BunContext from "@effect/platform-bun/BunContext";
import * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as PlatformError from "@effect/platform/Error";
import * as Effect from "effect/Effect";
import * as Inspectable from "effect/Inspectable";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkspaceId, WorkspaceRecord } from "../../src/domain/workspace.ts";
import { resolveProject } from "../../src/sync/resolve-project.ts";

interface ProcessPlan {
    readonly stdout?: ReadonlyArray<string>;
    readonly exitCode?: number;
    readonly spawnFailure?: PlatformError.PlatformError;
}

const encoder = new TextEncoder();

const workspace = (checkoutPath: string): WorkspaceRecord => ({
    workspaceId: "workspace-1" as WorkspaceId,
    name: "Workspace 1",
    checkoutPath,
    isLinkedWorktree: false,
});

const makeExecutor = (plan: ProcessPlan): CommandExecutor.CommandExecutor =>
    CommandExecutor.makeExecutor(() => {
        if (plan.spawnFailure !== undefined) {
            return Effect.fail(plan.spawnFailure);
        }

        const process: CommandExecutor.Process = {
            [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
            pid: CommandExecutor.ProcessId(1),
            exitCode: Effect.succeed(CommandExecutor.ExitCode(plan.exitCode ?? 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stderr: Stream.empty,
            stdin: Sink.drain,
            stdout: Stream.fromIterable((plan.stdout ?? []).map((chunk) => encoder.encode(chunk))),
            toJSON: () => ({ pid: 1 }),
            toString: () => "Process(1)",
            [Inspectable.NodeInspectSymbol]: () => ({ pid: 1 }),
        };
        return Effect.succeed(process);
    });

const resolveWith = (candidate: string, plan: ProcessPlan) =>
    resolveProject(workspace(candidate), new Map()).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, makeExecutor(plan)),
        Effect.provide(BunContext.layer),
    );

const withTemporaryDirectory = async <A>(body: (directory: string) => Promise<A>): Promise<A> => {
    const directory = await mkdtemp(join(tmpdir(), "zed-herdr-resolver-test-"));
    try {
        return await body(await realpath(directory));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
};

test("preserves whitespace and embedded newlines in the Git-emitted root", async () => {
    await withTemporaryDirectory(async (directory) => {
        const emittedRoot = join(directory, " leading\ntrailing ");
        const project = await Effect.runPromise(
            resolveWith(directory, {
                stdout: [emittedRoot.slice(0, 8), `${emittedRoot.slice(8)}\n`],
            }),
        );

        expect(project.gitRoot).toBe(emittedRoot);
    });
});

test("maps command spawn failures to inaccessible_path", async () => {
    await withTemporaryDirectory(async (directory) => {
        const error = await Effect.runPromise(
            Effect.flip(
                resolveWith(directory, {
                    spawnFailure: new PlatformError.BadArgument({
                        module: "Command",
                        method: "start",
                        description: "spawn failed",
                    }),
                }),
            ),
        );

        expect(error.reason).toBe("inaccessible_path");
        expect(error.operation).toBe("git_root");
        expect(error.path).toBe(directory);
    });
});

test("keeps non-zero and empty successful Git results as not_git_repository", async () => {
    await withTemporaryDirectory(async (directory) => {
        const nonZero = await Effect.runPromise(
            Effect.flip(resolveWith(directory, { exitCode: 128, stdout: ["ignored\n"] })),
        );
        const empty = await Effect.runPromise(
            Effect.flip(resolveWith(directory, { exitCode: 0, stdout: [] })),
        );

        expect(nonZero.reason).toBe("not_git_repository");
        expect(empty.reason).toBe("not_git_repository");
    });
});
