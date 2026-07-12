/**
 * Sync — walk the emulated diff-DAG and fold it, per
 * SPEC_LINK_LANGUAGE_DIFFDAG_CONVERGENCE §2/§4.
 *
 * ActivityPub has no native causal DAG, so the DAG is emulated inside the
 * activity stream: each ad4m diff activity carries an `ad4m:Diff` tag with a
 * content-hash id and `prev` pointers to its parents' content hashes. Sync:
 *
 *   1. reads activities from the group outbox (and any explicitly-fetched
 *      activity URLs) as a *transport* for DAG nodes — NOT as a snapshot to
 *      diff against local state;
 *   2. ingests each ad4m diff activity as a DAG node, verifying its content
 *      hash so tampered nodes are rejected;
 *   3. walks the `prev` pointers, re-requesting any missing parent activities
 *      so the local DAG is causally complete;
 *   4. folds the DAG (OR-Set keyed by link hash) to rebuild the derived link
 *      cache, and returns the resulting PerspectiveDiff;
 *   5. still projects *external* (non-ad4m) AP activities — plain Notes, Likes,
 *      Announces, real Fediverse Deletes — through the Role-B path.
 *
 * `currentRevision` is a content hash of the DAG head(s) (see store/dag), so it
 * is meaningful across replicas rather than an opaque per-node cursor.
 */

import { getTransport } from "./adapters.js";
import type { PerspectiveDiff, LinkExpression } from "./types.js";
import type { APActivity, APCollection, APCollectionPage } from "./activitypub.js";
import { inboundActivityToLink, activityToDiffNode, isDiffActivity } from "./translate.js";
import * as store from "./store.js";
import * as dag from "./dag.js";
import { sealDiff } from "./dag.js";

// ---------------------------------------------------------------------------
// Outbox / activity fetching (transport only)
// ---------------------------------------------------------------------------

/**
 * Fetch a single AP collection page via the transport.
 */
