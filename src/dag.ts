/**
 * Diff-DAG — the AD4M-facing convergence substrate (Role A).
 *
 * ActivityPub has no native causal DAG: an outbox is an activity *stream*,
 * not a hash-linked graph. This module EMULATES a content-addressed diff-DAG
 * *inside* the activity stream, per SPEC_LINK_LANGUAGE_DIFFDAG_CONVERGENCE §2.
 *
 * The DAG is the authoritative source of truth. Each node is a link *diff*
 * (a set of additions + a set of tombstoned removals). Nodes are content-
 * addressed and carry `prev` pointers to their parents' content hashes,
 * forming a DAG over diffs. The materialised link set is a *cache* derived by
 * folding the DAG — never the primary store.
 *
 * Merge is an OR-Set (observed-remove set) keyed by link hash:
 *   - an addition inserts a link hash (with the diff node's id as its add-tag),
 *   - a removal tombstones the SPECIFIC original link hash it observed,
 *   - fold = union of adds minus the removals that causally observed them.
 *
 * Because links are immutable content-addressed elements and a removal carries
 * the ORIGINAL link hash, this converges deterministically with NO scribe or
 * coordinator, and is order-independent.
 *
 * Pure w.r.t. ad4m:host — all persistence goes through the injected
 * StorageAdapter, all hashing through the injected hash function. Safe to unit
 * test with mock adapters (see tests/dag.test.ts).
 */

import { getStorage, getRuntime } from "./adapters.js";
import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Hash injection (mirrors store.ts so tests share one hash fn)
// ---------------------------------------------------------------------------

let _hashFn: ((data: string) => string) | null = null;

/**
 * Initialise the DAG module. Optionally inject a hash function; otherwise the
 * runtime adapter's content-address hash is used. Call once during init(),
 * after initStorage()/initRuntime().
 */
export function initDag(hashFn?: (data: string) => string): void {
    _hashFn = hashFn ?? null;
}

function getHashFn(): (data: string) => string {
    if (_hashFn) return _hashFn;
    return getRuntime().hash;
}

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

/**
 * A diff-DAG node. Content-addressed: `id = hash(canonical(node))`.
 *
 * - `prev`      parent node ids (content hashes). The genesis node has [].
 * - `additions` full link payloads added by this diff (so a folder can
 *               materialise the link set without any external fetch).
 * - `removals`  the ORIGINAL link hashes this diff tombstones. This is the
 *               critical fix: a removal references the exact content hash of
 *               the link it removes, so it converges against the original add
 *               across replicas. There is no `ap://deleted` placeholder.
 * - `author`    DID of the committing agent (informational; not part of merge).
 */
export interface DiffNode {
    id: string;
    prev: string[];
    additions: LinkExpression[];
    removals: string[];
    author: string;
}

/** A diff before it is sealed with a content-hash id. */
export interface UnsealedDiff {
    prev: string[];
    additions: LinkExpression[];
    removals: string[];
    author: string;
}

// ---------------------------------------------------------------------------
// Content addressing
// ---------------------------------------------------------------------------

/**
 * Canonical serialisation of a link for hashing. Field order and null-handling
 * are fixed so the same logical link always hashes identically, regardless of
 * key order or empty-vs-undefined differences.
 */
