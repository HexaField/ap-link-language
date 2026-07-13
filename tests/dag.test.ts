/**
 * Diff-DAG convergence tests — the acceptance criteria of
 * SPEC_LINK_LANGUAGE_DIFFDAG_CONVERGENCE §5, exercised directly against the
 * authoritative substrate in src/dag.ts (and the derived cache in src/store.ts).
 *
 * These are the regression tests the rework is judged by:
 *
 *   §5.1  currentRevision() is a CONTENT HASH of the DAG head(s), deterministic
 *         for a given DAG state and STABLE across a restart (re-init from the
 *         same persisted storage yields the same revision).
 *   §5.2  DAG-fold reproduces the link set: folding the DAG materialises exactly
 *         the committed-and-surviving links (the DAG is authoritative, the KV
 *         store is a derived cache).
 *   §5.3  Removal convergence — THE ap://deleted regression: a removal carries
 *         the ORIGINAL link hash, so when agent B removes a link agent A added,
 *         the link is absent on BOTH replicas after they exchange diff nodes.
 *         Includes add-after-remove (re-add wins) and concurrent add/remove
 *         (OR-Set: add wins) as the full observed-remove contract.
 *   §5.4  Order-independent merge: ingesting the SAME set of diff nodes in any
 *         order yields the identical revision hash and the identical fold.
 *
 * No live ActivityPub federation is exercised here (none is available in CI).
 * We simulate two replicas as two in-memory StorageAdapters sharing one
 * deterministic hash function, and model "federation" as copying a sealed
 * DiffNode's bytes from one replica's storage into the other's — which is
 * exactly what sync.ingestDiffActivities does after decoding an AP activity.
 * What still needs a live federation harness is called out in the README.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/adapters.js";
import { initStorage, initRuntime } from "../src/adapters.js";
import type { RuntimeAdapter } from "../src/adapters.js";
import * as dag from "../src/dag.js";
import * as store from "../src/store.js";
import type { DiffNode } from "../src/dag.js";
import type { LinkExpression } from "../src/types.js";
import { diffNodeToActivity, activityToDiffNode } from "../src/translate.js";
import type { APObject } from "../src/activitypub.js";

// ---------------------------------------------------------------------------
// Deterministic test harness — in-memory storage + a stable string hash
// ---------------------------------------------------------------------------

class MemStorage implements StorageAdapter {
    readonly data = new Map<string, string>();
    get(key: string): string | null {
        return this.data.has(key) ? this.data.get(key)! : null;
    }
    put(key: string, value: string): void {
        this.data.set(key, value);
    }
    delete(key: string): void {
        this.data.delete(key);
    }
    listKeys(prefix = ""): string[] {
        return [...this.data.keys()].filter((k) => k.startsWith(prefix));
    }
    /** Deep-copy for snapshotting a "restart" (same bytes, new object). */
    clone(): MemStorage {
        const s = new MemStorage();
        for (const [k, v] of this.data) s.data.set(k, v);
        return s;
    }
}

/**
 * FNV-1a 32-bit → hex. Deterministic and content-only (no time/nonce), which is
 * exactly what a content-address hash must be for the revision to be stable.
 * The production runtime uses SHA-256→CIDv1; any deterministic function proves
 * the DAG's algebra, and using a simple one keeps the fixtures readable.
 */
function fnv1a(data: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
        h ^= data.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return "h" + (h >>> 0).toString(16).padStart(8, "0");
}

const runtime: RuntimeAdapter = {
    hash: fnv1a,
    emitSignal: () => {},
    emitPerspectiveDiff: () => {},
};

/** Point the modules at a specific storage (models "this replica is active"). */
function useStorage(s: StorageAdapter): void {
    initStorage(s);
    initRuntime(runtime);
    // Wire the SAME hash into store + dag so link hashes match everywhere; this
    // is the invariant that lets a removal's hash line up with its add.
    store.initStore(fnv1a);
}

