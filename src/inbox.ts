/**
 * Inbox processing — runtime wrapper.
 * Connects inbox signal processing to the storage layer and
 * perspective diff emission.
 *
 * Also includes: Pure inbox processing logic (was inbox.pure.ts).
 * Spec §2.1.
 */

import { getRuntime, getStorage } from "./adapters.js";

import type { APActivity, APObject } from "./activitypub.js";
import type { APLanguageSettings } from "./settings.js";
import type { PerspectiveDiff } from "./types.js";
import type { LinkExpression } from "./types.js";
import { linkOriginKey } from "./translate.js";
import type { LinkOrigin } from "./translate.js";
import { resolveAuthor } from "./actors.js";
import { isAllowedToPost, checkRateLimit } from "./security.js";
import { handleFollow, handleUndo } from "./follow.js";
import * as store from "./store.js";
import { inboundActivityToLink, inboundActivityToLinks, isDiffActivity } from "./translate.js";
import { ingestDiffActivities } from "./sync.js";

// ---------------------------------------------------------------------------
// Pure inbox types and functions (was inbox.pure.ts)
// ---------------------------------------------------------------------------

export interface InboxSignal {
    type: "ap-inbox-activity";
    activity: APActivity;
    verified: boolean;
}

export type InboxProcessResult =
    | { kind: "link-diff"; diff: PerspectiveDiff }
    | { kind: "diff-node"; activity: APActivity }
    | { kind: "follow"; activity: APActivity }
    | { kind: "undo"; activity: APActivity }
    | { kind: "accept"; activity: APActivity }
    | { kind: "rejected"; reason: string }
    | { kind: "ignored"; reason: string };

export function parseInboxSignal(signal: unknown): InboxSignal | null {
    if (!signal || typeof signal !== "object") return null;
    const s = signal as Record<string, unknown>;
    if (s.type !== "ap-inbox-activity") return null;
    if (!s.activity || typeof s.activity !== "object") return null;
    const activity = s.activity as APActivity;
    if (!activity.type || !activity.actor || !activity.id) return null;
    return {
        type: "ap-inbox-activity",
        activity,
        verified: typeof s.verified === "boolean" ? s.verified : false,
    };
}

export function routeInboundActivity(
    activity: APActivity,
    neighbourhoodUrl: string,
    settings: APLanguageSettings,
    verified: boolean,
    authorDid?: string,
    groupActorUrl?: string,
): InboxProcessResult {
    if (settings.syncMode === "publish-only") {
        if (activity.type !== "Follow" && activity.type !== "Undo" && activity.type !== "Accept") {
            return { kind: "rejected", reason: "syncMode is publish-only; inbound content rejected" };
        }
    }

    switch (activity.type) {
        case "Follow":
            return { kind: "follow", activity };
        case "Undo":
            return { kind: "undo", activity };
        case "Accept":
            return { kind: "accept", activity };
        case "Create":
        case "Delete":
        case "Like":
        case "Announce": {
            // ad4m diff activities are convergence-substrate nodes, not
            // human-facing content — route them into the diff-DAG.
            if (isDiffActivity(activity)) {
                return { kind: "diff-node", activity };
            }
            const links = groupActorUrl
                ? inboundActivityToLinks(activity, neighbourhoodUrl, groupActorUrl)
                : (() => {
                    const single = inboundActivityToLink(activity, neighbourhoodUrl);
                    return single ? [single] : [];
                })();

            if (links.length === 0) {
                return { kind: "ignored", reason: `Could not translate ${activity.type} activity to link` };
            }

            for (const link of links) {
                if (authorDid) link.author = authorDid;
                if (!verified || !authorDid?.startsWith("did:")) {
                    (link as LinkExpression & { status?: string }).status = "unverified";
                }
            }

            const diff: PerspectiveDiff = activity.type === "Delete"
                ? { additions: [], removals: links }
                : { additions: links, removals: [] };

            return { kind: "link-diff", diff };
        }
        default:
            return { kind: "ignored", reason: `Unsupported activity type: ${activity.type}` };
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Process an inbound inbox signal from the executor.
 *
 * Full pipeline:
 * 1. Parse and validate the signal
 * 2. Resolve the actor's identity (DID or ap: prefix)
 * 3. Check security (membership, rate limit, block list)
 * 4. Route to appropriate handler
 * 5. Store resulting links and emit perspective diffs
 *
 * Returns the processing result for logging/debugging.
 */
export async function processInboxSignal(
    signal: unknown,
    neighbourhoodUrl: string,
    groupActorUrl: string,
    actorKeyId: string,
    settings: APLanguageSettings,
): Promise<InboxProcessResult> {
    // 1. Parse signal
    const parsed = parseInboxSignal(signal);
    if (!parsed) {
        return { kind: "ignored", reason: "Not a valid inbox signal" };
    }

    const { activity, verified } = parsed;

    // 2. Resolve actor identity
    const authorDid = await resolveAuthor(activity.actor);

    // 3. Security checks (skip for Follow/Undo/Accept)
    if (activity.type !== "Follow" && activity.type !== "Undo" && activity.type !== "Accept") {
        // Check block list and membership
        const membershipResult = isAllowedToPost(activity.actor, settings, authorDid);
        if (!membershipResult.allowed) {
            return { kind: "rejected", reason: membershipResult.reason || "Not allowed to post" };
        }

        // Check rate limit
        if (!checkRateLimit(activity.actor, settings)) {
            return { kind: "rejected", reason: "Rate limit exceeded" };
        }
    }

    // 4. Route the activity (with group actor URL for enhanced inbound)
    const result = routeInboundActivity(activity, neighbourhoodUrl, settings, verified, authorDid, groupActorUrl);

    // 5. Handle results
    const storage = getStorage();

    switch (result.kind) {
        case "diff-node": {
            // Ingest the diff-DAG node (verifies its content hash), fold the
            // DAG to rebuild the derived cache, and emit the materialised delta.
            ingestDiffActivities([result.activity]);
            const applied = store.rebuildCacheFromDag();

            // Mark folded links as ap-origin so they are not re-federated.
            for (const link of [...applied.additions, ...applied.removals]) {
                const originKey = linkOriginKey(store.hashLink(link));
                const existing = storage.get(originKey);
                if (existing === "native") storage.put(originKey, "dual");
                else if (!existing) storage.put(originKey, "ap");
            }

            if (applied.additions.length > 0 || applied.removals.length > 0) {
                getRuntime().emitPerspectiveDiff(applied);
            }
            break;
        }

        case "link-diff":
            // Store links and emit perspective diff
            store.applyDiff(result.diff);

            // Track link origins as "ap" for dual-language dedup
            for (const link of [...result.diff.additions, ...result.diff.removals]) {
                const h = store.hashLink(link);
                const originKey = linkOriginKey(h);
                const existing = storage.get(originKey);
                if (existing === "native") {
                    // Already exists from native sync — mark as dual
                    storage.put(originKey, "dual");
                } else if (!existing) {
                    storage.put(originKey, "ap");
                }
            }

            getRuntime().emitPerspectiveDiff(result.diff);
            break;

        case "follow":
            await handleFollow(activity, groupActorUrl, actorKeyId, settings);
            break;

        case "undo":
            await handleUndo(activity);
            break;

        case "accept":
            // Accept confirmation — no action needed, the follow is confirmed
            console.log(`[ap-link-language] Follow accepted by ${activity.actor}`);
            break;

        // "rejected" and "ignored" — no action needed
    }

    return result;
}