export function canonicalLink(link: LinkExpression): string {
    return JSON.stringify({
        author: link.author,
        timestamp: link.timestamp,
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

/** Content hash of a single link — the OR-Set element key. */
export function hashLink(link: LinkExpression): string {
    return getHashFn()(canonicalLink(link));
}

/**
 * Canonical serialisation of a diff node's *content* (everything but its id).
 * Parents and removal hashes are sorted, additions are ordered by their content
 * hash — so two nodes with the same logical content produce the same id even if
 * the caller supplied elements in a different order.
 */
export function canonicalDiff(diff: UnsealedDiff): string {
    const prev = [...diff.prev].sort();
    const removals = [...diff.removals].sort();
    const additions = diff.additions
        .map((l) => ({ h: hashLink(l), c: canonicalLink(l) }))
        .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
        .map((x) => x.c);
    return JSON.stringify({ prev, additions, removals, author: diff.author });
}

/** Seal an unsealed diff into a content-addressed DiffNode. */
export function sealDiff(diff: UnsealedDiff): DiffNode {
    const id = getHashFn()(canonicalDiff(diff));
    return { id, ...diff };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const NODE_PREFIX = "dag-node/";
const HEAD_PREFIX = "dag-head/";

function nodeKey(id: string): string {
    return `${NODE_PREFIX}${id}`;
}

function headKey(id: string): string {
    return `${HEAD_PREFIX}${id}`;
}

/** True if a node with this id is already persisted. */
export function hasNode(id: string): boolean {
    return getStorage().get(nodeKey(id)) !== null;
}

/** Retrieve a node by id, or null if absent. */
export function getNode(id: string): DiffNode | null {
    const raw = getStorage().get(nodeKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as DiffNode;
}

/**
 * Persist a node and update the head (frontier) set:
 *   - the node's parents are no longer heads (they now have a child),
 *   - the node becomes a head unless a previously-stored node already lists it
 *     as a parent (out-of-order arrival).
 *
 * Idempotent: storing the same content-hash node twice is a no-op for the head
 * set. Returns true if the node was newly stored, false if already present.
 */
export function putNode(node: DiffNode): boolean {
    const storage = getStorage();
    if (storage.get(nodeKey(node.id)) !== null) return false;

    storage.put(nodeKey(node.id), JSON.stringify(node));

    // Parents lose head status.
    for (const p of node.prev) {
        storage.delete(headKey(p));
    }

    // This node is a head only if nothing already stored points back at it.
    const alreadyReferenced = childExists(node.id);
    if (!alreadyReferenced) {
        storage.put(headKey(node.id), "1");
    }
    return true;
}

/** True if any stored node lists `id` among its parents. */
function childExists(id: string): boolean {
    const storage = getStorage();
    for (const key of storage.listKeys(NODE_PREFIX)) {
        const raw = storage.get(key);
        if (!raw) continue;
        const n = JSON.parse(raw) as DiffNode;
        if (n.prev.includes(id)) return true;
    }
    return false;
}

/** Current DAG heads (frontier) — node ids with no observed children. Sorted. */
export function heads(): string[] {
    return getStorage()
        .listKeys(HEAD_PREFIX)
        .map((k) => k.slice(HEAD_PREFIX.length))
        .sort();
}

/** All stored node ids (unordered scan). */
export function allNodeIds(): string[] {
    return getStorage()
        .listKeys(NODE_PREFIX)
        .map((k) => k.slice(NODE_PREFIX.length));
}

// ---------------------------------------------------------------------------
// Revision — a content hash of the DAG head set (the litmus test)
// ---------------------------------------------------------------------------

/**
 * `currentRevision()` per the spec: a content hash of the DAG head(s).
 *
 * - empty DAG  → "" (nothing committed yet)
 * - single head → that head's content hash (already a hash into the DAG)
 * - multi-head  → a deterministic hash of the sorted set of head hashes
 *   (a version-vector digest for concurrent writers with no single head).
 *
 * Deterministic for a given DAG state and stable across restarts — it depends
 * only on persisted content hashes, never on timestamps, ETags, or cursors.
 */
export function currentRevision(): string {
    const h = heads();
    if (h.length === 0) return "";
    if (h.length === 1) return h[0];
    return getHashFn()(JSON.stringify(h));
}

// ---------------------------------------------------------------------------
// Commit — append a diff node, parented on the current heads
// ---------------------------------------------------------------------------

/**
 * Append a local commit to the DAG. The new node is parented on ALL current
 * heads (folding concurrent local frontier into one), sealed to a content
 * hash, and persisted. Returns the sealed node (its `id` is the new revision
 * when it becomes the sole head).
 *
 * `removals` MUST be original link hashes (use hashLink() on the removed
 * LinkExpression). This is what lets a removal converge against its add.
 */
export function commitDiff(
    additions: LinkExpression[],
    removals: string[],
    author: string,
): DiffNode {
    const node = sealDiff({
        prev: heads(),
        additions,
        removals,
        author,
    });
    putNode(node);
    return node;
}

// ---------------------------------------------------------------------------
// Fold — derive the materialised link set from the DAG (OR-Set)
// ---------------------------------------------------------------------------

/**
 * The result of folding the DAG: the surviving link set plus the bookkeeping
 * needed to project it and to reason about removals.
 */
export interface FoldResult {
    /** Surviving links, keyed by link hash. */
    links: Map<string, LinkExpression>;
    /** Link hashes that were tombstoned by an observing removal. */
    tombstoned: Set<string>;
}

/**
 * Fold the DAG into a materialised link set using genuine observed-remove
 * (OR-Set) semantics keyed by link hash — with causality, not fold order,
 * deciding removals.
 *
 * Each addition of a link hash `h` in node `A` is an *add-instance* tagged by
 * `A`'s id. A removal of `h` in node `R` tombstones exactly the add-instances of
 * `h` that lie in `R`'s CAUSAL PAST (its transitive ancestors) — i.e. the adds
 * `R` actually observed. A link hash is live iff it has at least one add-instance
 * that no observing removal tombstoned.
 *
 * This gives the full OR-Set contract:
 *   - add-then-remove (remove observes the add) → gone;
 *   - remove-then-re-add (the re-add is a NEW add-instance the earlier removal
 *     could not have observed) → present again;
 *   - CONCURRENT add + remove (neither in the other's past) → the removal did
 *     not observe that add, so the add survives — add-wins.
 *
 * Crucially this is decided by the DAG's causal structure (ancestry over `prev`),
 * NOT by the topological tie-break, so the result is fully order-independent: any
 * linearisation of the same node set yields the same live set. Two folds of the
 * same DAG always agree, which is what makes the head-hash a meaningful revision.
 *
 * Determinism of the surviving payload: when several add-instances of the same
 * hash survive, we keep the one from the lexicographically-smallest node id (a
 * content hash), so the materialised LinkExpression is stable.
 */
export function fold(): FoldResult {
    const order = topoOrder(); // parents before children; stable tie-break
    const ancestors = ancestorSets(order);

    // Per link hash: the surviving add-instances (node id → link payload), and
    // the set of add-instance node ids tombstoned by an observing removal.
    const addInstances = new Map<string, Map<string, LinkExpression>>();
    const removedInstances = new Map<string, Set<string>>();
    const tombstoned = new Set<string>();

    for (const id of order) {
        const node = getNode(id);
        if (!node) continue;

        for (const link of node.additions) {
            const h = hashLink(link);
            let instances = addInstances.get(h);
            if (!instances) {
                instances = new Map();
                addInstances.set(h, instances);
            }
            instances.set(id, link);
        }

        for (const removedHash of node.removals) {
            // This removal observes every add-instance of removedHash that is a
            // causal ancestor of this node. Concurrent adds are NOT observed.
            const anc = ancestors.get(id) ?? new Set<string>();
            const instances = addInstances.get(removedHash);
            if (!instances) continue;
            let removedSet = removedInstances.get(removedHash);
            for (const addNodeId of instances.keys()) {
                if (anc.has(addNodeId)) {
                    if (!removedSet) {
                        removedSet = new Set();
                        removedInstances.set(removedHash, removedSet);
                    }
                    removedSet.add(addNodeId);
                }
            }
        }
    }

    // A hash is live iff it has an add-instance no observing removal tombstoned.
    const live = new Map<string, LinkExpression>();
    for (const [h, instances] of addInstances) {
        const removed = removedInstances.get(h) ?? new Set<string>();
        let survivorNodeId: string | null = null;
        for (const addNodeId of instances.keys()) {
            if (removed.has(addNodeId)) continue;
            // Keep the smallest node id for a deterministic surviving payload.
            if (survivorNodeId === null || addNodeId < survivorNodeId) {
                survivorNodeId = addNodeId;
            }
        }
        if (survivorNodeId !== null) {
            live.set(h, instances.get(survivorNodeId)!);
        } else if (instances.size > 0) {
            // Every add-instance was observed-and-removed → tombstoned.
            tombstoned.add(h);
        }
    }

    return { links: live, tombstoned };
}

/**
 * Compute the transitive-ancestor set for every node (NOT inclusive of self).
 * `order` must be a topological order (parents before children) so each node's
 * ancestors are already resolved when we reach it. Missing parents (gaps
 * awaiting sync) contribute nothing — they are treated as roots, matching
 * topoOrder's gap handling.
 */
function ancestorSets(order: string[]): Map<string, Set<string>> {
    const ancestors = new Map<string, Set<string>>();
    for (const id of order) {
        const node = getNode(id);
        const acc = new Set<string>();
        if (node) {
            for (const p of node.prev) {
                acc.add(p);
                const pa = ancestors.get(p);
                if (pa) for (const a of pa) acc.add(a);
            }
        }
        ancestors.set(id, acc);
    }
    return ancestors;
}

/** Convenience: the surviving links as an array (folded from the DAG). */
export function materialisedLinks(): LinkExpression[] {
    return [...fold().links.values()];
}

/**
 * Every link hash the DAG has ever mentioned as an addition — i.e. all link
 * hashes that are "owned" by the convergence substrate. Used by the KV cache
 * to distinguish DAG-derived links (authoritative, may be tombstoned) from
 * purely-external AP links (Role-B projection that the DAG never governed).
 */
export function dagTouchedLinkHashes(): Set<string> {
    const touched = new Set<string>();
    for (const id of allNodeIds()) {
        const node = getNode(id);
        if (!node) continue;
        for (const link of node.additions) {
            touched.add(hashLink(link));
        }
        for (const h of node.removals) {
            touched.add(h);
        }
    }
    return touched;
}

// ---------------------------------------------------------------------------
// Topological ordering (Kahn) with deterministic tie-breaking
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic topological order of all stored nodes: every parent
 * precedes its children. Ties (nodes whose parents are all satisfied at the
 * same time) are broken by ascending content hash, so the linearisation is
 * fully determined by the DAG's content — independent of insertion order.
 *
 * Parents referenced but not yet stored (a gap awaiting sync) are treated as
 * already-satisfied roots, so the fold degrades gracefully rather than
 * stalling; sync.walkAndFold re-requests such gaps.
 */
export function topoOrder(): string[] {
    const ids = allNodeIds();
    const present = new Set(ids);
    const indeg = new Map<string, number>();
    const children = new Map<string, string[]>();

    for (const id of ids) {
        indeg.set(id, 0);
        children.set(id, []);
    }
    for (const id of ids) {
        const node = getNode(id);
        if (!node) continue;
        for (const p of node.prev) {
            if (!present.has(p)) continue; // missing parent → treat as root
            indeg.set(id, (indeg.get(id) ?? 0) + 1);
            children.get(p)!.push(id);
        }
    }

    // Ready set = nodes with no present parents, ordered by content hash.
    const ready = ids.filter((id) => (indeg.get(id) ?? 0) === 0).sort();
    const order: string[] = [];
    const seen = new Set<string>();

    while (ready.length > 0) {
        const id = ready.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        order.push(id);

        for (const c of (children.get(id) ?? []).sort()) {
            const d = (indeg.get(c) ?? 0) - 1;
            indeg.set(c, d);
            if (d === 0) {
                // Insert keeping the ready list sorted for determinism.
                insertSorted(ready, c);
            }
        }
    }

    // Any node not emitted sits in a cycle (impossible for content-hash DAGs
    // built here) or behind an unresolved gap already treated as root — append
    // deterministically so the fold still terminates.
    if (order.length < ids.length) {
        for (const id of ids.slice().sort()) {
            if (!seen.has(id)) order.push(id);
        }
    }
    return order;
}

function insertSorted(arr: string[], value: string): void {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    arr.splice(lo, 0, value);
}

// ---------------------------------------------------------------------------
// Missing-parent detection (drives sync re-requests)
// ---------------------------------------------------------------------------

/**
 * Return the set of parent ids referenced by stored nodes but not themselves
 * stored — the gaps sync must walk back and fetch to complete the DAG.
 */
export function missingParents(): string[] {
    const present = new Set(allNodeIds());
    const missing = new Set<string>();
    for (const id of allNodeIds()) {
        const node = getNode(id);
        if (!node) continue;
        for (const p of node.prev) {
            if (!present.has(p)) missing.add(p);
        }
    }
    return [...missing].sort();
}