function makeLink(overrides: Partial<LinkExpression["data"]> = {}, author = "did:key:zA", ts = "2026-05-02T00:00:00.000Z"): LinkExpression {
    return {
        author,
        timestamp: ts,
        data: {
            source: overrides.source ?? "literal://s",
            predicate: overrides.predicate ?? "sioc://p",
            target: overrides.target ?? "literal://t",
        },
        proof: { signature: "", key: "" },
    };
}

/** Copy a sealed node's bytes into another storage — models AP transport. */
function transport(node: DiffNode, from: MemStorage, to: MemStorage): void {
    const raw = from.get(`dag-node/${node.id}`);
    assert.ok(raw, "sealed node must be persisted on the sender before transport");
    // Re-ingest on the receiver exactly as sync.ingestDiffActivities would: seal
    // from content and putNode (which also maintains the head set).
    const decoded = JSON.parse(raw) as DiffNode;
    const resealed = dag.sealDiff({
        prev: decoded.prev,
        additions: decoded.additions,
        removals: decoded.removals,
        author: decoded.author,
    });
    assert.equal(resealed.id, decoded.id, "content hash must verify on ingest");
    dag.putNode(resealed);
}

// ---------------------------------------------------------------------------
// §5.1 — currentRevision is a content hash, deterministic + stable
// ---------------------------------------------------------------------------

describe("diff-DAG §5.1: revision is a content hash of the head(s)", () => {
    let storage: MemStorage;
    beforeEach(() => {
        storage = new MemStorage();
        useStorage(storage);
    });

    it("empty DAG has no revision", () => {
        assert.equal(dag.currentRevision(), "");
        assert.equal(store.getRevision(), null);
    });

    it("single head → revision equals that head's content hash (an id INTO the DAG, not a URL/cursor)", () => {
        const node = dag.commitDiff([makeLink()], [], "did:key:zA");
        assert.equal(dag.currentRevision(), node.id);
        assert.equal(store.getRevision(), node.id);
        // It is a content hash, never an opaque activity-id URL or page cursor.
        assert.match(node.id, /^h[0-9a-f]{8}$/);
        assert.ok(!node.id.includes("http"));
    });

    it("revision advances deterministically as the chain grows", () => {
        const n1 = dag.commitDiff([makeLink({ target: "t1" })], [], "did:key:zA");
        const r1 = dag.currentRevision();
        const n2 = dag.commitDiff([makeLink({ target: "t2" })], [], "did:key:zA");
        const r2 = dag.currentRevision();
        assert.equal(r1, n1.id);
        assert.equal(r2, n2.id);
        assert.notEqual(r1, r2);
        // n2 is parented on n1 → n1 is no longer a head.
        assert.deepEqual(dag.heads(), [n2.id]);
    });

    it("revision is STABLE across a restart (re-init from the same persisted storage)", () => {
        dag.commitDiff([makeLink({ target: "t1" })], [], "did:key:zA");
        dag.commitDiff([makeLink({ target: "t2" })], [], "did:key:zA");
        const before = dag.currentRevision();

        // Simulate a process restart: clone the persisted bytes into a fresh
        // storage object and re-init the modules against it. No in-memory DAG
        // state carries over — only what was persisted.
        const restarted = storage.clone();
        useStorage(restarted);

        assert.equal(dag.currentRevision(), before, "revision must survive restart unchanged");
        assert.equal(store.getRevision(), before);
    });

    it("multi-head revision is a deterministic digest of the sorted head set", () => {
        // Two concurrent genesis nodes (no shared parent) → two heads.
        const a = dag.commitDiff([makeLink({ target: "A" })], [], "did:key:zA");
        // Force a concurrent sibling by settling a second genesis directly.
        const b = dag.sealDiff({ prev: [], additions: [makeLink({ target: "B" })], removals: [], author: "did:key:zB" });
        dag.putNode(b);

        const heads = dag.heads();
        assert.equal(heads.length, 2);
        assert.deepEqual(heads, [a.id, b.id].sort());
        // Revision = hash of the sorted head list — deterministic, order-free.
        assert.equal(dag.currentRevision(), fnv1a(JSON.stringify([a.id, b.id].sort())));
    });
});

