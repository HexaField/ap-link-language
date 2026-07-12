/**
 * Local link store — wraps the ad4m:host storage KV API to maintain
 * a link store with indexes per Spec §5.6.
 *
 * Key scheme:
 *   links/{link-hash}                → serialized LinkExpression
 *   links-by-source/{source}/{hash}  → link-hash
 *   links-by-target/{target}/{hash}  → link-hash
 *   links-by-pred/{predicate}/{hash} → link-hash
 *   revision                         → last known AP outbox page URL
 *   ap-objects/{ap-id-hash}          → serialized AP object JSON
 *   peers/{did}                      → peer metadata JSON
 */

import type { StorageAdapter } from "./adapters.js";
import { getStorage, getRuntime } from "./adapters.js";
import {
    hashLink as dagHashLink,
    initDag,
    fold as dagFold,
    dagTouchedLinkHashes,
    currentRevision as dagCurrentRevision,
} from "./dag.js";

import type { LinkExpression, PerspectiveDiff, Perspective } from "./types.js";

let _hashFn: ((data: string) => string) | null = null;

/**
 * Initialize the store module.
 *
 * Call once during language init() after initStorage() and initRuntime()
 * have been called. Optionally provide a custom hash function
 * (defaults to runtime adapter's hash).
 *
 * The same hash function is wired into the diff-DAG module so that link
 * content hashes are IDENTICAL between the KV cache and the DAG — this is what
 * lets a removal (which carries an original link hash) match its add.
 */
export function initStore(hashFn?: (data: string) => string): void {
    _hashFn = hashFn ?? null;
    initDag(hashFn);
}

