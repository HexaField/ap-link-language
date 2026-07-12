/**
 * Cross-runtime test harness.
 *
 * Exercises the full production modules (store, delivery, sync, actors,
 * follow, security, inbox, http-signatures) using mock adapters that
 * simulate an alternative runtime (e.g. WASM).
 *
 * This proves that the core logic has NO hidden dependency on ad4m:host —
 * every external call goes through the injected adapters.
 *
 * Test scenarios:
 * 1. Store links via mock storage, query them back, verify indexes
 * 2. Commit a diff with mock transport, verify AP activity was "delivered"
 * 3. Process inbox signals with mock storage + transport, verify links stored
 * 4. Sync from outbox with mock transport providing paginated responses
 * 5. Follow/Accept handshake with mock transport
 * 6. Full round-trip: commit → activity → deliver → inbound → link
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Adapter interfaces
import type { StorageAdapter } from "../src/adapters.js";
import { initStorage } from "../src/adapters.js";
import type { Transport, TransportResponse } from "../src/adapters.js";
import { initTransport } from "../src/adapters.js";
import type { SigningAdapter } from "../src/adapters.js";
import { initSigning } from "../src/adapters.js";
import type { RuntimeAdapter } from "../src/adapters.js";
import { initRuntime } from "../src/adapters.js";

// Production modules under test
import * as store from "../src/store.js";
import * as dag from "../src/dag.js";
import { signedHeaders, computeDigest, buildSigningString, signRequest } from "../src/http-signatures.js";
import { deliverToInbox, deliverToFollowers } from "../src/delivery.js";
import { fetchCollectionPage, fetchOutboxMeta, syncFromOutbox, processInboundActivities } from "../src/sync.js";
import { resolveActor, resolveAuthor, getActorInbox, invalidateActorCache } from "../src/actors.js";
import { isAllowedToPost, checkRateLimit, registerFollower, removeFollower, getFollowerInboxes, blockActor, unblockActor, isBlocked } from "../src/security.js";
import { handleFollow, handleUndo, sendFollowRequest, listPendingFollows } from "../src/follow.js";
import { routeInboundActivity } from "../src/inbox.js";

// Types
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";
import type { APActivity, APObject, APLinkTag, APCollection, APCollectionPage } from "../src/activitypub.js";
import { apContext } from "../src/activitypub.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import type { APLanguageSettings } from "../src/settings.js";
import { diffToActivities, linkContentKey, inboundActivityToLink, inboundActivityToLinks } from "../src/translate.js";

// ---------------------------------------------------------------------------
// Mock Adapters
// ---------------------------------------------------------------------------

class MockStorageAdapter implements StorageAdapter {
    private data = new Map<string, string>();

    get(key: string): string | null {
        return this.data.get(key) ?? null;
    }

    put(key: string, value: string): void {
        this.data.set(key, value);
    }

    delete(key: string): void {
        this.data.delete(key);
    }

    listKeys(prefix?: string): string[] {
        const all = [...this.data.keys()];
        if (!prefix) return all;
        return all.filter(k => k.startsWith(prefix));
    }

    /** Expose internal state for test assertions */
    _dump(): Map<string, string> {
        return new Map(this.data);
    }

    /** Reset all state */
    _clear(): void {
        this.data.clear();
    }
}

interface RecordedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}

class MockTransport implements Transport {
    private responses = new Map<string, TransportResponse>();
    public requests: RecordedRequest[] = [];

    /**
     * Register a canned response for a URL.
     * Multiple registrations for the same URL: last one wins.
     */
    addResponse(url: string, response: TransportResponse): void {
        this.responses.set(url, response);
    }

    /**
     * Register a canned response keyed by URL prefix match.
     */
    addPrefixResponse(prefix: string, response: TransportResponse): void {
        // Store with a special prefix marker
        this.responses.set(`PREFIX:${prefix}`, response);
    }

    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        this.requests.push({ url, method, headers, body });

        // Exact match first
        const exact = this.responses.get(url);
        if (exact) return exact;

        // Prefix match
        for (const [key, resp] of this.responses.entries()) {
            if (key.startsWith("PREFIX:") && url.startsWith(key.slice(7))) {
                return resp;
            }
        }

        // Default: 404
        return { status: 404, headers: {}, body: "Not found" };
    }

    /** Reset recorded requests */
    _clearRequests(): void {
        this.requests = [];
    }
}

class MockSigningAdapter implements SigningAdapter {
    public signedPayloads: string[] = [];

    signStringHex(payload: string): string {
        this.signedPayloads.push(payload);
        return "mocksig" + payload.length.toString(16);
    }

    signingKeyId(): string {
        return "mock-key-id";
    }
}

class MockRuntime implements RuntimeAdapter {
    public signals: string[] = [];
    public diffs: unknown[] = [];

    hash(data: string): string {
        return simpleHash(data);
    }

    emitSignal(data: string): void {
        this.signals.push(data);
    }

    emitPerspectiveDiff(diff: unknown): void {
        this.diffs.push(diff);
    }

    _clear(): void {
        this.signals = [];
        this.diffs = [];
    }
}