// ---------------------------------------------------------------------------
// §5.2 — DAG-fold reproduces the link set (DAG authoritative, KV = cache)
// ---------------------------------------------------------------------------

describe("diff-DAG §5.2: fold reproduces the materialised link set", () => {
    let storage: MemStorage;
    beforeEach(() => {
        storage = new MemStorage();
        useStorage(storage);
    });

    it("folds all surviving additions and nothing else", () => {
        const l1 = makeLink({ target: "t1" });
        const l2 = makeLink({ target: "t2" });
        const l3 = makeLink({ target: "t3" });
        dag.commitDiff([l1, l2], [], "did:key:zA");
        dag.commitDiff([l3], [], "did:key:zA");

        const folded = dag.fold().links;
        assert.equal(folded.size, 3);
        assert.ok(folded.has(dag.hashLink(l1)));
        assert.ok(folded.has(dag.hashLink(l2)));
        assert.ok(folded.has(dag.hashLink(l3)));
    });

    it("rebuildCacheFromDag materialises the fold into the KV store as a derived cache", () => {
        const l1 = makeLink({ target: "t1" });
        const l2 = makeLink({ target: "t2" });
        dag.commitDiff([l1, l2], [], "did:key:zA");

        // The KV cache starts empty; rebuild derives it from the authoritative DAG.
        const delta = store.rebuildCacheFromDag();
        assert.equal(delta.additions.length, 2);
        assert.equal(delta.removals.length, 0);
        assert.equal(store.allLinks().links.length, 2);
        assert.ok(store.getLink(dag.hashLink(l1)));
        assert.ok(store.getLink(dag.hashLink(l2)));

        // Rebuilding again is a no-op delta — the cache already agrees with the DAG.
        const delta2 = store.rebuildCacheFromDag();
        assert.equal(delta2.additions.length, 0);
        assert.equal(delta2.removals.length, 0);
    });

    it("the DAG is the source of truth: a tombstoned link is dropped from the cache on rebuild", () => {
        const l1 = makeLink({ target: "keep" });
        const l2 = makeLink({ target: "drop" });
        dag.commitDiff([l1, l2], [], "did:key:zA");
        store.rebuildCacheFromDag();
        assert.equal(store.allLinks().links.length, 2);

        // Remove l2 by its ORIGINAL hash, then rebuild — the cache must shrink.
        dag.commitDiff([], [dag.hashLink(l2)], "did:key:zA");
        const delta = store.rebuildCacheFromDag();
        assert.equal(delta.removals.length, 1);
        assert.equal(delta.removals[0].data.target, "drop");
        assert.equal(store.allLinks().links.length, 1);
        assert.equal(store.getLink(dag.hashLink(l2)), null);
        assert.ok(store.getLink(dag.hashLink(l1)));
    });
});

// ---------------------------------------------------------------------------
// §5.3 — Removal convergence: THE ap://deleted regression
// ---------------------------------------------------------------------------