function getHashFn(): (data: string) => string {
    if (_hashFn) return _hashFn;
    return getRuntime().hash;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function linkKey(linkHash: string): string {
    return `links/${linkHash}`;
}

function sourceIndexKey(source: string, linkHash: string): string {
    return `links-by-source/${source}/${linkHash}`;
}

function targetIndexKey(target: string, linkHash: string): string {
    return `links-by-target/${target}/${linkHash}`;
}

function predIndexKey(predicate: string, linkHash: string): string {
    return `links-by-pred/${predicate}/${linkHash}`;
}

function peerKey(did: string): string {
    return `peers/${did}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash for a LinkExpression.
 *
 * Delegates to the diff-DAG's `hashLink` so there is exactly ONE definition of
 * a link's content hash across the whole language. The KV cache and the DAG
 * OR-Set therefore agree on element identity, which is required for removals
 * (carrying the original link hash) to converge against their adds.
 */
export function hashLink(link: LinkExpression): string {
    return dagHashLink(link);
}

/**
 * Store a single LinkExpression and update all indexes.
 */
export function putLink(link: LinkExpression): string {
    const h = hashLink(link);
    const storage = getStorage();
    storage.put(linkKey(h), JSON.stringify(link));

    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";

    if (source) storage.put(sourceIndexKey(source, h), h);
    if (target) storage.put(targetIndexKey(target, h), h);
    if (predicate) storage.put(predIndexKey(predicate, h), h);

    return h;
}

/**
 * Remove a LinkExpression and its index entries.
 */
export function removeLink(link: LinkExpression): void {
    const h = hashLink(link);
    const storage = getStorage();
    storage.delete(linkKey(h));

    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";

    if (source) storage.delete(sourceIndexKey(source, h));
    if (target) storage.delete(targetIndexKey(target, h));
    if (predicate) storage.delete(predIndexKey(predicate, h));
}

/**
 * Retrieve a link by its hash.
 */
export function getLink(linkHash: string): LinkExpression | null {
    const raw = getStorage().get(linkKey(linkHash));
    if (!raw) return null;
    return JSON.parse(raw) as LinkExpression;
}

/**
 * Remove *external* (non-DAG) links matching a (source, predicate, target)
 * triple, ignoring author/timestamp.
 *
 * Genuine Fediverse Deletes come from a different actor at a different time
 * than the original Note, so they cannot reconstruct the original link's exact
 * content hash. External AP notes are not content-addressed AD4M links, so we
 * match them by triple identity. Returns the links that were removed.
 *
 * This is ONLY for the external Role-B projection. AD4M convergence removals
 * carry the original link hash and flow through the diff-DAG, never here.
 */
export function removeExternalLink(match: { source?: string; predicate?: string; target?: string }): LinkExpression[] {
    const removed: LinkExpression[] = [];
    for (const key of getStorage().listKeys("links/")) {
        const raw = getStorage().get(key);
        if (!raw) continue;
        const link = JSON.parse(raw) as LinkExpression;
        if (match.source !== undefined && (link.data.source || "") !== match.source) continue;
        if (match.predicate !== undefined && (link.data.predicate || "") !== match.predicate) continue;
        if (match.target !== undefined && (link.data.target || "") !== match.target) continue;
        removeLink(link);
        removed.push(link);
    }
    return removed;
}

/**
 * Apply a full PerspectiveDiff to the store cache.
 *
 * This mutates the derived link cache directly. It is used for the Role-B
 * projection of *external* AP activity (Notes/Likes/Deletes from non-AD4M
 * Fediverse actors, which are not diff-DAG nodes). AD4M convergence links flow
 * through the diff-DAG and are materialised via {@link rebuildCacheFromDag}.
 */
export function applyDiff(diff: PerspectiveDiff): void {
    for (const addition of diff.additions) {
        putLink(addition);
    }
    for (const removal of diff.removals) {
        removeLink(removal);
    }
}

/**
 * Rebuild the KV link cache by folding the authoritative diff-DAG.
 *
 * The DAG is the source of truth; the KV store is a derived cache. This clears
 * every DAG-sourced link key and re-inserts the folded OR-Set result, then
 * returns the PerspectiveDiff (additions gained / removals lost) relative to
 * the cache's prior contents so the caller can emit it to subscribers.
 *
 * External (non-DAG) links written via {@link applyDiff} are preserved: they
 * live under the same `links/` prefix but are re-asserted here from a snapshot
 * of any links whose hash is not produced by the fold. In practice external AP
 * links and DAG links share the store; to keep the fold authoritative for DAG
 * content while not dropping external content, we diff by hash set.
 */
export function rebuildCacheFromDag(): PerspectiveDiff {
    const { links: folded } = dagFold();

    // Snapshot current cache hashes.
    const before = new Map<string, LinkExpression>();
    for (const key of getStorage().listKeys("links/")) {
        const raw = getStorage().get(key);
        if (!raw) continue;
        const link = JSON.parse(raw) as LinkExpression;
        before.set(hashLink(link), link);
    }

    // DAG-derived hashes (authoritative for anything the DAG ever mentioned).
    const dagTouched = dagTouchedLinkHashes();

    const additions: LinkExpression[] = [];
    const removals: LinkExpression[] = [];

    // Insert / keep folded links; record newly-appeared ones as additions.
    for (const [h, link] of folded) {
        if (!before.has(h)) {
            putLink(link);
            additions.push(link);
        }
    }

    // Remove links the DAG once had but has now tombstoned; leave purely
    // external links (never touched by the DAG) untouched.
    for (const [h, link] of before) {
        if (dagTouched.has(h) && !folded.has(h)) {
            removeLink(link);
            removals.push(link);
        }
    }

    return { additions, removals };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface LinkQuery {
    source?: string;
    target?: string;
    predicate?: string;
}

/**
 * Query links by pattern. Supports filtering by source, target,
 * and/or predicate. Returns all links when no filter is given.
 */
export function queryLinks(query: LinkQuery): LinkExpression[] {
    const { source, target, predicate } = query;
    const storage = getStorage();

    // Determine which index to use for the primary scan
    let candidateHashes: string[];

    if (source) {
        const keys = storage.listKeys(`links-by-source/${source}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else if (target) {
        const keys = storage.listKeys(`links-by-target/${target}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else if (predicate) {
        const keys = storage.listKeys(`links-by-pred/${predicate}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else {
        // Full scan
        const keys = storage.listKeys("links/");
        candidateHashes = keys.map((k: string) => k.replace("links/", ""));
    }

    // Fetch and filter
    const results: LinkExpression[] = [];
    const seen = new Set<string>();

    for (const h of candidateHashes) {
        if (seen.has(h)) continue;
        seen.add(h);

        const link = getLink(h);
        if (!link) continue;

        // Apply remaining filters
        if (source && link.data.source !== source) continue;
        if (target && link.data.target !== target) continue;
        if (predicate && link.data.predicate !== predicate) continue;

        results.push(link);
    }

    return results;
}

/**
 * Return all links in the store as a Perspective.
 */
export function allLinks(): Perspective {
    const keys = getStorage().listKeys("links/");
    const links: LinkExpression[] = [];

    for (const key of keys) {
        const raw = getStorage().get(key);
        if (raw) {
            links.push(JSON.parse(raw) as LinkExpression);
        }
    }

    return { links };
}

// ---------------------------------------------------------------------------
// Revision tracking
// ---------------------------------------------------------------------------
//
// The revision is a CONTENT HASH of the diff-DAG head(s) — never an AP activity
// id URL, ETag, or timestamp cursor. It is computed on demand by folding the
// DAG's frontier, so it is deterministic for a given DAG state and stable
// across restarts. There is no stored, mutable "revision" cursor anymore.

export function getRevision(): string | null {
    const rev = dagCurrentRevision();
    return rev === "" ? null : rev;
}

// ---------------------------------------------------------------------------
// AP objects cache
// ---------------------------------------------------------------------------

export function putAPObject(apId: string, json: string): void {
    const key = `ap-objects/${getHashFn()(apId)}`;
    getStorage().put(key, json);
}

export function getAPObject(apId: string): string | null {
    const key = `ap-objects/${getHashFn()(apId)}`;
    return getStorage().get(key);
}

// ---------------------------------------------------------------------------
// Peer management
// ---------------------------------------------------------------------------

export function setPeer(did: string, metadata: Record<string, unknown> = {}): void {
    getStorage().put(peerKey(did), JSON.stringify(metadata));
}

export function removePeer(did: string): void {
    getStorage().delete(peerKey(did));
}

export function listPeers(prefix: string = "peers/"): string[] {
    const keys = getStorage().listKeys(prefix);
    return keys.map((k: string) => k.replace(prefix, ""));
}

export function getPeerMetadata(did: string): Record<string, unknown> | null {
    const raw = getStorage().get(peerKey(did));
    if (!raw) return null;
    return JSON.parse(raw);
}
