/**
 * ActivityPub Channel-B adapter — the AP `NativeAdapter`.
 *
 * Maps the generic `Projection` produced by the SHACL transformer to/from a
 * real ActivityStreams `Note` that Mastodon and other Fediverse clients render.
 * This is the only AS2-schema-aware half: the SHACL profile decides which graph
 * property fills the Note's `content`; this adapter knows ActivityPub's object
 * shape.
 *
 * Crucially, `toNative` emits ONLY native AS2 fields — no `ad4m` envelope, no
 * link hashes, no `ad4m:Diff`/`ad4m:Link` tags. The authoritative link DAG rides
 * Channel A (the emulated diff-DAG carried inside `Create{Note}` activities, see
 * translate.ts / dag.ts). A Note produced here is indistinguishable from one an
 * ordinary Fediverse user posts, and is never read back to rebuild the DAG.
 *
 * The Note this adapter produces is the human-facing OBJECT. The language's
 * existing delivery path wraps it in a `Create` activity (see `apNoteToCreate`)
 * and signs + delivers it exactly like any other outbound activity.
 */

import type { APObject } from "./activitypub.js";
import type { NativeAdapter, Projection } from "./projection/index.js";

/** Native type constant — an ActivityStreams `Note`. */
export const AP_NOTE_TYPE = "Note";

/**
 * Base URI derived from a Note's `id`, for ingested native content.
 *
 * The Note id is already a globally-unique URI (e.g.
 * `https://mastodon.social/users/alice/statuses/123`). We namespace it under
 * `ap://note/` so an ingested subject base is visibly AP-sourced and never
 * collides with an AD4M-native base URI.
 */
export function apNoteBase(id: string): string {
    return `ap://note/${id}`;
}

/**
 * Build the AP adapter. `nativeType` defaults to `Note`; pass a different AS2
 * object type only if a profile projects to a custom object (e.g. `Article`).
 */
export function makeActivityPubAdapter(
    nativeType: string = AP_NOTE_TYPE,
): NativeAdapter<APObject> {
    return {
        toNative(projection: Projection): APObject {
            const content = projection.fields.content;
            if (content === undefined) {
                throw new Error(
                    "ActivityPub projection requires a `content` field — the SHACL " +
                        'profile must annotate the content property with projection://field "content".',
                );
            }

            // Emit ONLY native AS2 fields. No @context (the language stamps the
            // full context when it wraps the Note in a Create for delivery), no
            // ad4m envelope, no tags. `id`/`attributedTo`/`published` are set by
            // the outbound wiring, which knows the group base URL and actor.
            const note: APObject = {
                type: nativeType,
                id: "",
                content: String(content),
            };

            // A projection MAY carry an explicit summary (content warning / CW).
            const summary = projection.fields.summary;
            if (summary !== undefined) {
                note.summary = String(summary);
            }

            return note;
        },

        fromNative(note: APObject): Projection | null {
            if (!note || typeof note !== "object") return null;
            if (note.type !== nativeType) return null;
            const content = note.content;
            if (typeof content !== "string") return null;

            const fields: Record<string, string | number | boolean> = { content };
            if (typeof note.summary === "string") {
                fields.summary = note.summary;
            }

            return {
                nativeType,
                base: typeof note.id === "string" && note.id ? apNoteBase(note.id) : "",
                author: typeof note.attributedTo === "string" ? note.attributedTo : undefined,
                timestamp: typeof note.published === "string" ? note.published : undefined,
                fields,
            };
        },
    };
}