describe("diff-DAG §5.3: removal carries the original hash and converges (ap://deleted regression)", () => {
    let repA: MemStorage;
    let repB: MemStorage;
    beforeEach(() => {
        repA = new MemStorage();
        repB = new MemStorage();
    });

    it("agent B removing agent A's link makes it absent on BOTH replicas", () => {
        const L = makeLink({ source: "n://x", predicate: "p://q", target: "n://y" });
        const hL = fnv1a(dag.canonicalLink(L)); // stable, independent of active storage

        // --- Replica A: add L, federate the add to B. ---
        useStorage(repA);
        const addNode = dag.commitDiff([L], [], "did:key:zA");
        assert.ok(dag.fold().links.has(hL), "A sees L after adding it");

        useStorage(repB);
        transport(addNode, repA, repB);
        assert.ok(dag.fold().links.has(hL), "B sees L after receiving the add");

        // --- Replica B: remove L. The removal carries L's ORIGINAL content hash. ---
        // This is the crux: the removal references hL (not a bogus ap://deleted
        // marker), so it can cancel the add both here and when A ingests it.
        const removeNode = dag.commitDiff([], [dag.hashLink(L)], "did:key:zB");
        assert.equal(removeNode.removals[0], hL, "removal MUST reference the original link hash");
        assert.equal(dag.fold().links.has(hL), false, "B no longer sees L after removing it");

        // --- Federate the removal back to A. ---
        useStorage(repA);
        transport(removeNode, repB, repA);
        assert.equal(dag.fold().links.has(hL), false, "A converges: L is absent after ingesting B's removal");

        // Convergence: both replicas agree on the SAME revision and empty link set.
        const revA = dag.currentRevision();
        useStorage(repB);
        const revB = dag.currentRevision();
        assert.equal(revA, revB, "both replicas reach the identical revision hash");
        assert.equal(dag.fold().links.size, 0);
    });

    it("REGRESSION: a placeholder-predicate removal (the old ap://deleted bug) could NEVER converge", () => {
        // The old code turned a Delete into a link with predicate ap://deleted,
        // whose content hash differs from the original add — so its hash was
        // never in the live set and the fold ignored it. We reproduce that shape
        // and assert it does NOT remove L, which is precisely the bug. The real
        // path (removal carrying the original hash) is proven by the test above.
        useStorage(repA);
        const L = makeLink({ source: "n://x", predicate: "p://q", target: "n://y" });
        dag.commitDiff([L], [], "did:key:zA");

        const bogusRemoval = makeLink({ source: "n://x", predicate: "ap://deleted", target: "n://y" });
        const bogusHash = dag.hashLink(bogusRemoval);
        assert.notEqual(bogusHash, dag.hashLink(L), "placeholder hash differs from the real link hash");

        dag.commitDiff([], [bogusHash], "did:key:zA");
        assert.ok(
            dag.fold().links.has(dag.hashLink(L)),
            "the ap://deleted-style removal fails to cancel L — this is the bug the fix removes",
        );
    });

    it("add-after-remove reinstates the link (causal re-add wins)", () => {
        useStorage(repA);
        const L = makeLink({ target: "t" });
        dag.commitDiff([L], [], "did:key:zA");
        dag.commitDiff([], [dag.hashLink(L)], "did:key:zA");
        assert.equal(dag.fold().links.has(dag.hashLink(L)), false, "removed after add");

        // Re-add the SAME link (same content hash) parented on the removal.
        dag.commitDiff([L], [], "did:key:zA");
        assert.ok(dag.fold().links.has(dag.hashLink(L)), "re-add after remove reinstates the link");
    });

    it("concurrent add + remove → add wins (OR-Set observed-remove contract)", () => {
        // A adds L (genesis). B, WITHOUT observing that add, removes hash(L) in a
        // concurrent branch. Because B's removal did not causally observe the add,
        // the fold keeps L: add wins for concurrent add/remove.
        const L = makeLink({ target: "concurrent" });
        const hL = fnv1a(dag.canonicalLink(L));

        useStorage(repA);
        const addNode = dag.commitDiff([L], [], "did:key:zA"); // prev: []

        useStorage(repB);
        // Concurrent removal: a genesis-level node that tombstones hL but does
        // NOT list addNode as a parent (B never saw it).
        const concurrentRemove = dag.sealDiff({ prev: [], additions: [], removals: [hL], author: "did:key:zB" });
        dag.putNode(concurrentRemove);

        // Bring both branches together on replica B.
        transport(addNode, repA, repB);
        assert.equal(dag.heads().length, 2, "add and concurrent-remove are two heads");
        assert.ok(
            dag.fold().links.has(hL),
            "concurrent remove that never observed the add does NOT cancel it (add wins)",
        );
    });
});

