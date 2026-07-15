import * as Command from "@effect/platform/Command";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { FileSystem } from "@effect/platform/FileSystem";
import { Path } from "@effect/platform/Path";

import { WorkspaceResolutionError } from "../domain/errors.ts";
import { WorkspaceProject } from "../domain/workspace.ts";
import type { WorkspaceId, WorkspaceRecord } from "../domain/workspace.ts";

export type WorkspaceCwdHints = ReadonlyMap<WorkspaceId, string>;

const resolutionError = (
    workspace: WorkspaceRecord,
    operation: WorkspaceResolutionError["operation"],
    reason: WorkspaceResolutionError["reason"],
    path: string | null,
): WorkspaceResolutionError =>
    new WorkspaceResolutionError({
        workspaceId: workspace.workspaceId,
        workspace: workspace.name,
        path,
        operation,
        reason,
    });

const resolveGitRoot = (candidate: string, workspace: WorkspaceRecord) =>
    Effect.scoped(
        Effect.gen(function* () {
            const process = yield* Command.start(
                Command.make("git", "-C", candidate, "rev-parse", "--show-toplevel"),
            );
            const stdout = yield* process.stdout.pipe(
                Stream.decodeText(),
                Stream.runFold("", (output, chunk) => output + chunk),
                Effect.forkScoped,
            );
            const stderr = yield* process.stderr.pipe(Stream.runDrain, Effect.forkScoped);
            const exitCode = yield* process.exitCode;
            const [output] = yield* Effect.all([Fiber.join(stdout), Fiber.join(stderr)]);

            if (exitCode !== 0) {
                return yield* Effect.fail(
                    resolutionError(workspace, "git_root", "not_git_repository", candidate),
                );
            }

            const root = output.endsWith("\n") ? output.slice(0, -1) : output;
            if (root.length === 0) {
                return yield* Effect.fail(
                    resolutionError(workspace, "git_root", "not_git_repository", candidate),
                );
            }

            return root;
        }),
    ).pipe(
        Effect.catchAll((error) =>
            error._tag === "WorkspaceResolutionError"
                ? Effect.fail(error)
                : Effect.fail(
                      resolutionError(workspace, "git_root", "inaccessible_path", candidate),
                  ),
        ),
    );

export const resolveProject = (
    workspace: WorkspaceRecord,
    cwdHints: WorkspaceCwdHints,
): Effect.Effect<WorkspaceProject, WorkspaceResolutionError, FileSystem | Path | CommandExecutor> =>
    Effect.gen(function* () {
        const fileSystem = yield* FileSystem;
        const path = yield* Path;
        const hintedCwd = cwdHints.get(workspace.workspaceId);
        const source = workspace.checkoutPath === null ? "plugin" : "worktree";
        const unresolvedCandidate = workspace.checkoutPath ?? hintedCwd;

        if (unresolvedCandidate === undefined) {
            return yield* Effect.fail(
                resolutionError(
                    workspace,
                    source === "worktree" ? "resolve_checkout_path" : "resolve_cwd_hint",
                    "missing_path",
                    null,
                ),
            );
        }

        const candidate = path.resolve(unresolvedCandidate);
        const info = yield* fileSystem
            .stat(candidate)
            .pipe(
                Effect.mapError(() =>
                    resolutionError(workspace, "stat", "inaccessible_path", candidate),
                ),
            );
        if (info.type !== "Directory") {
            return yield* Effect.fail(
                resolutionError(workspace, "stat", "not_directory", candidate),
            );
        }

        const gitRoot = path.resolve(yield* resolveGitRoot(candidate, workspace));
        return WorkspaceProject.make({
            workspaceId: workspace.workspaceId,
            name: workspace.name,
            cwd: candidate,
            gitRoot,
            source,
            isLinkedWorktree: workspace.isLinkedWorktree,
        });
    });
