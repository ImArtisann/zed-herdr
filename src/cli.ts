import * as Effect from "effect/Effect";

import { runDaemon } from "./app.ts";
import { decodeAppConfig } from "./config.ts";

export const USAGE = "Usage: zed-herdr daemon";

const invalidCommand = Effect.sync(() => {
    console.error(USAGE);
    process.exitCode = 2;
});

export const runCli = (
    arguments_: ReadonlyArray<string> = process.argv.slice(2),
    environment: NodeJS.ProcessEnv = process.env,
) =>
    arguments_.length === 1 && arguments_[0] === "daemon"
        ? decodeAppConfig(environment).pipe(Effect.flatMap(runDaemon))
        : invalidCommand;
