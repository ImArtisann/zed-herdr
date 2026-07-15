import * as Effect from "effect/Effect";

import { runDaemon } from "./app.ts";
import { decodeAppConfig } from "./config.ts";
import { CONTROL_DAEMON_IDENTITY, controlSocketPath, healthControl } from "./plugin/control.ts";
import { runHook } from "./plugin/hook.ts";

export const USAGE = "Usage: zed-herdr <daemon|hook|health>";

const invalidCommand = Effect.sync(() => {
    console.error(USAGE);
    process.exitCode = 2;
});

const commandFailed = (cause: unknown) =>
    Effect.sync(() => {
        const rendered = cause instanceof Error ? cause.message : String(cause);
        console.error(rendered.length <= 4_096 ? rendered : rendered.slice(-4_096));
        process.exitCode = 1;
    });

const runHealth = (environment: NodeJS.ProcessEnv) =>
    Effect.tryPromise({
        try: () => healthControl(controlSocketPath(environment)),
        catch: (cause) => cause,
    }).pipe(
        Effect.matchEffect({
            onFailure: commandFailed,
            onSuccess: (daemon) =>
                daemon.identity === CONTROL_DAEMON_IDENTITY
                    ? Effect.sync(() => {
                          console.log(JSON.stringify({ ok: true, daemon }));
                      })
                    : commandFailed("Control socket returned the wrong daemon identity"),
        }),
    );

const runPluginHook = (environment: NodeJS.ProcessEnv) =>
    Effect.tryPromise({
        try: () => runHook({ environment }),
        catch: (cause) => cause,
    }).pipe(
        Effect.matchEffect({
            onFailure: commandFailed,
            onSuccess: () => Effect.void,
        }),
    );

export const runCli = (
    arguments_: ReadonlyArray<string> = process.argv.slice(2),
    environment: NodeJS.ProcessEnv = process.env,
) => {
    if (arguments_.length !== 1) {
        return invalidCommand;
    }
    switch (arguments_[0]) {
        case "daemon":
            return decodeAppConfig(environment).pipe(
                Effect.flatMap((config) => runDaemon(config, environment)),
            );
        case "health":
            return runHealth(environment);
        case "hook":
            return runPluginHook(environment);
        default:
            return invalidCommand;
    }
};
