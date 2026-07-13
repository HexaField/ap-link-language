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
import {
    diffNodeToActivity,
    projectionNoteToActivity,
    shouldFederate,
    linkOriginKey,
} from "./src/translate.js";
import * as store from "./src/store.js";
import * as dag from "./src/dag.js";
import { deliverToFollowers, emitDeliveryRequest } from "./src/delivery.js";
import { syncFromOutbox, collectOutboxActivities } from "./src/sync.js";
import { processInboxSignal } from "./src/inbox.js";
import { getFollowerInboxes } from "./src/security.js";
import { resolveAuthor } from "./src/actors.js";
import type { APActivity, APObject } from "./src/activitypub.js";

// Channel-B (Role B) projection — SHACL-driven native ⇄ graph transform.
import { makeActivityPubAdapter, apNoteBase, AP_NOTE_TYPE } from "./src/activitypub-projection.js";
import {
    parseProfiles,
    projectInstances,
    ingestNative,
    toAuthoredLink,
    defaultFluxMessageProfile,
    type ProjectionProfile,
} from "./src/projection/index.js";

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

/**
 * Deliver one already-built AP activity to the neighbourhood.
 *
 * Group-actor fan-out: every diff is POSTed to the neighbourhood's GROUP inbox,
 * which republishes it to the shared group outbox for all members to pull — the
 * real Fediverse group pattern (Lemmy/Guppe/Mobilizon members POST to the group
 * inbox and the group re-announces). Direct follower inboxes are additive (a peer
 * that follows us gets a copy immediately). With no delivery targets at all we
 * fall back to a federation-service signal.
 */
async function federateActivity(activity: APActivity): Promise<void> {
    const targets = new Set<string>();
    if (GROUP_INBOX_URL && !GROUP_INBOX_URL.startsWith("<")) targets.add(GROUP_INBOX_URL);
    for (const inbox of followerInboxes()) targets.add(inbox);

    if (targets.size > 0) {
        await deliverToFollowers(activity, [...targets], actorKeyId, GROUP_ACTOR_URL);
    } else {
        emitDeliveryRequest(activity, GROUP_ACTOR_URL);
    }
}

// ---------------------------------------------------------------------------
// Channel-B (Role B) projection wiring
//
// The AP adapter maps a generic Projection ⇄ a real ActivityStreams `Note`
// (wrapped in a Create for delivery, exactly like a Fediverse post). Which
// graph property fills the Note's `content` is decided by the SHACL projection
// profile — parsed from any projection://-annotated shapes in the perspective,
// falling back to the built-in Flux message profile (content field "content")
// so stock Flux projects without SDNA annotations. No app data is smuggled into
// the Note; the projection is derived from Role A and NEVER read back as truth
// (native-authored content is ingested through ingestNative → Channel A only).
// ---------------------------------------------------------------------------

/** The single Channel-B adapter (AS2 Note ⇄ Projection). */
const apAdapter = makeActivityPubAdapter();
const adapterFor = (): ReturnType<typeof makeActivityPubAdapter> => apAdapter;

/** Cached projection profiles; invalidated whenever SHACL shape links change. */
let cachedProfiles: ProjectionProfile[] | null = null;

/** Native Note ids already ingested into Channel A (echo/dup suppression). */
const ingestedIds: Set<string> = new Set();

function projectionProfiles(): ProjectionProfile[] {
    if (cachedProfiles) return cachedProfiles;
    const shapeLinks = store.allLinks().links.map((l) => ({
        source: l.data.source ?? "",
        predicate: l.data.predicate ?? "",
        target: l.data.target ?? "",
    }));
    const parsed = parseProfiles(shapeLinks);
    // Guarantee a profile targeting a Note so Flux always projects.
    cachedProfiles = parsed.some((p) => p.nativeType === AP_NOTE_TYPE)
        ? parsed
        : [...parsed, defaultFluxMessageProfile(AP_NOTE_TYPE, "content")];
    return cachedProfiles;
}