// ---------------------------------------------------------------------------
// Simple hash function (deterministic, no ad4m:host dependency)
// ---------------------------------------------------------------------------

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GROUP_ACTOR_URL = "https://test.example.com/ap/v1/groups/test-neighbourhood";
const GROUP_OUTBOX_URL = `${GROUP_ACTOR_URL}/outbox`;
const ACTOR_URL = "https://test.example.com/ap/v1/users/did%3Akey%3Az6MkTest";
const NEIGHBOURHOOD_URL = `neighbourhood://${GROUP_ACTOR_URL}`;

function makeLinkExpression(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "literal://hello",
            target: "literal://world",
            predicate: "sioc://content_of",
        },
        proof: {
            signature: "abc123",
            key: "key123",
        },
        ...overrides,
    };
}

function makeChatLink(index: number = 1): LinkExpression {
    return makeLinkExpression({
        data: {
            source: "channel://main",
            target: `expr://msg-${index.toString().padStart(3, "0")}`,
            predicate: "flux://has_message",
        },
    });
}

function makeAPCreateNote(id: string, actorUrl: string, content: string, overrides?: Partial<APObject>): APActivity {
    return {
        "@context": apContext(),
        type: "Create",
        id: `https://remote.example.com/activities/${id}`,
        actor: actorUrl,
        published: "2026-05-02T12:00:00Z",
        to: [`${GROUP_ACTOR_URL}/followers`],
        object: {
            type: "Note",
            id: `https://remote.example.com/objects/${id}`,
            attributedTo: actorUrl,
            content,
            published: "2026-05-02T12:00:00Z",
            context: GROUP_ACTOR_URL,
            ...overrides,
        },
    };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

let mockStorage: MockStorageAdapter;
let mockTransport: MockTransport;
let mockSigning: MockSigningAdapter;
let mockRuntime: MockRuntime;

function initAllAdapters(): void {
    mockStorage = new MockStorageAdapter();
    mockTransport = new MockTransport();
    mockSigning = new MockSigningAdapter();
    mockRuntime = new MockRuntime();

    initRuntime(mockRuntime);
    initStorage(mockStorage);
    initTransport(mockTransport);
    initSigning(mockSigning);
    store.initStore(simpleHash);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Store operations via mock storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Store operations", () => {
    beforeEach(() => initAllAdapters());

    it("stores and retrieves a link", () => {
        const link = makeLinkExpression();
        const hash = store.putLink(link);
        assert.ok(hash);

        const retrieved = store.getLink(hash);
        assert.ok(retrieved);
        assert.equal(retrieved!.data.source, "literal://hello");
        assert.equal(retrieved!.data.target, "literal://world");
        assert.equal(retrieved!.data.predicate, "sioc://content_of");
        assert.equal(retrieved!.author, "did:key:z6MkTest");
    });

    it("indexes by source, target, and predicate", () => {
        const link = makeLinkExpression();
        store.putLink(link);

        const bySource = store.queryLinks({ source: "literal://hello" });
        assert.equal(bySource.length, 1);
        assert.equal(bySource[0].data.source, "literal://hello");

        const byTarget = store.queryLinks({ target: "literal://world" });
        assert.equal(byTarget.length, 1);

        const byPredicate = store.queryLinks({ predicate: "sioc://content_of" });
        assert.equal(byPredicate.length, 1);
    });

    it("returns empty for queries with no matches", () => {
        store.putLink(makeLinkExpression());
        const results = store.queryLinks({ source: "nonexistent://uri" });
        assert.equal(results.length, 0);
    });

    it("supports multi-field query filtering", () => {
        store.putLink(makeLinkExpression());
        store.putLink(makeLinkExpression({
            data: { source: "literal://hello", target: "literal://other", predicate: "other://pred" },
        }));

        // Source + predicate filter
        const results = store.queryLinks({ source: "literal://hello", predicate: "sioc://content_of" });
        assert.equal(results.length, 1);
        assert.equal(results[0].data.target, "literal://world");
    });

    it("removes links and cleans up indexes", () => {
        const link = makeLinkExpression();
        const hash = store.putLink(link);
        assert.ok(store.getLink(hash));

        store.removeLink(link);
        assert.equal(store.getLink(hash), null);

        const bySource = store.queryLinks({ source: "literal://hello" });
        assert.equal(bySource.length, 0);
    });

    it("applies a PerspectiveDiff atomically", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "c" },
        });

        // First add link1
        store.putLink(link1);

        // Then apply diff: add link2, remove link1
        const diff: PerspectiveDiff = {
            additions: [link2],
            removals: [link1],
        };
        store.applyDiff(diff);

        const hash1 = store.hashLink(link1);
        const hash2 = store.hashLink(link2);
        assert.equal(store.getLink(hash1), null);
        assert.ok(store.getLink(hash2));
    });

    it("allLinks returns all stored links", () => {
        store.putLink(makeLinkExpression());
        store.putLink(makeLinkExpression({
            data: { source: "x", target: "y", predicate: "z" },
            timestamp: "2026-05-02T01:00:00.000Z",
        }));

        const all = store.allLinks();
        assert.equal(all.links.length, 2);
    });

    it("revision is a content hash of the diff-DAG head(s), not a cursor", () => {
        // Empty DAG → no revision.
        assert.equal(store.getRevision(), null);

        // Committing a diff-DAG node makes the revision a content hash of the
        // head. There is no mutable "revision cursor" to set anymore — the old
        // store.setRevision(pageUrl) is gone; a revision is DERIVED from the DAG.
        const node = dag.commitDiff(
            [makeLinkExpression({ data: { source: "s", target: "t", predicate: "p" } })],
            [],
            "did:key:zRevTest",
        );
        const rev = store.getRevision();
        assert.ok(rev, "revision must be non-null once the DAG has a head");
        assert.equal(rev, node.id, "single-head revision equals that head's content hash");

        // Deterministic + stable: recomputing from the same DAG state yields the
        // identical hash (no timestamp/nonce leakage).
        assert.equal(store.getRevision(), rev);
        assert.equal(dag.currentRevision(), rev);
    });

    it("manages AP objects cache", () => {
        assert.equal(store.getAPObject("https://example.com/obj/1"), null);
        store.putAPObject("https://example.com/obj/1", '{"type":"Note"}');
        assert.equal(store.getAPObject("https://example.com/obj/1"), '{"type":"Note"}');
    });

    it("manages peers", () => {
        store.setPeer("did:key:z6MkA", { name: "Alice" });
        store.setPeer("did:key:z6MkB", { name: "Bob" });

        const peers = store.listPeers();
        assert.equal(peers.length, 2);

        const meta = store.getPeerMetadata("did:key:z6MkA");
        assert.ok(meta);
        assert.equal(meta!.name, "Alice");

        store.removePeer("did:key:z6MkA");
        assert.equal(store.getPeerMetadata("did:key:z6MkA"), null);
        assert.equal(store.listPeers().length, 1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. HTTP Signatures via mock signing
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: HTTP Signatures", () => {
    beforeEach(() => initAllAdapters());

    it("generates signed headers using the mock signing adapter", () => {
        const targetUrl = "https://remote.example.com/inbox";
        const body = '{"type":"Create"}';

        const headers = signedHeaders("test-key-id#main-key", targetUrl, body);

        assert.ok(headers["Signature"]);
        assert.ok(headers["Signature"].includes("test-key-id#main-key"));
        assert.ok(headers["Signature"].includes("mocksig")); // from mock adapter
        assert.ok(headers["Date"]);
        assert.ok(headers["Digest"]);
        assert.equal(headers["Content-Type"], "application/activity+json");

        // The signing adapter should have been called
        assert.equal(mockSigning.signedPayloads.length, 1);
    });

    it("computeDigest is deterministic", () => {
        const d1 = computeDigest("test body");
        const d2 = computeDigest("test body");
        assert.equal(d1, d2);
    });

    it("signRequest includes all expected fields", () => {
        const sig = signRequest("my-key-id", {
            method: "POST",
            path: "/inbox",
            host: "remote.example.com",
            date: "Thu, 01 Jan 2026 00:00:00 GMT",
            digest: "test-digest",
        });

        assert.ok(sig.includes('keyId="my-key-id"'));
        assert.ok(sig.includes('algorithm="hs2019"'));
        assert.ok(sig.includes("(request-target) host date digest"));
        assert.ok(sig.includes("mocksig"));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Delivery via mock transport
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Delivery", () => {
    beforeEach(() => initAllAdapters());

    it("delivers an activity to an inbox via mock transport", async () => {
        const inboxUrl = "https://remote.example.com/users/bob/inbox";
        mockTransport.addResponse(inboxUrl, {
            status: 202,
            headers: {},
            body: "",
        });

        const activity = makeAPCreateNote("note-1", ACTOR_URL, "Hello!");
        const result = await deliverToInbox(activity, inboxUrl, `${GROUP_ACTOR_URL}#main-key`);

        assert.equal(result.ok, true);
        assert.equal(result.status, 202);
        assert.equal(result.targetUrl, inboxUrl);

        // Verify the transport received the request
        assert.equal(mockTransport.requests.length, 1);
        assert.equal(mockTransport.requests[0].url, inboxUrl);
        assert.equal(mockTransport.requests[0].method, "POST");

        // Body should be the serialized activity
        const sentBody = JSON.parse(mockTransport.requests[0].body);
        assert.equal(sentBody.type, "Create");
    });

    it("handles delivery failure gracefully", async () => {
        const inboxUrl = "https://remote.example.com/users/alice/inbox";
        mockTransport.addResponse(inboxUrl, {
            status: 500,
            headers: {},
            body: "Internal Server Error",
        });

        const activity = makeAPCreateNote("note-2", ACTOR_URL, "Fail test");
        const result = await deliverToInbox(activity, inboxUrl, `${GROUP_ACTOR_URL}#main-key`);

        assert.equal(result.ok, false);
        assert.equal(result.status, 500);
    });

    it("delivers to multiple follower inboxes", async () => {
        const inbox1 = "https://server1.example.com/inbox";
        const inbox2 = "https://server2.example.com/inbox";
        mockTransport.addResponse(inbox1, { status: 202, headers: {}, body: "" });
        mockTransport.addResponse(inbox2, { status: 202, headers: {}, body: "" });

        const activity = makeAPCreateNote("note-3", ACTOR_URL, "Broadcast");
        const results = await deliverToFollowers(
            activity,
            [inbox1, inbox2],
            `${GROUP_ACTOR_URL}#main-key`,
            GROUP_ACTOR_URL,
        );

        assert.equal(results.length, 2);
        assert.ok(results.every(r => r.ok));
        // Transport should have received 2 delivery requests (plus signal doesn't go through transport)
        assert.equal(
            mockTransport.requests.filter(r => r.method === "POST").length,
            2,
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Sync from outbox with mock transport
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Outbox sync", () => {
    beforeEach(() => initAllAdapters());

    it("fetches and processes activities from outbox", async () => {
        const activities: APActivity[] = [
            makeAPCreateNote("note-a", "https://remote.example.com/users/alice", "First post"),
            makeAPCreateNote("note-b", "https://remote.example.com/users/bob", "Second post"),
        ];

        // Mock the outbox collection response
        const collection: APCollection = {
            "@context": apContext(),
            type: "OrderedCollection",
            id: GROUP_OUTBOX_URL,
            totalItems: 2,
            orderedItems: activities,
        };

        mockTransport.addResponse(GROUP_OUTBOX_URL, {
            status: 200,
            headers: { "Content-Type": "application/activity+json" },
            body: JSON.stringify(collection),
        });

        const diff = await syncFromOutbox(GROUP_OUTBOX_URL, NEIGHBOURHOOD_URL);

        assert.equal(diff.additions.length, 2);
        assert.equal(diff.removals.length, 0);

        // Verify links are in the store
        const allLinks = store.allLinks();
        assert.equal(allLinks.links.length, 2);

        // External (non-ad4m) Notes are the Role-B projection: they are bridged
        // into the link cache but are NOT convergence-substrate diff nodes, so
        // they do NOT advance the revision. The revision is a content hash of
        // the diff-DAG head(s); with no ad4m diff activities in this outbox the
        // DAG is empty and the revision is null. (The old code used the last
        // activity id as an opaque cursor — e.g. contained "note-b" — which is
        // exactly the fiction this rework removes.)
        assert.equal(store.getRevision(), null);
    });

    it("handles paginated outbox", async () => {
        // Page 1
        const page1Activities: APActivity[] = [
            makeAPCreateNote("p1-a", "https://remote.example.com/users/alice", "Page 1 A"),
            makeAPCreateNote("p1-b", "https://remote.example.com/users/alice", "Page 1 B"),
        ];

        const page1: APCollectionPage = {
            "@context": apContext(),
            type: "OrderedCollectionPage",
            id: `${GROUP_OUTBOX_URL}?page=1`,
            partOf: GROUP_OUTBOX_URL,
            next: `${GROUP_OUTBOX_URL}?page=2`,
            orderedItems: page1Activities,
        };

        // Page 2
        const page2Activities: APActivity[] = [
            makeAPCreateNote("p2-a", "https://remote.example.com/users/bob", "Page 2 A"),
        ];

        const page2: APCollectionPage = {
            "@context": apContext(),
            type: "OrderedCollectionPage",
            id: `${GROUP_OUTBOX_URL}?page=2`,
            partOf: GROUP_OUTBOX_URL,
            orderedItems: page2Activities,
        };

        // Collection metadata
        const collection: APCollection = {
            "@context": apContext(),
            type: "OrderedCollection",
            id: GROUP_OUTBOX_URL,
            totalItems: 3,
            first: `${GROUP_OUTBOX_URL}?page=1`,
        };

        mockTransport.addResponse(GROUP_OUTBOX_URL, {
            status: 200,
            headers: {},
            body: JSON.stringify(collection),
        });
        mockTransport.addResponse(`${GROUP_OUTBOX_URL}?page=1`, {
            status: 200,
            headers: {},
            body: JSON.stringify(page1),
        });
        mockTransport.addResponse(`${GROUP_OUTBOX_URL}?page=2`, {
            status: 200,
            headers: {},
            body: JSON.stringify(page2),
        });

        const diff = await syncFromOutbox(GROUP_OUTBOX_URL, NEIGHBOURHOOD_URL);

        assert.equal(diff.additions.length, 3);
        assert.equal(store.allLinks().links.length, 3);
    });

    it("re-syncing the same outbox is idempotent (derived-cache delta, not a cursor)", async () => {
        // Idempotency no longer comes from an opaque "already-processed" cursor;
        // it falls out of the derived cache. A second fold/projection of the
        // same activities produces NO new additions because the links are
        // already materialised. This is the honest replacement for the old
        // revision-cursor dedup.
        const activities: APActivity[] = [
            makeAPCreateNote("rev-a", "https://remote.example.com/users/alice", "Old"),
            makeAPCreateNote("rev-b", "https://remote.example.com/users/alice", "New"),
        ];

        const collection: APCollection = {
            "@context": apContext(),
            type: "OrderedCollection",
            id: GROUP_OUTBOX_URL,
            totalItems: 2,
            orderedItems: activities,
        };

        mockTransport.addResponse(GROUP_OUTBOX_URL, {
            status: 200,
            headers: {},
            body: JSON.stringify(collection),
        });

        // First sync: both links are new.
        const diff1 = await syncFromOutbox(GROUP_OUTBOX_URL, NEIGHBOURHOOD_URL);
        assert.equal(diff1.additions.length, 2);

        // Second sync: same collection, nothing new to announce to subscribers.
        mockTransport._clearRequests();
        const diff2 = await syncFromOutbox(GROUP_OUTBOX_URL, NEIGHBOURHOOD_URL);
        assert.equal(diff2.additions.length, 0);
        // ...and the store did not grow (no duplicate links).
        assert.equal(store.allLinks().links.length, 2);
    });

    it("handles empty outbox", async () => {
        const collection: APCollection = {
            "@context": apContext(),
            type: "OrderedCollection",
            id: GROUP_OUTBOX_URL,
            totalItems: 0,
        };

        mockTransport.addResponse(GROUP_OUTBOX_URL, {
            status: 200,
            headers: {},
            body: JSON.stringify(collection),
        });

        const diff = await syncFromOutbox(GROUP_OUTBOX_URL, NEIGHBOURHOOD_URL);
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });

    it("handles outbox fetch failure", async () => {
        mockTransport.addResponse(GROUP_OUTBOX_URL, {
            status: 500,
            headers: {},
            body: "Server Error",
        });

        const diff = await syncFromOutbox(GROUP_OUTBOX_URL, NEIGHBOURHOOD_URL);
        assert.equal(diff.additions.length, 0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Actor resolution via mock transport + storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Actor resolution", () => {
    beforeEach(() => initAllAdapters());

    it("fetches and caches an actor document", async () => {
        const actorUrl = "https://mastodon.example.com/users/alice";
        const actorDoc = {
            id: actorUrl,
            type: "Person",
            inbox: "https://mastodon.example.com/users/alice/inbox",
            outbox: "https://mastodon.example.com/users/alice/outbox",
            preferredUsername: "alice",
            name: "Alice",
        };

        mockTransport.addResponse(actorUrl, {
            status: 200,
            headers: {},
            body: JSON.stringify(actorDoc),
        });

        const actor = await resolveActor(actorUrl);
        assert.ok(actor);
        assert.equal(actor!.id, actorUrl);
        assert.equal(actor!.inbox, "https://mastodon.example.com/users/alice/inbox");
        assert.equal(actor!.name, "Alice");

        // Second call should use cache (no new transport request)
        mockTransport._clearRequests();
        const cached = await resolveActor(actorUrl);
        assert.ok(cached);
        assert.equal(mockTransport.requests.length, 0);
    });

    it("resolves author as DID for AD4M actors", async () => {
        const actorUrl = "https://ad4m.example.com/users/bob";
        mockTransport.addResponse(actorUrl, {
            status: 200,
            headers: {},
            body: JSON.stringify({
                id: actorUrl,
                type: "Person",
                inbox: "https://ad4m.example.com/users/bob/inbox",
                "ad4m:did": "did:key:z6MkBobKey",
            }),
        });

        const author = await resolveAuthor(actorUrl);
        assert.equal(author, "did:key:z6MkBobKey");
    });

    it("resolves author as ap: prefix for non-AD4M actors", async () => {
        const actorUrl = "https://mastodon.social/users/carol";
        mockTransport.addResponse(actorUrl, {
            status: 200,
            headers: {},
            body: JSON.stringify({
                id: actorUrl,
                type: "Person",
                inbox: "https://mastodon.social/users/carol/inbox",
            }),
        });

        const author = await resolveAuthor(actorUrl);
        assert.equal(author, `ap:${actorUrl}`);
    });

    it("gets actor inbox URL", async () => {
        const actorUrl = "https://pleroma.example.com/users/dave";
        mockTransport.addResponse(actorUrl, {
            status: 200,
            headers: {},
            body: JSON.stringify({
                id: actorUrl,
                type: "Person",
                inbox: "https://pleroma.example.com/users/dave/inbox",
            }),
        });

        const inbox = await getActorInbox(actorUrl);
        assert.equal(inbox, "https://pleroma.example.com/users/dave/inbox");
    });

    it("invalidates cached actor", async () => {
        const actorUrl = "https://example.com/users/eve";
        mockTransport.addResponse(actorUrl, {
            status: 200,
            headers: {},
            body: JSON.stringify({
                id: actorUrl,
                type: "Person",
                inbox: "https://example.com/users/eve/inbox",
                name: "Eve v1",
            }),
        });

        await resolveActor(actorUrl);
        invalidateActorCache(actorUrl);

        // Update the response
        mockTransport.addResponse(actorUrl, {
            status: 200,
            headers: {},
            body: JSON.stringify({
                id: actorUrl,
                type: "Person",
                inbox: "https://example.com/users/eve/inbox",
                name: "Eve v2",
            }),
        });

        const actor = await resolveActor(actorUrl);
        assert.equal(actor!.name, "Eve v2");
    });

    it("returns null for failed actor fetch", async () => {
        const actor = await resolveActor("https://nonexistent.example.com/users/ghost");
        assert.equal(actor, null);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Security via mock storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Security", () => {
    beforeEach(() => initAllAdapters());

    it("allows posting in open membership mode", () => {
        const settings: APLanguageSettings = { ...DEFAULT_SETTINGS, membership: "open" };
        const result = isAllowedToPost("https://unknown.example.com/users/x", settings);
        assert.equal(result.allowed, true);
    });

    it("rejects non-followers in followers-only mode", () => {
        const settings: APLanguageSettings = { ...DEFAULT_SETTINGS, membership: "followers-only" };
        const result = isAllowedToPost("https://random.example.com/users/x", settings);
        assert.equal(result.allowed, false);
    });

    it("allows registered followers", () => {
        const actorUrl = "https://mastodon.example.com/users/follower";
        registerFollower(actorUrl, "https://mastodon.example.com/users/follower/inbox");

        const settings: APLanguageSettings = { ...DEFAULT_SETTINGS, membership: "followers-only" };
        const result = isAllowedToPost(actorUrl, settings);
        assert.equal(result.allowed, true);
    });

    it("removes followers and cleans up", () => {
        const actorUrl = "https://mastodon.example.com/users/temp";
        registerFollower(actorUrl, "https://mastodon.example.com/users/temp/inbox", "did:key:z6MkTemp");

        const inboxesBefore = getFollowerInboxes();
        assert.ok(inboxesBefore.length > 0);

        removeFollower(actorUrl);

        const inboxesAfter = getFollowerInboxes();
        assert.equal(inboxesAfter.filter(i => i.includes("temp")).length, 0);
    });

    it("block list prevents posting", () => {
        const actorUrl = "https://spam.example.com/users/spammer";
        blockActor(actorUrl);

        assert.equal(isBlocked(actorUrl), true);
        const result = isAllowedToPost(actorUrl, DEFAULT_SETTINGS);
        assert.equal(result.allowed, false);
        assert.ok(result.reason?.includes("blocked"));

        unblockActor(actorUrl);
        assert.equal(isBlocked(actorUrl), false);
    });

    it("rate limiting tracks requests per actor", () => {
        const actorUrl = "https://busy.example.com/users/poster";
        const settings: APLanguageSettings = {
            ...DEFAULT_SETTINGS,
            rateLimit: { maxPerMinute: 3 },
        };

        assert.equal(checkRateLimit(actorUrl, settings), true);
        assert.equal(checkRateLimit(actorUrl, settings), true);
        assert.equal(checkRateLimit(actorUrl, settings), true);
        // 4th request should be rate limited
        assert.equal(checkRateLimit(actorUrl, settings), false);
    });

    it("collects follower inbox URLs", () => {
        registerFollower(
            "https://server1.example.com/users/a",
            "https://server1.example.com/users/a/inbox",
        );
        registerFollower(
            "https://server2.example.com/users/b",
            "https://server2.example.com/users/b/inbox",
        );

        const inboxes = getFollowerInboxes();
        assert.equal(inboxes.length, 2);
        assert.ok(inboxes.includes("https://server1.example.com/users/a/inbox"));
        assert.ok(inboxes.includes("https://server2.example.com/users/b/inbox"));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Follow/Accept handshake via mock transport
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Follow handshake", () => {
    beforeEach(() => initAllAdapters());

    it("auto-accepts follow and delivers Accept activity", async () => {
        const followerActorUrl = "https://mastodon.example.com/users/follower";
        const followerInbox = "https://mastodon.example.com/users/follower/inbox";

        // Mock: resolve actor document
        mockTransport.addResponse(followerActorUrl, {
            status: 200,
            headers: {},
            body: JSON.stringify({
                id: followerActorUrl,
                type: "Person",
                inbox: followerInbox,
                preferredUsername: "follower",
            }),
        });

        // Mock: Accept delivery to follower inbox
        mockTransport.addResponse(followerInbox, {
            status: 202,
            headers: {},
            body: "",
        });

        const followActivity: APActivity = {
            "@context": apContext(),
            type: "Follow",
            id: "https://mastodon.example.com/activities/follow-1",
            actor: followerActorUrl,
            published: "2026-05-02T10:00:00Z",
            object: { type: "Group", id: GROUP_ACTOR_URL },
        };

        const settings: APLanguageSettings = { ...DEFAULT_SETTINGS, requireApproval: false };
        const result = await handleFollow(followActivity, GROUP_ACTOR_URL, `${GROUP_ACTOR_URL}#main-key`, settings);

        assert.equal(result.accepted, true);
        assert.equal(result.pending, false);
        assert.ok(result.acceptActivity);
        assert.equal(result.acceptActivity!.type, "Accept");

        // Verify Accept was delivered
        const postRequests = mockTransport.requests.filter(r => r.method === "POST");
        assert.ok(postRequests.length > 0);
        const acceptDelivery = postRequests.find(r => r.url === followerInbox);
        assert.ok(acceptDelivery);
        const sentBody = JSON.parse(acceptDelivery!.body);
        assert.equal(sentBody.type, "Accept");

        // Verify follower is registered
        const inboxes = getFollowerInboxes();
        assert.ok(inboxes.includes(followerInbox));
    });

    it("queues follow for approval when requireApproval is true", async () => {
        const followerActorUrl = "https://mastodon.example.com/users/pending";

        mockTransport.addResponse(followerActorUrl, {
            status: 200,
            headers: {},
            body: JSON.stringify({
                id: followerActorUrl,
                type: "Person",
                inbox: "https://mastodon.example.com/users/pending/inbox",
            }),
        });

        const followActivity: APActivity = {
            "@context": apContext(),
            type: "Follow",
            id: "https://mastodon.example.com/activities/follow-pending",
            actor: followerActorUrl,
            published: "2026-05-02T11:00:00Z",
            object: { type: "Group", id: GROUP_ACTOR_URL },
        };

        const settings: APLanguageSettings = { ...DEFAULT_SETTINGS, requireApproval: true };
        const result = await handleFollow(followActivity, GROUP_ACTOR_URL, `${GROUP_ACTOR_URL}#main-key`, settings);

        assert.equal(result.accepted, false);
        assert.equal(result.pending, true);

        // Verify it's in the pending list
        const pending = listPendingFollows();
        assert.equal(pending.length, 1);
        assert.equal(pending[0].actor, followerActorUrl);
    });

    it("handles Undo{Follow}", async () => {
        // First register a follower
        const followerActorUrl = "https://mastodon.example.com/users/leaver";
        registerFollower(followerActorUrl, "https://mastodon.example.com/users/leaver/inbox");

        const undoActivity: APActivity = {
            "@context": apContext(),
            type: "Undo",
            id: "https://mastodon.example.com/activities/undo-1",
            actor: followerActorUrl,
            published: "2026-05-02T12:00:00Z",
            object: { type: "Follow", id: "https://mastodon.example.com/activities/follow-1" },
        };

        await handleUndo(undoActivity);

        // Follower should be removed
        const inboxes = getFollowerInboxes();
        assert.equal(inboxes.filter(i => i.includes("leaver")).length, 0);
    });

    it("sends outbound follow request", async () => {
        const targetActorUrl = "https://remote.example.com/users/target";
        const targetInbox = "https://remote.example.com/users/target/inbox";

        mockTransport.addResponse(targetActorUrl, {
            status: 200,
            headers: {},
            body: JSON.stringify({
                id: targetActorUrl,
                type: "Person",
                inbox: targetInbox,
            }),
        });
        mockTransport.addResponse(targetInbox, {
            status: 202,
            headers: {},
            body: "",
        });

        await sendFollowRequest(targetActorUrl, GROUP_ACTOR_URL, `${GROUP_ACTOR_URL}#main-key`);

        const postRequests = mockTransport.requests.filter(r => r.url === targetInbox && r.method === "POST");
        assert.equal(postRequests.length, 1);
        const sentBody = JSON.parse(postRequests[0].body);
        assert.equal(sentBody.type, "Follow");
        assert.equal(sentBody.actor, GROUP_ACTOR_URL);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Full round-trip: commit → activity → deliver → inbound → link
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Full round-trip", () => {
    beforeEach(() => initAllAdapters());

    it("round-trips a link through AP federation", () => {
        // 1. Create a link
        const originalLink = makeLinkExpression();

        // 2. Translate to AP activity (outbound)
        const activities = diffToActivities(
            { additions: [originalLink], removals: [] },
            {
                groupActorUrl: GROUP_ACTOR_URL,
                actorUrl: ACTOR_URL,
                settings: DEFAULT_SETTINGS,
                hashFn: simpleHash,
            },
        );
        assert.equal(activities.length, 1);
        const activity = activities[0];
        assert.equal(activity.type, "Create");

        // 3. The activity carries the ad4m:Link tag for lossless round-trip
        const obj = activity.object as APObject;
        const ad4mTag = obj.tag?.find((t): t is APLinkTag => t.type === "ad4m:Link");
        assert.ok(ad4mTag, "Activity should carry ad4m:Link tag");
        assert.equal(ad4mTag!["ad4m:source"], "literal://hello");
        assert.equal(ad4mTag!["ad4m:predicate"], "sioc://content_of");
        assert.equal(ad4mTag!["ad4m:target"], "literal://world");

        // 4. Translate the activity back to a link (inbound)
        const inboundLink = inboundActivityToLink(activity, NEIGHBOURHOOD_URL);
        assert.ok(inboundLink, "Inbound translation should produce a link");

        // 5. Verify the round-trip preserved the link triple
        assert.equal(inboundLink!.data.source, originalLink.data.source);
        assert.equal(inboundLink!.data.predicate, originalLink.data.predicate);
        assert.equal(inboundLink!.data.target, originalLink.data.target);
        assert.equal(inboundLink!.proof.signature, originalLink.proof.signature);
    });

    it("round-trips a chat message with rich rendering", () => {
        // 1. Create a chat link
        const chatLink = makeChatLink(42);

        // 2. Translate to AP activity with resolved content
        const resolvedContent = new Map([["expr://msg-042", "Hello from AD4M chat!"]]);
        const activities = diffToActivities(
            { additions: [chatLink], removals: [] },
            {
                groupActorUrl: GROUP_ACTOR_URL,
                actorUrl: ACTOR_URL,
                settings: DEFAULT_SETTINGS,
                hashFn: simpleHash,
                resolvedContent,
            },
        );
        assert.equal(activities.length, 1);
        const activity = activities[0];

        // 3. Verify the Note content is the resolved message
        const obj = activity.object as APObject;
        assert.equal(obj.content, "Hello from AD4M chat!");

        // 4. The ad4m:Link tag preserves the original link for round-trip
        const ad4mTag = obj.tag?.find((t): t is APLinkTag => t.type === "ad4m:Link");
        assert.ok(ad4mTag);
        assert.equal(ad4mTag!["ad4m:source"], "channel://main");
        assert.equal(ad4mTag!["ad4m:predicate"], "flux://has_message");

        // 5. Inbound: reconstruct the native link from the tag
        const inboundLink = inboundActivityToLink(activity, NEIGHBOURHOOD_URL);
        assert.ok(inboundLink);
        assert.equal(inboundLink!.data.source, "channel://main");
        assert.equal(inboundLink!.data.predicate, "flux://has_message");
        assert.equal(inboundLink!.data.target, "expr://msg-042");
    });

    it("handles Delete round-trip", () => {
        // 1. Create and store a link
        const link = makeLinkExpression();
        store.putLink(link);

        // 2. Translate removal to Delete activity
        const activities = diffToActivities(
            { additions: [], removals: [link] },
            {
                groupActorUrl: GROUP_ACTOR_URL,
                actorUrl: ACTOR_URL,
                settings: DEFAULT_SETTINGS,
                hashFn: simpleHash,
            },
        );
        assert.equal(activities.length, 1);
        assert.equal(activities[0].type, "Delete");

        // 3. Inbound: translate Delete back to removal link. The inbound
        //    removal reconstructs the external-note link (source = neighbourhood,
        //    predicate = "ap://external-note", target = deleted object id) so it
        //    can actually cancel a real link. The old "ap://deleted" placeholder
        //    predicate could never match anything and is gone.
        const removalLink = inboundActivityToLink(activities[0], NEIGHBOURHOOD_URL);
        assert.ok(removalLink);
        assert.equal(removalLink!.data.predicate, "ap://external-note");
        assert.notEqual(removalLink!.data.predicate, "ap://deleted");
    });

    it("full pipeline: commit → deliver → sync → verify equivalence", async () => {
        // 1. Create links locally
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "channel://general", target: "expr://msg-100", predicate: "flux://has_message" },
            timestamp: "2026-05-02T01:00:00.000Z",
        });
        const diff: PerspectiveDiff = { additions: [link1, link2], removals: [] };
        store.applyDiff(diff);

        // 2. Generate AP activities
        const resolvedContent = new Map([["expr://msg-100", "General chat message"]]);
        const activities = diffToActivities(diff, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
            resolvedContent,
        });
        assert.equal(activities.length, 2);

        // 3. Mock: remote outbox serves these activities
        const collection: APCollection = {
            "@context": apContext(),
            type: "OrderedCollection",
            id: GROUP_OUTBOX_URL,
            totalItems: activities.length,
            orderedItems: activities,
        };
        mockTransport.addResponse(GROUP_OUTBOX_URL, {
            status: 200,
            headers: {},
            body: JSON.stringify(collection),
        });

        // 4. Create a fresh store to simulate a different node
        const freshStorage = new MockStorageAdapter();
        initStorage(freshStorage);
        store.initStore(simpleHash);

        // 5. Sync from outbox on the "remote" node
        const syncDiff = await syncFromOutbox(GROUP_OUTBOX_URL, NEIGHBOURHOOD_URL);

        // 6. Verify the synced links reconstruct the original data
        assert.equal(syncDiff.additions.length, 2);

        // The semantic link round-trips via ad4m:Link tag
        const semanticLink = syncDiff.additions.find(l => l.data.source === "literal://hello");
        assert.ok(semanticLink, "Semantic link should round-trip");
        assert.equal(semanticLink!.data.predicate, "sioc://content_of");
        assert.equal(semanticLink!.data.target, "literal://world");

        // The chat link also round-trips via ad4m:Link tag
        const chatLink = syncDiff.additions.find(l => l.data.source === "channel://general");
        assert.ok(chatLink, "Chat link should round-trip");
        assert.equal(chatLink!.data.predicate, "flux://has_message");
        assert.equal(chatLink!.data.target, "expr://msg-100");
    });

    it("processInboundActivities stores links and returns diff", () => {
        const activities: APActivity[] = [
            makeAPCreateNote("rt-1", "https://remote.example.com/users/alice", "Round-trip test"),
            makeAPCreateNote("rt-2", "https://remote.example.com/users/bob", "Another message"),
        ];

        const diff = processInboundActivities(activities, NEIGHBOURHOOD_URL);

        assert.equal(diff.additions.length, 2);
        assert.equal(diff.removals.length, 0);

        // Links should be in the store
        const allLinks = store.allLinks();
        assert.equal(allLinks.links.length, 2);
    });

    it("inbound reply creates multiple links", () => {
        const activity = makeAPCreateNote(
            "reply-1",
            "https://remote.example.com/users/carol",
            "This is a reply",
            {
                inReplyTo: "https://remote.example.com/objects/parent-1",
            },
        );

        const links = inboundActivityToLinks(activity, NEIGHBOURHOOD_URL, GROUP_ACTOR_URL);

        // Should produce primary link + reply link
        assert.ok(links.length >= 2);
        const replyLink = links.find(l => l.data.predicate === "flux://has_reply");
        assert.ok(replyLink);
        assert.equal(replyLink!.data.source, "https://remote.example.com/objects/parent-1");
    });
});
