/**
 * # ActivityPub Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via ActivityPub federation.
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Publishes links as AP activities, processes inbound activities from
 * the group inbox, handles Follow/Accept/Undo handshake, and polls
 * remote outboxes.
 *
 * Spec: activitypub-link-language.md
 */

import {
    defineLanguage,
    agentDid,
    hash,
    languageSettings,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";

import type { PerspectiveDiff, LinkExpression } from "./src/types.js";
import { parseSettings } from "./src/settings.js";
import type { APLanguageSettings } from "./src/settings.js";
import { diffNodeToActivity, shouldFederate, linkOriginKey } from "./src/translate.js";
import * as store from "./src/store.js";
import * as dag from "./src/dag.js";
import { deliverToFollowers } from "./src/delivery.js";
import { syncFromOutbox } from "./src/sync.js";
import { processInboxSignal } from "./src/inbox.js";
import { getFollowerInboxes } from "./src/security.js";

// Adapter imports
import { initTransport, initStorage, getStorage, initSigning, initRuntime } from "./src/adapters.js";
import { DenoTransport, DenoStorageAdapter, DenoSigningAdapter, DenoRuntime } from "./src/adapters-deno.js";

// ---------------------------------------------------------------------------
// Template Variables (per Spec §6)
// ---------------------------------------------------------------------------

//!@ad4m-template-variable
const GROUP_ACTOR_URL = "<to-be-filled>";

//!@ad4m-template-variable
const GROUP_INBOX_URL = "<to-be-filled>";

//!@ad4m-template-variable
const GROUP_OUTBOX_URL = "<to-be-filled>";

//!@ad4m-template-variable
const FEDERATION_DOMAIN = "<to-be-filled>";

//!@ad4m-template-variable
const NEIGHBOURHOOD_META = "<to-be-filled>";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let settings: APLanguageSettings;
let actorKeyId: string = "";

/**
 * Derive the AP Actor URL for the current agent on this federation domain.
 */
function agentActorUrl(): string {
    return `https://${FEDERATION_DOMAIN}/ap/v1/users/${encodeURIComponent(myDid)}`;
}

/**
 * Get the neighbourhood URL from the language address.
 */
function neighbourhoodUrl(): string {
    // In production this would use languageAddress() but that's
    // only available at runtime. Template variable serves as fallback.
    return `neighbourhood://${GROUP_ACTOR_URL}`;
}

/**
 * Read follower inbox URLs from the security module's follower store.
 */
function followerInboxes(): string[] {
    return getFollowerInboxes();
}

// ---------------------------------------------------------------------------
// Language definition
// ---------------------------------------------------------------------------

const language = defineLanguage({
    name: "@coasys/ap-link-language",
    version: "0.4.0",

    isPublic: true,

    async init() {
        // Initialize adapters before anything else
        initRuntime(new DenoRuntime());
        initStorage(new DenoStorageAdapter());
        initTransport(new DenoTransport());
        initSigning(new DenoSigningAdapter());
        // Wire the content-address hash into the store AND the diff-DAG so link
        // hashes are identical everywhere (required for removal convergence).
        store.initStore(hash);

        myDid = agentDid();
        settings = parseSettings(languageSettings());
        actorKeyId = `${GROUP_ACTOR_URL}#main-key`;

        console.log(`[ap-link-language] init: did=${myDid}, domain=${FEDERATION_DOMAIN}`);
        console.log(`[ap-link-language] group actor: ${GROUP_ACTOR_URL}`);
        console.log(`[ap-link-language] sync mode: ${settings.syncMode}`);
        console.log(`[ap-link-language] membership: ${settings.membership}`);
    },

    async teardown() {
        myDid = "";
        console.log("[ap-link-language] teardown");
    },

    interactions() {
        return [];
    },

    // -----------------------------------------------------------------------
    // perspective-commit — appends a node to the emulated diff-DAG
    // -----------------------------------------------------------------------
    commit: {
        async commit(diff: PerspectiveDiff) {
            // 1. Determine which additions to federate (skip links that arrived
            //    via AP to avoid echo loops), and which removals refer to links
            //    the DAG actually governs.
            const federationFilter = (linkHash: string): boolean =>
                shouldFederate(linkHash, (key) => getStorage().get(key));

            const additions = diff.additions.filter((link) =>
                federationFilter(store.hashLink(link)),
            );
            // Removals carry the ORIGINAL link hash — this is the removal fix.
            const removalHashes = diff.removals.map((link) => store.hashLink(link));

            // 2. Append ONE diff-DAG node parented on the current heads. Its
            //    content hash becomes (part of) the new revision. This is the
            //    authoritative write; the KV cache is derived from it below.
            const node = dag.commitDiff(additions, removalHashes, myDid);

            // 3. Track origins so a link that later arrives back over AP is not
            //    re-federated (dual-language dedup).
            const storage = getStorage();
            for (const link of additions) {
                const originKey = linkOriginKey(store.hashLink(link));
                const existing = storage.get(originKey);
                if (existing === "ap") storage.put(originKey, "dual");
                else if (!existing) storage.put(originKey, "native");
            }

            // 4. Rebuild the derived link cache by folding the DAG, then emit
            //    the ACTUAL materialised delta to local subscribers.
            const applied = store.rebuildCacheFromDag();
            emitPerspectiveDiff(applied);

            // 5. In subscribe-only mode we converge locally but never publish.
            if (settings.syncMode === "subscribe-only") {
                return dag.currentRevision();
            }

            // 6. Encode the DAG node as a single diff activity and federate it.
            //    A no-op diff (nothing to federate) produces no activity.
            if (additions.length === 0 && removalHashes.length === 0) {
                return dag.currentRevision();
            }
            const activity = diffNodeToActivity(node, {
                groupActorUrl: GROUP_ACTOR_URL,
                actorUrl: agentActorUrl(),
                published: new Date().toISOString(),
            });

            const inboxes = followerInboxes();
            if (inboxes.length > 0) {
                await deliverToFollowers(activity, inboxes, actorKeyId, GROUP_ACTOR_URL);
            } else {
                const { emitDeliveryRequest } = await import("./src/delivery.js");
                emitDeliveryRequest(activity, GROUP_ACTOR_URL);
            }

            // 7. Return the new revision — a content hash of the DAG head(s).
            return dag.currentRevision();
        },
    },

    // -----------------------------------------------------------------------
    // perspective-sync — walks the emulated diff-DAG and folds it
    // -----------------------------------------------------------------------
    sync: {
        async sync() {
            // Skip outbox sync in publish-only mode
            if (settings.syncMode === "publish-only") {
                return { additions: [], removals: [] };
            }
            return await syncFromOutbox(GROUP_OUTBOX_URL, neighbourhoodUrl(), GROUP_ACTOR_URL);
        },

        async render() {
            return store.allLinks();
        },

        async currentRevision() {
            // A content hash of the diff-DAG head(s) — never an activity id URL.
            return store.getRevision() || "";
        },
    },

    // -----------------------------------------------------------------------
    // perspective-query
    // -----------------------------------------------------------------------
    query: {
        supportedKinds() {
            return ["link-pattern"];
        },

        async run(req: { kind: string; payload: unknown }) {
            if (req.kind !== "link-pattern") {
                return { kind: "error", payload: `Unsupported query kind: ${req.kind}` };
            }
            const pattern = req.payload as { source?: string; target?: string; predicate?: string };
            const links = store.queryLinks(pattern);
            return { kind: "links", payload: links };
        },
    },

    // -----------------------------------------------------------------------
    // peers
    // -----------------------------------------------------------------------
    peers: {
        setLocal(agents: string[]) {
            // Store local agent set as peers
            for (const did of agents) {
                store.setPeer(did, { local: true });
            }
        },

        async remote() {
            // Remote peers are AP followers with DIDs
            return store.listPeers("peers/");
        },
    },
});

// ---------------------------------------------------------------------------
// Flat exports (required by the AD4M runtime dispatcher)
// ---------------------------------------------------------------------------

export const {
    name,
    version,
    isPublic,
    init,
    teardown,
    interactions,
    perspectiveCommit,
    perspectiveSyncSync,
    perspectiveSyncRender,
    perspectiveSyncCurrentRevision,
    perspectiveQuerySupportedKinds,
    perspectiveQueryRun,
    peersSetLocal,
    peersRemote,
} = language;

export default language;

// ---------------------------------------------------------------------------
// Callback registration
// Mirrors centralized-p-diff-sync for runtime compatibility.
// ---------------------------------------------------------------------------

let linkCallback: ((diff: PerspectiveDiff) => void) | null = null;
let syncStateChangeCallback: ((state: string) => void) | null = null;

export function linkSyncAddCallback(callback: (diff: PerspectiveDiff) => void): number {
    linkCallback = callback;
    return 1;
}

export function linkSyncRemoveCallback(callback: (diff: PerspectiveDiff) => void): number {
    if (linkCallback === callback) linkCallback = null;
    return 1;
}

export function linkSyncAddSyncStateChangeCallback(callback: (state: string) => void): number {
    syncStateChangeCallback = callback;
    return 1;
}

// ---------------------------------------------------------------------------
// Signal-based inbox handler
// ---------------------------------------------------------------------------

/**
 * Handle signals emitted by the executor.
 *
 * The executor forwards inbound AP inbox POSTs as signals to the language.
 * This handler processes them through the inbox pipeline:
 * activity parsing → actor resolution → security checks → link storage.
 */
export async function handleSignal(signalData: string): Promise<void> {
    let signal: unknown;
    try {
        signal = JSON.parse(signalData);
    } catch {
        return; // Not JSON — not our signal
    }

    const result = await processInboxSignal(
        signal,
        neighbourhoodUrl(),
        GROUP_ACTOR_URL,
        actorKeyId,
        settings,
    );

    // Notify the link callback if we produced a diff
    if (result.kind === "link-diff" && linkCallback) {
        linkCallback(result.diff);
    }

    if (result.kind === "rejected" || result.kind === "ignored") {
        console.log(`[ap-link-language] signal ${result.kind}: ${result.reason}`);
    }
}