/** True if a diff adds/removes any SHACL shape or projection annotation link. */
function diffTouchesShapes(diff: PerspectiveDiff): boolean {
    const isShapePred = (p?: string) =>
        !!p && (p.startsWith("sh://") || p.startsWith("projection://") || p === "rdf://type");
    return diff.additions.some((l) => isShapePred(l.data.predicate)) ||
        diff.removals.some((l) => isShapePred(l.data.predicate));
}

function invalidateProfilesIfShapes(diff: PerspectiveDiff): void {
    if (diffTouchesShapes(diff)) cachedProfiles = null;
}

/**
 * Publish a locally-produced diff on Role A: append a diff-DAG node, keep the
 * derived caches in step, federate the node as a diff activity (unless
 * subscribe-only), and emit the materialised delta to the executor. Used for
 * native content ingested through Channel B, which must become authoritative
 * links exactly like a local commit — so pure-Fediverse posts converge into the
 * perspective's DAG rather than living only in the derived cache.
 */
async function publishDiffRoleA(diff: PerspectiveDiff): Promise<PerspectiveDiff> {
    // Append ONE diff-DAG node parented on the current heads. Removals (none for
    // ingest) would carry original link hashes; ingest only adds.
    const removalHashes = diff.removals.map((link) => store.hashLink(link));
    const node = dag.commitDiff(diff.additions, removalHashes, myDid);

    // Mark ingested links as ap-origin so they are not re-federated back out.
    const storage = getStorage();
    for (const link of diff.additions) {
        const originKey = linkOriginKey(store.hashLink(link));
        const existing = storage.get(originKey);
        if (existing === "native") storage.put(originKey, "dual");
        else if (!existing) storage.put(originKey, "ap");
    }

    // Fold the DAG → rebuild the derived cache; emit + return the actual delta.
    const applied = store.rebuildCacheFromDag();
    if (applied.additions.length > 0 || applied.removals.length > 0) {
        emitPerspectiveDiff(applied);
    }
    invalidateProfilesIfShapes(diff);

    // Federate the DAG node (as a diff activity) so peers converge on it too.
    if (settings.syncMode !== "subscribe-only" &&
        (diff.additions.length > 0 || removalHashes.length > 0)) {
        const activity = diffNodeToActivity(node, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: agentActorUrl(),
            published: new Date().toISOString(),
        });
        await federateActivity(activity);
    }

    return applied;
}

/**
 * Role-B outbound — project committed link additions to native Notes and
 * federate each as a Create{Note}. Derived and lossy: reconstructed from Role A
 * on every commit, never parsed back into links. No ad4m envelope is attached
 * (that rides Role A), so a projected Note is indistinguishable from an ordinary
 * Fediverse post.
 */
async function projectAndFederate(diff: PerspectiveDiff): Promise<void> {
    if (settings.rendering.strategy === "native") return;
    invalidateProfilesIfShapes(diff);

    const authored = diff.additions.map(toAuthoredLink);
    const projected = projectInstances(authored, projectionProfiles(), adapterFor);
    for (const p of projected) {
        const activity = projectionNoteToActivity(p.native, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: agentActorUrl(),
            base: p.base,
            published: p.timestamp,
        });
        await federateActivity(activity);
    }
}

/**
 * Role-B inbound — ingest genuinely native-authored Notes (from pure Fediverse
 * users with no AD4M bridge) into Channel A as new authoritative links.
 *
 * Echo suppression, mirroring the Matrix reference:
 *   - ad4m diff activities are Role-A substrate, not human content — skipped
 *     (they carry an ad4m:Diff tag, so fromNative would ignore them anyway, but
 *     we skip them explicitly);
 *   - our OWN projections are skipped by actor (== this agent's actor URL);
 *   - OTHER bridges' projections are skipped because their actor resolves to a
 *     known AD4M DID (resolveAuthor returns a `did:` — their links already
 *     arrived authoritatively via Role A). Only actors with NO DID mapping
 *     (resolveAuthor returns `ap:<url>`) are ingested;
 *   - already-ingested Notes are skipped by object id.
 *
 * No ad4m envelope is read; the SHACL projection maps native fields → links.
 * The resulting links are published on Role A via publishDiffRoleA, so they
 * enter the authoritative DAG.
 */
