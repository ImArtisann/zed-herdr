import * as BunRuntime from "@effect/platform-bun/BunRuntime";

import { runCli } from "./src/cli.ts";

BunRuntime.runMain(runCli(), { disablePrettyLogger: true });