export async function fetchCollectionPage(url: string): Promise<APCollectionPage | null> {
    try {
        const response = await getTransport().fetch(
            url,
            "GET",
            { Accept: "application/activity+json" },
            "",
        );
        if (response.status >= 200 && response.status < 300) {
            return JSON.parse(response.body) as APCollectionPage;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Fetch the outbox collection metadata (total items, first/last page).
 */
export async function fetchOutboxMeta(outboxUrl: string): Promise<APCollection | null> {
    try {
        const response = await getTransport().fetch(
            outboxUrl,
            "GET",
            { Accept: "application/activity+json" },
            "",
        );
        if (response.status >= 200 && response.status < 300) {
            return JSON.parse(response.body) as APCollection;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Fetch a single activity object by URL (used to walk `prev` pointers back to
 * missing parent diff nodes). Returns the activity, or null on failure.
 */
export async function fetchActivity(url: string): Promise<APActivity | null> {
    try {
        const response = await getTransport().fetch(
            url,
            "GET",
            { Accept: "application/activity+json" },
            "",
        );
        if (response.status >= 200 && response.status < 300) {
            return JSON.parse(response.body) as APActivity;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Collect all activities currently visible in the outbox (inline items, or by
 * paginating first → next). This is transport, not truth: the returned
 * activities are fed into the DAG, which is authoritative.
 */
export async function collectOutboxActivities(outboxUrl: string): Promise<APActivity[]> {
    const all: APActivity[] = [];
    const collection = await fetchOutboxMeta(outboxUrl);
    if (!collection) return all;

    if (collection.orderedItems && collection.orderedItems.length > 0) {
        all.push(...collection.orderedItems);
    } else if (collection.first) {
        let pageUrl: string | undefined = collection.first;
        const maxPages = 50;
        let pageCount = 0;
        while (pageUrl && pageCount < maxPages) {
            const page = await fetchCollectionPage(pageUrl);
            if (!page || !page.orderedItems || page.orderedItems.length === 0) break;
            all.push(...page.orderedItems);
            pageUrl = page.next;
            pageCount++;
        }
    }
    return all;
}

// ---------------------------------------------------------------------------
// DAG ingestion + prev-walk
// ---------------------------------------------------------------------------

/**
 * Ingest a batch of activities into the diff-DAG. For each ad4m diff activity:
 *   - decode it into a candidate DAG node,
 *   - RE-SEAL it (recompute its content hash from its content) and reject it if
 *     the recomputed id disagrees with the advertised `ad4m:diffId`
 *     (tamper/corruption guard),
 *   - persist it (idempotent by content hash).
 *
 * Returns the ids of nodes newly stored this call.
 */
export function ingestDiffActivities(activities: APActivity[]): string[] {
    const stored: string[] = [];
    for (const activity of activities) {
        if (!isDiffActivity(activity)) continue;
        const decoded = activityToDiffNode(activity);
        if (!decoded) continue;

        // Verify content addressing: recompute the id from the node content.
        const resealed = sealDiff({
            prev: decoded.prev,
            additions: decoded.additions,
            removals: decoded.removals,
            author: decoded.author,
        });
        if (resealed.id !== decoded.id) {
            // Advertised diffId does not match content — reject silently.
            continue;
        }
        if (dag.putNode(resealed)) stored.push(resealed.id);
    }
    return stored;
}

/**
 * Walk `prev` pointers to close gaps in the DAG. Any parent id referenced but
 * not stored is fetched by URL (derived from the group base) and ingested;
 * this repeats until no gaps remain or the fetch budget is exhausted.
 *
 * `resolveParentUrl` maps a parent content hash to the activity URL to fetch.
 * With the ap encoding the diff activity id is `${groupActorUrl}/diffs/${id}`.
 */
export async function walkMissingParents(
    resolveParentUrl: (parentId: string) => string,
    maxFetches = 200,
): Promise<void> {
    let budget = maxFetches;
    let missing = dag.missingParents();
    const attempted = new Set<string>();

    while (missing.length > 0 && budget > 0) {
        let madeProgress = false;
        for (const parentId of missing) {
            if (budget <= 0) break;
            if (attempted.has(parentId)) continue;
            attempted.add(parentId);
            budget--;

            const activity = await fetchActivity(resolveParentUrl(parentId));
            if (!activity) continue;
            const stored = ingestDiffActivities([activity]);
            if (stored.length > 0) madeProgress = true;
        }
        if (!madeProgress) break; // unresolvable gaps — stop rather than spin
        missing = dag.missingParents();
    }
}

// ---------------------------------------------------------------------------
// External (non-DAG) activity projection — Role B
// ---------------------------------------------------------------------------

/**
 * Project *external* AP activities (those WITHOUT an ad4m:Diff tag) into the
 * link cache: plain Notes from Fediverse users, Likes, Announces, and genuine
 * remote Deletes. These are not part of the convergence substrate — they are a
 * best-effort bridge of native AP content into the perspective.
 */
export function projectExternalActivities(
    activities: APActivity[],
    neighbourhoodUrl: string,
): PerspectiveDiff {
    const additions: LinkExpression[] = [];
    const removals: LinkExpression[] = [];

    for (const activity of activities) {
        if (isDiffActivity(activity)) continue; // handled by the DAG
        const link = inboundActivityToLink(activity, neighbourhoodUrl);
        if (!link) continue;

        if (activity.type === "Delete") {
            // Match by (source, predicate, target) — a genuine Fediverse Delete
            // comes from a different actor/time than the original Note, so it
            // cannot reproduce the original link's content hash.
            const gone = store.removeExternalLink({
                source: link.data.source,
                predicate: link.data.predicate,
                target: link.data.target,
            });
            removals.push(...gone);
        } else {
            // Only report links that are genuinely NEW to the cache. Re-syncing
            // the same outbox page must be idempotent: putLink is idempotent in
            // storage, but the RETURNED diff (emitted to subscribers) must not
            // re-announce links we already materialised. This mirrors the
            // DAG-fold delta, which also only reports newly-appeared links.
            const alreadyPresent = store.getLink(store.hashLink(link)) !== null;
            store.putLink(link);
            if (!alreadyPresent) additions.push(link);
        }
    }

    return { additions, removals };
}

// ---------------------------------------------------------------------------
// Top-level sync
// ---------------------------------------------------------------------------

/**
 * Sync from the group outbox by folding the emulated diff-DAG.
 *
 * Steps: collect outbox activities → ingest ad4m diff nodes → walk `prev` to
 * close gaps → fold the DAG to rebuild the derived cache → project external AP
 * content → return the combined PerspectiveDiff.
 *
 * The returned diff is what changed in the LOCAL materialised set as a result
 * of this sync (DAG fold delta + external projection), suitable for emitting to
 * subscribers.
 */
export async function syncFromOutbox(
    outboxUrl: string,
    neighbourhoodUrl: string,
    groupActorUrl?: string,
): Promise<PerspectiveDiff> {
    const activities = await collectOutboxActivities(outboxUrl);
    if (activities.length === 0) {
        return { additions: [], removals: [] };
    }

    // 1. Ingest ad4m diff nodes into the DAG.
    ingestDiffActivities(activities);

    // 2. Close causal gaps by walking prev pointers (best-effort; needs a base
    //    URL to resolve parent activity URLs). Without a group base we still
    //    fold what we have — missing parents are treated as satisfied roots.
    if (groupActorUrl) {
        await walkMissingParents((parentId) => `${groupActorUrl}/diffs/${parentId}`);
    }

    // 3. Fold the DAG → rebuild the derived cache; capture the delta.
    const dagDelta = store.rebuildCacheFromDag();

    // 4. Project external (non-ad4m) AP content.
    const externalDelta = projectExternalActivities(activities, neighbourhoodUrl);

    return {
        additions: [...dagDelta.additions, ...externalDelta.additions],
        removals: [...dagDelta.removals, ...externalDelta.removals],
    };
}

/**
 * Process a batch of inbound activities (e.g. delivered to the inbox and
 * forwarded as a set): ingest diff nodes, fold, and project externals. Unlike
 * the outbox path this does not walk `prev` (the caller may not have a base
 * URL); missing parents are reconciled on the next `syncFromOutbox`.
 */
export function processInboundActivities(
    activities: APActivity[],
    neighbourhoodUrl: string,
): PerspectiveDiff {
    ingestDiffActivities(activities);
    const dagDelta = store.rebuildCacheFromDag();
    const externalDelta = projectExternalActivities(activities, neighbourhoodUrl);
    return {
        additions: [...dagDelta.additions, ...externalDelta.additions],
        removals: [...dagDelta.removals, ...externalDelta.removals],
    };
}