async function ingestNativeNotes(activities: APActivity[]): Promise<PerspectiveDiff> {
    if (settings.rendering.strategy === "native") return { additions: [], removals: [] };

    const myActorUrl = agentActorUrl();
    const additions: LinkExpression[] = [];

    for (const activity of activities) {
        if (activity.type !== "Create") continue;
        const obj = activity.object;
        if (typeof obj === "string") continue;
        const note = obj as APObject;

        // Role-A substrate node — not human content.
        if (Array.isArray(note.tag) && note.tag.some((t) => t.type === "ad4m:Diff")) continue;
        // Our own projection.
        if (activity.actor === myActorUrl) continue;

        // Only ingest content from actors with NO known AD4M DID mapping.
        const author = await resolveAuthor(activity.actor);
        if (author.startsWith("did:")) continue; // another AD4M agent — arrives via Role A

        // Idempotent by native id: never double-ingest the same Note.
        const noteId = typeof note.id === "string" ? note.id : "";
        if (!noteId || ingestedIds.has(noteId)) continue;

        const ingested = ingestNative(note, projectionProfiles(), adapterFor);
        if (!ingested) continue;

        const timestamp = ingested.timestamp
            ?? activity.published
            ?? new Date().toISOString();

        for (const link of ingested.links) {
            additions.push({
                author,
                timestamp,
                data: { source: link.source, target: link.target, predicate: link.predicate },
                proof: { signature: "", key: "" },
            });
        }
        ingestedIds.add(noteId);
    }

    if (additions.length > 0) {
        return await publishDiffRoleA({ additions, removals: [] });
    }
    return { additions: [], removals: [] };
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
        cachedProfiles = null;
        ingestedIds.clear();
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

            // 6. Encode the DAG node as a single diff activity and federate it
            //    (ROLE A — the authoritative convergence substrate). A no-op diff
            //    (nothing new to federate) produces no activity.
            if (additions.length > 0 || removalHashes.length > 0) {
                const activity = diffNodeToActivity(node, {
                    groupActorUrl: GROUP_ACTOR_URL,
                    actorUrl: agentActorUrl(),
                    published: new Date().toISOString(),
                });
                await federateActivity(activity);
            }

            // 7. ROLE B — derived native projection (optional, lossy, never
            //    truth). Render detected Flux messages as human-readable
            //    Create{Note} activities for Fediverse clients (Mastodon, etc.).
            //    No ad4m envelope is attached — this projection is reconstructed
            //    from Role A on sync, never parsed back into links. Only the
            //    federated (native-origin) additions are projected, so content
            //    that arrived over AP is not echoed back out as a fresh Note.
            await projectAndFederate({ additions, removals: diff.removals });

            // 8. Return the new revision — a content hash of the DAG head(s).
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

            // ROLE A — fold the emulated diff-DAG from the outbox (authoritative)
            // and project genuine external AP content (plain Notes/Likes/Deletes
            // from Fediverse users) into the derived cache.
            const dagDelta = await syncFromOutbox(
                GROUP_OUTBOX_URL,
                neighbourhoodUrl(),
                GROUP_ACTOR_URL,
            );

            // The executor DISCARDS sync()'s return value — an inbound peer fold
            // only becomes queryable when pushed through emitPerspectiveDiff (the
            // same host channel commit() uses). Without this, peers' diff-DAG nodes
            // are ingested and folded into the cache but never surface through
            // queryLinks. (Same trap as nostr/hypercore/solid/atproto.)
            if (dagDelta.additions.length > 0 || dagDelta.removals.length > 0) {
                emitPerspectiveDiff(dagDelta);
            }

            // ROLE B (inbound) — ingest genuinely native-authored Notes (from
            // pure Fediverse actors with NO AD4M DID) as NEW authoritative links
            // on Channel A. Bridged agents' content already arrived via the DAG
            // above and is skipped by DID resolution; our own projections are
            // skipped by actor. The outbox activities are the transport we scan.
            const activities = await collectOutboxActivities(GROUP_OUTBOX_URL);
            const ingestDelta = await ingestNativeNotes(activities);

            return {
                additions: [...dagDelta.additions, ...ingestDelta.additions],
                removals: [...dagDelta.removals, ...ingestDelta.removals],
            };
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
