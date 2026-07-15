import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HerdRClient, type HerdRClientService } from "./client.ts";
import { WorkspaceSource, type WorkspaceSourceService } from "../services/workspace-source.ts";

/** Exposes only HerdR's mapped workspace state to the editor-independent sync core. */
export const makeHerdRWorkspaceSource = (client: HerdRClientService): WorkspaceSourceService => ({
    snapshot: client.snapshot,
    events: client.events,
});

/** Requires a scoped HerdRClient and projects it onto the core WorkspaceSource tag. */
export const HerdRWorkspaceSourceLive = Layer.effect(
    WorkspaceSource,
    Effect.gen(function* () {
        const client = yield* HerdRClient;
        return makeHerdRWorkspaceSource(client);
    }),
);
