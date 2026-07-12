/**
 * Unit tests for the link ↔ activity translation layer.
 *
 * Tests the pure translation functions without requiring ad4m:host
 * runtime imports — all dependencies are injected or mocked via
 * simple function signatures.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    linkToActivity,
    removalToActivity,
    diffToActivities,
    activityToLink,
    deleteActivityToRemoval,
    likeActivityToLink,
    announceActivityToLink,
    inboundActivityToLink,
    inboundActivityToLinks,
    linkToRichActivity,
    linkContentKey,
    toISO,
} from "../src/translate.js";

import type { LinkExpression, PerspectiveDiff } from "../src/types.js";
import type { APActivity, APObject, APLinkTag, APTag } from "../src/activitypub.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import type { APLanguageSettings } from "../src/settings.js";
import type { DetectedPattern } from "../src/translate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GROUP_ACTOR_URL = "https://example.com/ap/v1/groups/test-group";
const ACTOR_URL = "https://example.com/ap/v1/users/alice";

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

function makeChatLink(): LinkExpression {
    return makeLinkExpression({
        data: {
            source: "channel://main",
            target: "expr://msg-001",
            predicate: "flux://has_message",
        },
    });
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

// ---------------------------------------------------------------------------
// linkToActivity
// ---------------------------------------------------------------------------

describe("linkToActivity", () => {
    it("produces a Create{Note} with ad4m:Link tag for semantic strategy", () => {
        const link = makeLinkExpression();
        const activity = linkToActivity(link, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "hash123",
            settings: {
                ...DEFAULT_SETTINGS,
                rendering: { ...DEFAULT_SETTINGS.rendering, strategy: "semantic" },
            },
        });

        assert.equal(activity.type, "Create");
        assert.equal(activity.actor, ACTOR_URL);
        assert.ok(activity.id.includes("hash123"));
        assert.ok(Array.isArray(activity.to));
        assert.ok(activity.to![0].includes("/followers"));

        const obj = activity.object as APObject;
        assert.equal(obj.type, "Note");
        assert.equal(obj.attributedTo, ACTOR_URL);
        assert.ok(obj.content?.includes("literal://hello"));
        assert.ok(obj.content?.includes("sioc://content_of"));
        assert.ok(obj.content?.includes("literal://world"));
        assert.equal(obj.context, GROUP_ACTOR_URL);

        // ad4m:Link tag present
        const tag = obj.tag?.find((t): t is APLinkTag => t.type === "ad4m:Link");
        assert.ok(tag);
        assert.equal(tag!["ad4m:source"], "literal://hello");
        assert.equal(tag!["ad4m:predicate"], "sioc://content_of");
        assert.equal(tag!["ad4m:target"], "literal://world");
        assert.equal(tag!["ad4m:proof"], "abc123");
    });

    it("produces a chat-style Note when predicate matches chatPredicates and resolvedContent provided", () => {
        const link = makeChatLink();
        const activity = linkToActivity(link, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "chathash",
            settings: DEFAULT_SETTINGS, // strategy: "auto"
            resolvedContent: "Hey everyone, meeting at 3pm!",
        });

        const obj = activity.object as APObject;
        assert.equal(obj.content, "Hey everyone, meeting at 3pm!");
        // ad4m:Link tag should still be present (includeAd4mTags: true)
        const tag = obj.tag?.find((t): t is APLinkTag => t.type === "ad4m:Link");
        assert.ok(tag);
    });

    it("falls back to semantic when auto and no resolved content", () => {
        const link = makeChatLink();
        const activity = linkToActivity(link, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "fallback",
            settings: DEFAULT_SETTINGS, // strategy: "auto"
            // no resolvedContent
        });

        const obj = activity.object as APObject;
        // Should contain HTML with the triple, not just the target
        assert.ok(obj.content?.includes("channel://main"));
    });

    it("raw strategy emits a 🔗 triple", () => {
        const link = makeLinkExpression();
        const activity = linkToActivity(link, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "rawhash",
            settings: {
                ...DEFAULT_SETTINGS,
                rendering: { ...DEFAULT_SETTINGS.rendering, strategy: "raw" },
            },
        });

        const obj = activity.object as APObject;
        assert.ok(obj.content?.includes("🔗"));
    });

    it("omits ad4m:Link tag when includeAd4mTags is false in chat mode", () => {
        const link = makeChatLink();
        const activity = linkToActivity(link, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "notags",
            settings: {
                ...DEFAULT_SETTINGS,
                rendering: {
                    ...DEFAULT_SETTINGS.rendering,
                    strategy: "chat",
                    includeAd4mTags: false,
                },
            },
            resolvedContent: "Hello!",
        });

        const obj = activity.object as APObject;
        assert.equal(obj.tag?.length ?? 0, 0);
    });
});

// ---------------------------------------------------------------------------
// removalToActivity
// ---------------------------------------------------------------------------

describe("removalToActivity", () => {
    it("produces a Delete activity", () => {
        const link = makeLinkExpression();
        const activity = removalToActivity(link, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "delhash",
        });

        assert.equal(activity.type, "Delete");
        assert.equal(activity.actor, ACTOR_URL);
        assert.ok(activity.id.includes("del-delhash"));
        assert.equal(typeof activity.object, "string");
        assert.ok((activity.object as string).includes("delhash"));
    });
});

// ---------------------------------------------------------------------------
// diffToActivities
// ---------------------------------------------------------------------------

describe("diffToActivities", () => {
    it("converts additions and removals to corresponding activities", () => {
        const addition = makeLinkExpression();
        const removal = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "c" },
        });

        const diff: PerspectiveDiff = {
            additions: [addition],
            removals: [removal],
        };

        const activities = diffToActivities(diff, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
        });

        assert.equal(activities.length, 2);
        assert.equal(activities[0].type, "Create");
        assert.equal(activities[1].type, "Delete");
    });

    it("handles empty diff", () => {
        const diff: PerspectiveDiff = { additions: [], removals: [] };
        const activities = diffToActivities(diff, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
        });
        assert.equal(activities.length, 0);
    });

    it("uses resolvedContent map when provided", () => {
        const link = makeChatLink();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };
        const resolvedContent = new Map([["expr://msg-001", "Resolved message!"]]);

        const activities = diffToActivities(diff, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
            resolvedContent,
        });

        const obj = activities[0].object as APObject;
        assert.equal(obj.content, "Resolved message!");
    });
});

// ---------------------------------------------------------------------------
// activityToLink (Inbound)
// ---------------------------------------------------------------------------

describe("activityToLink", () => {
    const NEIGHBOURHOOD = "neighbourhood://test";

    it("reconstructs a native link from ad4m:Link tag", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Create",
            id: "https://example.com/activities/1",
            actor: "https://mastodon.social/users/alice",
            published: "2026-05-02T00:00:00Z",
            object: {
                type: "Note",
                id: "https://example.com/objects/1",
                content: "Hello",
                tag: [
                    {
                        type: "ad4m:Link",
                        "ad4m:source": "literal://hello",
                        "ad4m:predicate": "sioc://content_of",
                        "ad4m:target": "literal://world",
                        "ad4m:proof": "sig123",
                    } as APLinkTag,
                ],
            },
        };

        const link = activityToLink(activity, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.source, "literal://hello");
        assert.equal(link!.data.predicate, "sioc://content_of");
        assert.equal(link!.data.target, "literal://world");
        assert.equal(link!.proof.signature, "sig123");
        assert.equal(link!.author, "ap:https://mastodon.social/users/alice");
    });

    it("creates synthetic link for plain AP Note", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Create",
            id: "https://example.com/activities/2",
            actor: "https://mastodon.social/users/bob",
            published: "2026-05-02T12:00:00Z",
            object: {
                type: "Note",
                id: "https://example.com/objects/2",
                content: "Just a regular toot",
            },
        };

        const link = activityToLink(activity, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.source, NEIGHBOURHOOD);
        assert.equal(link!.data.predicate, "ap://external-note");
        assert.equal(link!.data.target, "https://example.com/objects/2");
        assert.equal(link!.author, "ap:https://mastodon.social/users/bob");
    });

    it("returns null for non-Create activities", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Like",
            id: "https://example.com/activities/3",
            actor: "https://mastodon.social/users/bob",
            published: "2026-05-02T12:00:00Z",
            object: "https://example.com/objects/1",
        };
        assert.equal(activityToLink(activity, NEIGHBOURHOOD), null);
    });

    it("returns null for string object (tombstone)", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Create",
            id: "https://example.com/activities/4",
            actor: "https://example.com/users/bob",
            published: "2026-05-02T12:00:00Z",
            object: "https://example.com/objects/4",
        };
        assert.equal(activityToLink(activity, NEIGHBOURHOOD), null);
    });
});

// ---------------------------------------------------------------------------
// deleteActivityToRemoval
// ---------------------------------------------------------------------------

describe("deleteActivityToRemoval", () => {
    const NEIGHBOURHOOD = "neighbourhood://test";

    it("creates a removal link from Delete activity", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Delete",
            id: "https://example.com/activities/del-1",
            actor: "https://mastodon.social/users/alice",
            published: "2026-05-02T01:00:00Z",
            object: "https://example.com/objects/1",
        };

        const link = deleteActivityToRemoval(activity, NEIGHBOURHOOD);
        assert.ok(link);
        // REGRESSION (ap://deleted bug): the removal MUST reconstruct the exact
        // link the original Create{Note} produced — source = neighbourhood,
        // predicate = "ap://external-note", target = the deleted object id.
        // The old code emitted predicate "ap://deleted", a placeholder that
        // could never match any real link, so external Deletes never took
        // effect. Assert the removal is triple-identical to the original add.
        assert.equal(link!.data.source, NEIGHBOURHOOD);
        assert.equal(link!.data.predicate, "ap://external-note");
        assert.equal(link!.data.target, "https://example.com/objects/1");
        assert.notEqual(link!.data.predicate, "ap://deleted");
    });

    it("removal is triple-identical to the add it must cancel", () => {
        // The Create{Note} → activityToLink and Delete → deleteActivityToRemoval
        // must yield the SAME (source, predicate, target) so the removal cancels
        // the add. This is what store.removeExternalLink matches on.
        const objectId = "https://example.com/objects/round-trip";
        const create: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Create",
            id: "https://example.com/activities/create-rt",
            actor: "https://mastodon.social/users/alice",
            published: "2026-05-02T01:00:00Z",
            object: { type: "Note", id: objectId, content: "hello" },
        };
        const del: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Delete",
            id: "https://example.com/activities/del-rt",
            actor: "https://mastodon.social/users/alice",
            published: "2026-05-02T02:00:00Z",
            object: objectId,
        };

        const add = activityToLink(create, NEIGHBOURHOOD);
        const removal = deleteActivityToRemoval(del, NEIGHBOURHOOD);
        assert.ok(add);
        assert.ok(removal);
        assert.equal(removal!.data.source, add!.data.source);
        assert.equal(removal!.data.predicate, add!.data.predicate);
        assert.equal(removal!.data.target, add!.data.target);
    });

    it("handles object as APObject", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Delete",
            id: "https://example.com/activities/del-2",
            actor: "https://example.com/users/bob",
            published: "2026-05-02T02:00:00Z",
            object: {
                type: "Note",
                id: "https://example.com/objects/2",
            },
        };

        const link = deleteActivityToRemoval(activity, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.target, "https://example.com/objects/2");
    });

    it("returns null for non-Delete activities", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Create",
            id: "https://example.com/activities/1",
            actor: "https://example.com/users/bob",
            published: "2026-05-02T00:00:00Z",
            object: { type: "Note", id: "https://example.com/objects/1" },
        };
        assert.equal(deleteActivityToRemoval(activity, NEIGHBOURHOOD), null);
    });
});

// ---------------------------------------------------------------------------
// likeActivityToLink
// ---------------------------------------------------------------------------

describe("likeActivityToLink", () => {
    it("creates a liked-by link", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Like",
            id: "https://example.com/activities/like-1",
            actor: "https://mastodon.social/users/carol",
            published: "2026-05-02T03:00:00Z",
            object: "https://example.com/objects/1",
        };

        const link = likeActivityToLink(activity);
        assert.ok(link);
        assert.equal(link!.data.source, "https://example.com/objects/1");
        assert.equal(link!.data.predicate, "ap://liked-by");
        assert.equal(link!.data.target, "https://mastodon.social/users/carol");
    });
});

// ---------------------------------------------------------------------------
// announceActivityToLink
// ---------------------------------------------------------------------------

describe("announceActivityToLink", () => {
    it("creates an announced-by link", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Announce",
            id: "https://example.com/activities/boost-1",
            actor: "https://mastodon.social/users/dave",
            published: "2026-05-02T04:00:00Z",
            object: "https://example.com/objects/1",
        };

        const link = announceActivityToLink(activity);
        assert.ok(link);
        assert.equal(link!.data.source, "https://example.com/objects/1");
        assert.equal(link!.data.predicate, "ap://announced-by");
        assert.equal(link!.data.target, "https://mastodon.social/users/dave");
    });
});

// ---------------------------------------------------------------------------
// inboundActivityToLink (dispatcher)
// ---------------------------------------------------------------------------

describe("inboundActivityToLink", () => {
    const NEIGHBOURHOOD = "neighbourhood://test";

    it("routes Create to activityToLink", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Create",
            id: "https://example.com/activities/1",
            actor: "https://example.com/users/alice",
            published: "2026-05-02T00:00:00Z",
            object: {
                type: "Note",
                id: "https://example.com/objects/1",
                content: "Hello",
            },
        };
        const link = inboundActivityToLink(activity, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.predicate, "ap://external-note");
    });

    it("routes Delete to deleteActivityToRemoval", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Delete",
            id: "https://example.com/activities/del-1",
            actor: "https://example.com/users/alice",
            published: "2026-05-02T00:00:00Z",
            object: "https://example.com/objects/1",
        };
        const link = inboundActivityToLink(activity, NEIGHBOURHOOD);
        assert.ok(link);
        // Delete reconstructs the original external-note link (see the
        // ap://deleted regression above), it is NOT a bogus "deleted" marker.
        assert.equal(link!.data.predicate, "ap://external-note");
    });

    it("routes Like to likeActivityToLink", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Like",
            id: "https://example.com/activities/like-1",
            actor: "https://example.com/users/bob",
            published: "2026-05-02T00:00:00Z",
            object: "https://example.com/objects/1",
        };
        const link = inboundActivityToLink(activity, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.predicate, "ap://liked-by");
    });

    it("routes Announce to announceActivityToLink", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Announce",
            id: "https://example.com/activities/boost-1",
            actor: "https://example.com/users/carol",
            published: "2026-05-02T00:00:00Z",
            object: "https://example.com/objects/1",
        };
        const link = inboundActivityToLink(activity, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.predicate, "ap://announced-by");
    });

    it("returns null for unsupported activity types", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Follow",
            id: "https://example.com/activities/follow-1",
            actor: "https://example.com/users/alice",
            published: "2026-05-02T00:00:00Z",
            object: "https://example.com/users/bob",
        };
        assert.equal(inboundActivityToLink(activity, NEIGHBOURHOOD), null);
    });
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe("toISO", () => {
    it("converts an ISO string passthrough", () => {
        const result = toISO("2026-05-02T00:00:00.000Z");
        assert.equal(result, "2026-05-02T00:00:00.000Z");
    });

    it("converts epoch ms to ISO", () => {
        const result = toISO(1746144000000); // 2025-05-02T00:00:00Z
        assert.ok(result.includes("2025-05-0"));
    });
});

describe("linkContentKey", () => {
    it("produces a deterministic key", () => {
        const link = makeLinkExpression();
        const key1 = linkContentKey(link);
        const key2 = linkContentKey(link);
        assert.equal(key1, key2);
    });

    it("differs for different links", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "c" },
        });
        assert.notEqual(linkContentKey(link1), linkContentKey(link2));
    });
});

// ---------------------------------------------------------------------------
// linkToRichActivity (Outbound — Pattern-Aware)
// ---------------------------------------------------------------------------

describe("linkToRichActivity", () => {
    it("renders chat-message pattern as Create{Note} with content", () => {
        const link = makeChatLink();
        const pattern: DetectedPattern = {
            type: "chat-message",
            contentUri: "expr://msg-001",
            channelUri: "channel://main",
        };
        const activity = linkToRichActivity(link, pattern, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "rich-chat-hash",
            settings: DEFAULT_SETTINGS,
            resolvedContent: "Hey everyone, meeting at 3pm!",
        });

        assert.equal(activity.type, "Create");
        const obj = activity.object as APObject;
        assert.equal(obj.type, "Note");
        assert.equal(obj.content, "Hey everyone, meeting at 3pm!");
        assert.equal(obj.context, GROUP_ACTOR_URL);
        // ad4m:Link tag present
        const tag = obj.tag?.find((t): t is APLinkTag => t.type === "ad4m:Link");
        assert.ok(tag);
    });

    it("renders chat-message without resolvedContent using escaped target", () => {
        const link = makeChatLink();
        const pattern: DetectedPattern = {
            type: "chat-message",
            contentUri: "expr://msg-001",
            channelUri: "channel://main",
        };
        const activity = linkToRichActivity(link, pattern, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "no-content-hash",
            settings: DEFAULT_SETTINGS,
        });

        const obj = activity.object as APObject;
        assert.equal(obj.content, "expr://msg-001");
    });

    it("renders reply pattern with inReplyTo", () => {
        const link = makeLinkExpression({
            data: {
                source: "expr://parent-msg",
                target: "expr://reply-msg",
                predicate: "flux://has_reply",
            },
        });
        const pattern: DetectedPattern = {
            type: "reply",
            contentUri: "expr://reply-msg",
            parentUri: "expr://parent-msg",
        };
        const activity = linkToRichActivity(link, pattern, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "reply-hash",
            settings: DEFAULT_SETTINGS,
            resolvedContent: "I agree!",
            parentApObjectUrl: `${GROUP_ACTOR_URL}/objects/parent-obj-123`,
        });

        assert.equal(activity.type, "Create");
        const obj = activity.object as APObject;
        assert.equal(obj.content, "I agree!");
        assert.equal(obj.inReplyTo, `${GROUP_ACTOR_URL}/objects/parent-obj-123`);
    });

    it("renders reply without parentApObjectUrl (no inReplyTo set)", () => {
        const link = makeLinkExpression({
            data: {
                source: "expr://parent",
                target: "expr://reply",
                predicate: "flux://has_reply",
            },
        });
        const pattern: DetectedPattern = {
            type: "reply",
            contentUri: "expr://reply",
            parentUri: "expr://parent",
        };
        const activity = linkToRichActivity(link, pattern, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "reply-no-parent",
            settings: DEFAULT_SETTINGS,
            resolvedContent: "Reply text",
        });

        const obj = activity.object as APObject;
        assert.equal(obj.inReplyTo, undefined);
    });

    it("renders mention pattern with Mention tag", () => {
        const link = makeLinkExpression({
            data: {
                source: "expr://msg",
                target: "did:key:z6MkAlice",
                predicate: "flux://has_mention",
            },
        });
        const pattern: DetectedPattern = {
            type: "mention",
            mentionedAgent: "did:key:z6MkAlice",
        };
        const activity = linkToRichActivity(link, pattern, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "mention-hash",
            settings: DEFAULT_SETTINGS,
            mentionActorUrl: "https://example.com/ap/v1/users/alice",
            mentionHandle: "@alice",
        });

        assert.equal(activity.type, "Create");
        const obj = activity.object as APObject;
        const mentionTag = obj.tag?.find((t: APTag) => t.type === "Mention");
        assert.ok(mentionTag);
        assert.equal(mentionTag!.href, "https://example.com/ap/v1/users/alice");
        assert.equal(mentionTag!.name, "@alice");
    });

    it("renders mention without mentionActorUrl (no Mention tag)", () => {
        const link = makeLinkExpression({
            data: {
                source: "expr://msg",
                target: "did:key:z6MkBob",
                predicate: "flux://has_mention",
            },
        });
        const pattern: DetectedPattern = {
            type: "mention",
            mentionedAgent: "did:key:z6MkBob",
        };
        const activity = linkToRichActivity(link, pattern, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "mention-no-actor",
            settings: DEFAULT_SETTINGS,
        });

        const obj = activity.object as APObject;
        const mentionTag = obj.tag?.find((t: APTag) => t.type === "Mention");
        assert.equal(mentionTag, undefined);
    });

    it("renders reaction pattern as Like activity", () => {
        const link = makeLinkExpression({
            data: {
                source: "expr://msg",
                target: "👍",
                predicate: "flux://has_reaction",
            },
        });
        const pattern: DetectedPattern = {
            type: "reaction",
            contentUri: "👍",
        };
        const activity = linkToRichActivity(link, pattern, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "reaction-hash",
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
        });

        assert.equal(activity.type, "Like");
        assert.equal(activity.actor, ACTOR_URL);
        const obj = activity.object as APObject;
        assert.equal(obj.type, "Note");
    });

    it("falls back to linkToActivity for unknown patterns", () => {
        const link = makeLinkExpression();
        const pattern: DetectedPattern = { type: "unknown" };
        const activity = linkToRichActivity(link, pattern, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            linkHash: "fallback-hash",
            settings: {
                ...DEFAULT_SETTINGS,
                rendering: { ...DEFAULT_SETTINGS.rendering, strategy: "semantic" },
            },
        });

        assert.equal(activity.type, "Create");
        const obj = activity.object as APObject;
        // Semantic strategy includes triple rendering
        assert.ok(obj.content?.includes("literal://hello"));
    });
});

// ---------------------------------------------------------------------------
// diffToActivities — SDNA pattern integration
// ---------------------------------------------------------------------------

describe("diffToActivities with SDNA patterns", () => {
    it("uses rich rendering for chat-message links", () => {
        const link = makeChatLink();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };
        const resolvedContent = new Map([["expr://msg-001", "Hello world!"]]);

        const activities = diffToActivities(diff, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
            resolvedContent,
        });

        assert.equal(activities.length, 1);
        assert.equal(activities[0].type, "Create");
        const obj = activities[0].object as APObject;
        assert.equal(obj.content, "Hello world!");
        assert.equal(obj.context, GROUP_ACTOR_URL);
    });

    it("uses rich rendering for reaction links (Like activity)", () => {
        const link = makeLinkExpression({
            data: {
                source: "expr://msg",
                target: "❤️",
                predicate: "flux://has_reaction",
            },
        });
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const activities = diffToActivities(diff, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
        });

        assert.equal(activities.length, 1);
        assert.equal(activities[0].type, "Like");
    });

    it("uses standard rendering for unknown pattern links", () => {
        const link = makeLinkExpression({
            data: {
                source: "a",
                target: "b",
                predicate: "custom://unknown",
            },
        });
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const activities = diffToActivities(diff, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
        });

        assert.equal(activities.length, 1);
        assert.equal(activities[0].type, "Create");
    });

    it("respects shouldFederate filter", () => {
        const link = makeChatLink();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        // Filter out all links
        const activities = diffToActivities(diff, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
            shouldFederate: () => false,
        });

        assert.equal(activities.length, 0);
    });

    it("shouldFederate filter also applies to removals", () => {
        const link = makeLinkExpression();
        const diff: PerspectiveDiff = { additions: [], removals: [link] };

        const activities = diffToActivities(diff, {
            groupActorUrl: GROUP_ACTOR_URL,
            actorUrl: ACTOR_URL,
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
            shouldFederate: () => false,
        });

        assert.equal(activities.length, 0);
    });
});

// ---------------------------------------------------------------------------
// inboundActivityToLinks (Enhanced multi-link inbound)
// ---------------------------------------------------------------------------

describe("inboundActivityToLinks", () => {
    const NEIGHBOURHOOD = "neighbourhood://test";
    const GROUP_URL = "https://example.com/ap/v1/groups/test-group";

    it("returns primary link for simple Create{Note}", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Create",
            id: "https://example.com/activities/1",
            actor: "https://mastodon.social/users/alice",
            published: "2026-05-02T00:00:00Z",
            object: {
                type: "Note",
                id: "https://example.com/objects/1",
                content: "Hello",
            },
        };
        const links = inboundActivityToLinks(activity, NEIGHBOURHOOD);
        assert.equal(links.length, 1);
        assert.equal(links[0].data.predicate, "ap://external-note");
    });

    it("creates reply link for Note with inReplyTo", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Create",
            id: "https://example.com/activities/2",
            actor: "https://mastodon.social/users/bob",
            published: "2026-05-02T01:00:00Z",
            object: {
                type: "Note",
                id: "https://example.com/objects/2",
                content: "This is a reply",
                inReplyTo: "https://example.com/objects/1",
            },
        };
        const links = inboundActivityToLinks(activity, NEIGHBOURHOOD, GROUP_URL);
        assert.equal(links.length, 2); // primary + reply
        const replyLink = links.find(l => l.data.predicate === "flux://has_reply");
        assert.ok(replyLink);
        assert.equal(replyLink!.data.source, "https://example.com/objects/1");
        assert.equal(replyLink!.data.target, "https://example.com/objects/2");
    });

    it("creates mention links for Note with Mention tags", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Create",
            id: "https://example.com/activities/3",
            actor: "https://mastodon.social/users/carol",
            published: "2026-05-02T02:00:00Z",
            object: {
                type: "Note",
                id: "https://example.com/objects/3",
                content: "Hey @alice!",
                tag: [
                    {
                        type: "Mention",
                        href: "https://mastodon.social/users/alice",
                        name: "@alice",
                    },
                ],
            },
        };
        const links = inboundActivityToLinks(activity, NEIGHBOURHOOD, GROUP_URL);
        assert.equal(links.length, 2); // primary + mention
        const mentionLink = links.find(l => l.data.predicate === "flux://has_mention");
        assert.ok(mentionLink);
        assert.equal(mentionLink!.data.source, "https://example.com/objects/3");
        assert.equal(mentionLink!.data.target, "https://mastodon.social/users/alice");
    });

    it("creates both reply and mention links when Note has both", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Create",
            id: "https://example.com/activities/4",
            actor: "https://mastodon.social/users/dave",
            published: "2026-05-02T03:00:00Z",
            object: {
                type: "Note",
                id: "https://example.com/objects/4",
                content: "@alice I agree with you!",
                inReplyTo: "https://example.com/objects/1",
                tag: [
                    {
                        type: "Mention",
                        href: "https://mastodon.social/users/alice",
                        name: "@alice",
                    },
                ],
            },
        };
        const links = inboundActivityToLinks(activity, NEIGHBOURHOOD, GROUP_URL);
        assert.equal(links.length, 3); // primary + reply + mention
        assert.ok(links.find(l => l.data.predicate === "ap://external-note"));
        assert.ok(links.find(l => l.data.predicate === "flux://has_reply"));
        assert.ok(links.find(l => l.data.predicate === "flux://has_mention"));
    });

    it("handles Delete activity", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Delete",
            id: "https://example.com/activities/del-1",
            actor: "https://mastodon.social/users/alice",
            published: "2026-05-02T04:00:00Z",
            object: "https://example.com/objects/1",
        };
        const links = inboundActivityToLinks(activity, NEIGHBOURHOOD);
        assert.equal(links.length, 1);
        assert.equal(links[0].data.predicate, "ap://external-note");
    });

    it("handles Like activity", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Like",
            id: "https://example.com/activities/like-1",
            actor: "https://mastodon.social/users/alice",
            published: "2026-05-02T05:00:00Z",
            object: "https://example.com/objects/1",
        };
        const links = inboundActivityToLinks(activity, NEIGHBOURHOOD);
        assert.equal(links.length, 1);
        assert.equal(links[0].data.predicate, "ap://liked-by");
    });

    it("handles Announce activity", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Announce",
            id: "https://example.com/activities/boost-1",
            actor: "https://mastodon.social/users/alice",
            published: "2026-05-02T06:00:00Z",
            object: "https://example.com/objects/1",
        };
        const links = inboundActivityToLinks(activity, NEIGHBOURHOOD);
        assert.equal(links.length, 1);
        assert.equal(links[0].data.predicate, "ap://announced-by");
    });

    it("returns empty array for unsupported activity types", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Follow",
            id: "https://example.com/activities/follow-1",
            actor: "https://example.com/users/alice",
            published: "2026-05-02T00:00:00Z",
            object: "https://example.com/users/bob",
        };
        const links = inboundActivityToLinks(activity, NEIGHBOURHOOD);
        assert.equal(links.length, 0);
    });

    it("ignores non-Mention tags in Note", () => {
        const activity: APActivity = {
            "@context": ["https://www.w3.org/ns/activitystreams"],
            type: "Create",
            id: "https://example.com/activities/5",
            actor: "https://mastodon.social/users/alice",
            published: "2026-05-02T07:00:00Z",
            object: {
                type: "Note",
                id: "https://example.com/objects/5",
                content: "Hello #world",
                tag: [
                    {
                        type: "Hashtag",
                        href: "https://example.com/tags/world",
                        name: "#world",
                    },
                ],
            },
        };
        const links = inboundActivityToLinks(activity, NEIGHBOURHOOD, GROUP_URL);
        assert.equal(links.length, 1); // primary only, no mention link
    });
});