// ---------------------------------------------------------------------------
// §5.4 — Order-independent merge
// ---------------------------------------------------------------------------

describe("diff-DAG §5.4: merge is order-independent", () => {
    /**
     * Build a fixed 3-node DAG on a given storage by ingesting pre-sealed nodes
     * in a caller-chosen order. The nodes:
     *   g   : genesis, adds L1
     *   c1  : child of g, adds L2
     *   c2  : child of g, removes hash(L1)
     * Surviving set is therefore {L2}; the two heads are {c1, c2}.
     */
    function seal3(): { g: DiffNode; c1: DiffNode; c2: DiffNode; L1: LinkExpression; L2: LinkExpression } {
        const L1 = makeLink({ target: "L1" });
        const L2 = makeLink({ target: "L2" });
        const g = dag.sealDiff({ prev: [], additions: [L1], removals: [], author: "did:key:zA" });
        const c1 = dag.sealDiff({ prev: [g.id], additions: [L2], removals: [], author: "did:key:zA" });
        const c2 = dag.sealDiff({ prev: [g.id], additions: [], removals: [fnv1a(dag.canonicalLink(L1))], author: "did:key:zB" });
        return { g, c1, c2, L1, L2 };
    }

    function ingestInto(s: MemStorage, order: DiffNode[]): void {
        useStorage(s);
        for (const n of order) {
            dag.putNode(dag.sealDiff({ prev: n.prev, additions: n.additions, removals: n.removals, author: n.author }));
        }
    }

    it("any ingestion order yields the same revision hash and the same fold", () => {
        // Seal the fixture once (sealing is pure — uses only the hash fn).
        useStorage(new MemStorage());
        const { g, c1, c2, L1, L2 } = seal3();
        const hL1 = fnv1a(dag.canonicalLink(L1));
        const hL2 = fnv1a(dag.canonicalLink(L2));

        // Every permutation of the 3 nodes. Out-of-order arrivals (child before
        // parent) must still converge because putNode/topoOrder handle gaps.
        const perms: DiffNode[][] = [
            [g, c1, c2],
            [g, c2, c1],
            [c1, g, c2],
            [c1, c2, g],
            [c2, g, c1],
            [c2, c1, g],
        ];

        const revisions: string[] = [];
        const foldSignatures: string[] = [];
        for (const perm of perms) {
            const s = new MemStorage();
            ingestInto(s, perm);
            revisions.push(dag.currentRevision());
            const surviving = [...dag.fold().links.keys()].sort();
            foldSignatures.push(JSON.stringify(surviving));
        }

        // All revisions identical.
        for (const r of revisions) assert.equal(r, revisions[0], "revision must be order-independent");
        // All folds identical, and equal to {L2} (L1 tombstoned by c2).
        const expected = JSON.stringify([hL2]);
        for (const f of foldSignatures) assert.equal(f, expected, "fold must be order-independent");
        assert.ok(!foldSignatures[0].includes(hL1), "L1 is tombstoned in every order");

        // Sanity: the converged revision is the 2-head digest {c1, c2}.
        assert.equal(revisions[0], fnv1a(JSON.stringify([c1.id, c2.id].sort())));
    });

    it("distinct-hash additions commute (branch merge is set-union)", () => {
        // Two independent branches adding different links, merged → union,
        // regardless of the order the two branch nodes are ingested.
        useStorage(new MemStorage());
        const La = makeLink({ target: "branchA" });
        const Lb = makeLink({ target: "branchB" });
        const g = dag.sealDiff({ prev: [], additions: [], removals: [], author: "did:key:zA" });
        const ba = dag.sealDiff({ prev: [g.id], additions: [La], removals: [], author: "did:key:zA" });
        const bb = dag.sealDiff({ prev: [g.id], additions: [Lb], removals: [], author: "did:key:zB" });

        const s1 = new MemStorage();
        ingestInto(s1, [g, ba, bb]);
        const fold1 = [...dag.fold().links.keys()].sort();

        const s2 = new MemStorage();
        ingestInto(s2, [g, bb, ba]); // branch nodes ingested in reverse order
        const fold2 = [...dag.fold().links.keys()].sort();

        assert.deepEqual(fold1, fold2);
        assert.equal(fold1.length, 2);
        assert.ok(fold1.includes(fnv1a(dag.canonicalLink(La))));
        assert.ok(fold1.includes(fnv1a(dag.canonicalLink(Lb))));
    });
});

