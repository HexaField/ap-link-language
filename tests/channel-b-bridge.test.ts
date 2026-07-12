/**
 * Channel-B bridge orchestration — the protocol-agnostic glue that every
 * plain-text link language copies verbatim: `toAuthoredLink`,
 * `projectInstances` (AD4M graph → native payloads), `ingestNative`
 * (native payload → authoritative links), and the `defaultFluxMessageProfile`
 * fallback. Exercised over the ActivityPub adapter (AS2 Note).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    toAuthoredLink,
    projectInstances,
    ingestNative,
    defaultFluxMessageProfile,
    encodeLiteral,
    type AuthoredLink,
    type NativeAdapter,
    type ProjectionProfile,
} from "../src/projection/index.js";
import { makeActivityPubAdapter, apNoteBase, AP_NOTE_TYPE } from "../src/activitypub-projection.js";
import type { APObject } from "../src/activitypub.js";

// The AP adapter, keyed by the native type a profile asks for.
const adapterFor = (nativeType: string): NativeAdapter<APObject> => makeActivityPubAdapter(nativeType);

// The Flux fallback profile: `base --flux://entry_type--> flux://has_message`
// (flag) + `base --flux://body--> literal:string:<text>` (content), projecting
// the body into the Note's `content` field.
const fluxProfile = defaultFluxMessageProfile(AP_NOTE_TYPE, "content");

function fluxMessage(base: string, text: string, author = "did:key:alice"): AuthoredLink[] {
    return [
        {
            author,
            timestamp: "2026-07-12T10:00:00.000Z",
            data: { source: base, predicate: "flux://entry_type", target: "flux://has_message" },
        },
        {
            author,
            timestamp: "2026-07-12T10:00:01.000Z",
            data: { source: base, predicate: "flux://body", target: encodeLiteral(text) },
        },
    ];
}

// ---------------------------------------------------------------------------
// toAuthoredLink
// ---------------------------------------------------------------------------

describe("toAuthoredLink", () => {
    it("maps a full LinkExpression to an AuthoredLink", () => {
        const authored = toAuthoredLink({
            author: "did:key:alice",
            timestamp: "2026-07-12T10:00:00.000Z",
            data: { source: "a://s", predicate: "a://p", target: "a://t" },
        });
        assert.deepEqual(authored, {
            author: "did:key:alice",
            timestamp: "2026-07-12T10:00:00.000Z",
            data: { source: "a://s", predicate: "a://p", target: "a://t" },
        });
    });

    it("defaults missing triple parts to empty strings and preserves absent envelope", () => {
        const authored = toAuthoredLink({ data: {} });
        assert.equal(authored.author, undefined);
        assert.equal(authored.timestamp, undefined);
        assert.deepEqual(authored.data, { source: "", predicate: "", target: "" });
    });
});

// ---------------------------------------------------------------------------
// projectInstances — AD4M graph → native payloads
// ---------------------------------------------------------------------------

describe("projectInstances", () => {
    it("folds a matched instance into a native Note with envelope metadata", () => {
        const projected = projectInstances(fluxMessage("flux://msg1", "Hello world"), [fluxProfile], adapterFor);
        assert.equal(projected.length, 1);
        const [p] = projected;
        assert.equal(p.base, "flux://msg1");
        assert.equal(p.author, "did:key:alice");
        assert.equal(p.timestamp, "2026-07-12T10:00:00.000Z"); // earliest constituent link
        assert.equal(p.native.type, AP_NOTE_TYPE);
        assert.equal(p.native.content, "Hello world");
        // A clean native payload — no DAG bytes leak into human content.
        assert.equal("ad4m" in p.native, false);
        assert.equal("tag" in p.native, false);
    });

    it("projects multiple distinct instances", () => {
        const additions = [...fluxMessage("flux://msg1", "one"), ...fluxMessage("flux://msg2", "two")];
        const projected = projectInstances(additions, [fluxProfile], adapterFor);
        assert.deepEqual(
            projected.map((p) => p.native.content).sort(),
            ["one", "two"],
        );
    });

    it("projects each base at most once across overlapping profiles (first profile wins)", () => {
        // Two profiles matching the same flag; the first should claim the base.
        const primary = defaultFluxMessageProfile(AP_NOTE_TYPE, "content");
        const shadow: ProjectionProfile = { ...defaultFluxMessageProfile("Article", "content") };
        const projected = projectInstances(fluxMessage("flux://msg1", "hi"), [primary, shadow], adapterFor);
        assert.equal(projected.length, 1);
        assert.equal(projected[0].native.type, AP_NOTE_TYPE); // first profile's native type
    });

    it("emits nothing for additions whose flags never match", () => {
        const orphan: AuthoredLink[] = [
            {
                author: "did:key:bob",
                timestamp: "2026-07-12T11:00:00.000Z",
                data: { source: "flux://other", predicate: "flux://body", target: encodeLiteral("orphan") },
            },
        ];
        assert.deepEqual(projectInstances(orphan, [fluxProfile], adapterFor), []);
    });
});

// ---------------------------------------------------------------------------
// ingestNative — native payload → authoritative links
// ---------------------------------------------------------------------------

describe("ingestNative", () => {
    const nativeNote: APObject = {
        type: AP_NOTE_TYPE,
        id: "https://mastodon.social/users/bob/statuses/1",
        attributedTo: "https://mastodon.social/users/bob",
        published: "2026-07-12T10:00:00.000Z",
        content: "native hello",
    };

    it("reverses a native Note into the links that constitute the instance", () => {
        const ingested = ingestNative(nativeNote, [fluxProfile], adapterFor);
        assert.ok(ingested);
        assert.equal(ingested!.base, apNoteBase("https://mastodon.social/users/bob/statuses/1"));
        assert.equal(ingested!.author, "https://mastodon.social/users/bob");
        assert.equal(ingested!.timestamp, "2026-07-12T10:00:00.000Z");
        const triples = new Set(ingested!.links.map((l) => `${l.source}|${l.predicate}|${l.target}`));
        assert.deepEqual(triples, new Set([
            `${apNoteBase("https://mastodon.social/users/bob/statuses/1")}|flux://entry_type|flux://has_message`,
            `${apNoteBase("https://mastodon.social/users/bob/statuses/1")}|flux://body|${encodeLiteral("native hello")}`,
        ]));
    });

    it("returns null when no adapter recognises the payload", () => {
        const like: APObject = { type: "Like", id: "https://m.social/act/1" };
        assert.equal(ingestNative(like, [fluxProfile], adapterFor), null);
    });

    it("returns null when the payload carries no id to anchor a base on", () => {
        const anonymous: APObject = { type: AP_NOTE_TYPE, id: "", content: "x" };
        assert.equal(ingestNative(anonymous, [fluxProfile], adapterFor), null);
    });

    it("parents the ingested instance under a container when requested (default predicate)", () => {
        const ingested = ingestNative(nativeNote, [fluxProfile], adapterFor, { container: "flux://channel/general" });
        assert.ok(ingested);
        const containerLink = ingested!.links.find((l) => l.predicate === "ad4m://has_child");
        assert.deepEqual(containerLink, {
            source: "flux://channel/general",
            predicate: "ad4m://has_child",
            target: apNoteBase("https://mastodon.social/users/bob/statuses/1"),
        });
    });

    it("honours a custom container predicate", () => {
        const ingested = ingestNative(nativeNote, [fluxProfile], adapterFor, {
            container: "flux://channel/general",
            containerPredicate: "flux://has_message",
        });
        assert.ok(ingested!.links.some(
            (l) => l.predicate === "flux://has_message" && l.source === "flux://channel/general",
        ));
    });
});

// ---------------------------------------------------------------------------
// defaultFluxMessageProfile
// ---------------------------------------------------------------------------

describe("defaultFluxMessageProfile", () => {
    it("returns the documented Flux message shape", () => {
        const p = defaultFluxMessageProfile(AP_NOTE_TYPE, "content");
        assert.equal(p.nodeShapeUri, "flux://MessageShape");
        assert.equal(p.targetClass, "flux://Message");
        assert.equal(p.nativeType, AP_NOTE_TYPE);
        assert.deepEqual(p.flags, [{ path: "flux://entry_type", value: "flux://has_message" }]);
        assert.equal(p.fields.length, 1);
        assert.equal(p.fields[0].nativeField, "content");
        assert.equal(p.fields[0].path, "flux://body");
        assert.equal(p.fields[0].datatype, "http://www.w3.org/2001/XMLSchema#string");
    });

    it("honours a custom native content field", () => {
        const p = defaultFluxMessageProfile(AP_NOTE_TYPE, "text");
        assert.equal(p.fields[0].nativeField, "text");
    });
});