// ---------------------------------------------------------------------------
// §5.5 — Federation through the REAL AP activity encoding (C1 partition guard)
// ---------------------------------------------------------------------------
//
// §5.3's transport() copies a node's raw bytes and re-seals them, so it never
// exercises diffNodeToActivity → activityToDiffNode. That blind spot hid the
// live C1 A=10/B=10 partition: the node-level `author` (part of the content
// hash) was reconstructed from the AP actor URL on decode instead of being
// round-tripped, so every peer node re-sealed to a DIFFERENT id and was
// silently dropped at sync.ingestDiffActivities (`if (resealed.id !== decoded.id)
// continue`). These tests transport through the ACTUAL AP encoding, with the
// group/actor URLs DELIBERATELY unrelated to the committing DID, and assert the
// content hash survives the round-trip.

describe("diff-DAG §5.5: node survives the AP activity round-trip (C1 partition regression)", () => {
    const GROUP = "https://ap.example/ap/v1/groups/c1-group";
    // The AP actor URL is intentionally NOT the committing DID — this is the
    // exact mismatch that produced the C1 partition. `ap:${actor}` must NOT
    // leak into the node author, or the re-seal id diverges.
    const ACTOR = "https://ap.example/ap/v1/users/alice";

    /**
     * Model the real federation transport: encode the sender's sealed node as an
     * AP Create{Note}, decode it back on the receiver, re-seal from the decoded
     * content (exactly as sync.ingestDiffActivities does), verify the id, and
     * putNode. Returns the decoded+resealed node so callers can assert on it.
     */
    function transportViaActivity(node: DiffNode, from: MemStorage, to: MemStorage): DiffNode {
        const raw = from.get(`dag-node/${node.id}`);
        assert.ok(raw, "sealed node must be persisted on the sender before transport");
        const sent = JSON.parse(raw) as DiffNode;

        // Sender side: encode to an AP activity with a NON-DID actor URL.
        const activity = diffNodeToActivity(sent, { groupActorUrl: GROUP, actorUrl: ACTOR });

        // Receiver side: decode, then re-seal from content and verify the id —
        // the precise check sync.ingestDiffActivities gates ingestion on.
        const decoded = activityToDiffNode(activity);
        assert.ok(decoded, "activity must decode back into a diff node");
        const resealed = dag.sealDiff({
            prev: decoded.prev,
            additions: decoded.additions,
            removals: decoded.removals,
            author: decoded.author,
        });
        assert.equal(
            resealed.id,
            sent.id,
            "node author must round-trip through the AP activity so the re-seal reproduces the content hash",
        );
        dag.putNode(resealed);
        return resealed;
    }

    it("the committing DID round-trips — decoded node author is the DID, not the AP actor URL", () => {
        const storage = new MemStorage();
        useStorage(storage);
        const L = makeLink({ target: "roundtrip" });
        const node = dag.commitDiff([L], [], "did:key:zAlice");

        const activity = diffNodeToActivity(node, { groupActorUrl: GROUP, actorUrl: ACTOR });
        const decoded = activityToDiffNode(activity);
        assert.ok(decoded);
        assert.equal(decoded.author, "did:key:zAlice", "author must be the committing DID");
        assert.notEqual(decoded.author, `ap:${ACTOR}`, "author must NOT be reconstructed from the AP actor URL");
        assert.equal(decoded.id, node.id, "decoded id equals the original content hash");

        // And the re-seal reproduces the SAME id (the ingest gate passes).
        const resealed = dag.sealDiff({
            prev: decoded.prev,
            additions: decoded.additions,
            removals: decoded.removals,
            author: decoded.author,
        });
        assert.equal(resealed.id, node.id, "re-seal reproduces the content hash → node is accepted on ingest");
    });

    it("two replicas converge across the AP encoding: B's fold contains A's links (reproduces C1 add-convergence)", () => {
        const repA = new MemStorage();
        const repB = new MemStorage();

        // A commits several links under its DID and federates each via a full
        // AP activity round-trip to B — the exact C1 add path.
        useStorage(repA);
        const links = [
            makeLink({ target: "m1" }),
            makeLink({ target: "m2" }),
            makeLink({ target: "m3" }),
        ];
        const nodes = links.map((L) => dag.commitDiff([L], [], "did:key:zAlice"));
        const hashes = links.map((L) => fnv1a(dag.canonicalLink(L)));
        for (const h of hashes) assert.ok(dag.fold().links.has(h), "A sees its own link");

        useStorage(repB);
        for (const node of nodes) transportViaActivity(node, repA, repB);

        // B converges on every link A added — the assertion that FAILED in the
        // live C1 run (B kept only its own nodes, dropping A's at the id check).
        const foldB = dag.fold().links;
        for (const h of hashes) {
            assert.ok(foldB.has(h), "B's fold contains A's link after the AP round-trip");
        }
        assert.equal(foldB.size, links.length, "B's fold is exactly A's link set (no drops, no dupes)");

        // And the revisions match — full convergence, not just link-set overlap.
        const revB = dag.currentRevision();
        useStorage(repA);
        assert.equal(dag.currentRevision(), revB, "both replicas reach the identical revision after federation");
    });

    it("removal federates through the AP encoding and cancels the add on the peer", () => {
        const repA = new MemStorage();
        const repB = new MemStorage();

        const L = makeLink({ target: "to-remove" });
        const hL = fnv1a(dag.canonicalLink(L));

        useStorage(repA);
        const addNode = dag.commitDiff([L], [], "did:key:zAlice");

        useStorage(repB);
        transportViaActivity(addNode, repA, repB);
        assert.ok(dag.fold().links.has(hL), "B sees L after the add federates");

        // B removes L (removal carries the ORIGINAL hash) and federates back to A
        // through the AP encoding.
        const removeNode = dag.commitDiff([], [dag.hashLink(L)], "did:key:zBob");
        assert.equal(dag.fold().links.has(hL), false, "B no longer sees L");

        useStorage(repA);
        transportViaActivity(removeNode, repB, repA);
        assert.equal(dag.fold().links.has(hL), false, "A converges: L is cancelled after ingesting B's removal");
    });

    it("an activity missing ad4m:author (older encoder) decodes with the actor-URL fallback", () => {
        // Backward-compatibility: an activity that predates the fix carries no
        // ad4m:author. It must still decode (author falls back to ap:${actor}),
        // even though it can no longer re-seal to a DID-based id — that node is
        // correctly rejected on ingest, which is the safe, lossless-or-drop
        // behaviour the content-address contract requires.
        const storage = new MemStorage();
        useStorage(storage);
        const L = makeLink({ target: "legacy" });
        const node = dag.commitDiff([L], [], "did:key:zAlice");

        const activity = diffNodeToActivity(node, { groupActorUrl: GROUP, actorUrl: ACTOR });
        // Strip ad4m:author from the Diff tag to simulate an older encoder.
        const noteObj = activity.object as APObject;
        const diffTag = (noteObj.tag || []).find((t) => t.type === "ad4m:Diff")!;
        delete (diffTag as Record<string, unknown>)["ad4m:author"];

        const decoded = activityToDiffNode(activity);
        assert.ok(decoded, "a legacy activity still decodes");
        assert.equal(decoded.author, `ap:${ACTOR}`, "legacy author falls back to the AP actor URL");
    });
});
