/**
 * Channel-B bridge glue — protocol-agnostic outbound/inbound wiring.
 *
 * `projectInstances` folds a batch of committed link additions into native
 * payloads (AD4M graph → human content). `ingestNative` reverses it for
 * genuinely native-authored content (human content → links that enter Channel A
 * as new authoritative links). Both are thin compositions of the `projection/`
 * core over an injected `NativeAdapter`, so every plain-text link language wires
 * its own adapter + native type and shares this exact orchestration.
 *
 * The DAG stays authoritative: `projectInstances` never reads its output back,
 * and `ingestNative` is used ONLY for content with no backing link (native
 * users), producing links the language then publishes on Channel A.
 */

import { collectInstances, ingest, project } from "./project.js";
import { profileByNativeType } from "./profile.js";
import type {
    AuthoredLink,
    Link,
    NativeAdapter,
    Projection,
    ProjectionProfile,
} from "./types.js";

/** Adapt an AD4M `LinkExpression` (author/timestamp/data) to an `AuthoredLink`. */
export function toAuthoredLink(link: {
    author?: string;
    timestamp?: string;
    data: { source?: string; predicate?: string; target?: string };
}): AuthoredLink {
    return {
        author: link.author,
        timestamp: link.timestamp,
        data: {
            source: link.data.source ?? "",
            predicate: link.data.predicate ?? "",
            target: link.data.target ?? "",
        },
    };
}

/** One instance projected to a native payload, with its envelope metadata. */
export interface ProjectedNative<TNative> {
    /** Subject base URI of the projected instance. */
    base: string;
    author?: string;
    timestamp?: string;
    /** The exact native wire payload the language sends. */
    native: TNative;
}

/**
 * Fold committed link additions into native payloads — one per matched instance.
 *
 * `adapterFor` returns the adapter for a profile's native type (a language with a
 * single native type can ignore the argument). Each subject base is projected at
 * most once (first matching profile wins) so overlapping profiles never emit a
 * duplicate payload for the same instance.
 */
export function projectInstances<TNative>(
    additions: AuthoredLink[],
    profiles: ProjectionProfile[],
    adapterFor: (nativeType: string) => NativeAdapter<TNative>,
): ProjectedNative<TNative>[] {
    const out: ProjectedNative<TNative>[] = [];
    const seen = new Set<string>();
    for (const profile of profiles) {
        for (const instance of collectInstances(additions, profile)) {
            if (seen.has(instance.base)) continue;
            seen.add(instance.base);
            const projection: Projection = project(instance, profile);
            const native = adapterFor(profile.nativeType).toNative(projection);
            out.push({
                base: instance.base,
                author: instance.author || undefined,
                timestamp: instance.timestamp || undefined,
                native,
            });
        }
    }
    return out;
}

/** Options controlling how ingested content is attached to the graph. */
export interface IngestOptions {
    /**
     * Container base URI the ingested instance should be parented under (e.g. the
     * Flux channel the native conversation surface maps to). When set, a
     * `container --containerPredicate--> base` link is appended so the native
     * app's app-model (which expects a parent) renders the ingested instance.
     */
    container?: string;
    /** Parenting predicate (default `ad4m://has_child`). */
    containerPredicate?: string;
}

const DEFAULT_CONTAINER_PREDICATE = "ad4m://has_child";

/** An ingested native instance: its base, envelope, and constituent links. */
export interface IngestedInstance {
    base: string;
    author?: string;
    timestamp?: string;
    links: Link[];
}

/**
 * Reverse projection for genuinely native-authored content: native payload →
 * the links that constitute the subject instance (type flags + content fields),
 * optionally parented under a container. Returns `null` when no profile's adapter
 * recognises the payload, or when the payload carries no identity to anchor a
 * base URI on.
 */
export function ingestNative<TNative>(
    payload: TNative,
    profiles: ProjectionProfile[],
    adapterFor: (nativeType: string) => NativeAdapter<TNative>,
    opts: IngestOptions = {},
): IngestedInstance | null {
    const byType = profileByNativeType(profiles);
    for (const profile of profiles) {
        const projection = adapterFor(profile.nativeType).fromNative(payload);
        if (!projection) continue;
        if (!projection.base) return null; // no native id ⇒ nothing to anchor
        const matched = byType.get(projection.nativeType) ?? profile;
        const links = ingest(projection, matched, projection.base);
        if (opts.container) {
            links.push({
                source: opts.container,
                predicate: opts.containerPredicate ?? DEFAULT_CONTAINER_PREDICATE,
                target: projection.base,
            });
        }
        return {
            base: projection.base,
            author: projection.author,
            timestamp: projection.timestamp,
            links,
        };
    }
    return null;
}

/**
 * The default projection profile for a Flux chat message, for languages bridging
 * Flux before its SDNA carries explicit `projection://` annotations.
 *
 * Flux emits a message as: `msg --flux://entry_type--> flux://has_message` (the
 * type flag) and `msg --flux://body--> literal:string:<text>` (the content). The
 * body projects to the given native content field (default `body`).
 */
export function defaultFluxMessageProfile(
    nativeType: string,
    contentField: string = "body",
): ProjectionProfile {
    return {
        nodeShapeUri: "flux://MessageShape",
        targetClass: "flux://Message",
        nativeType,
        flags: [{ path: "flux://entry_type", value: "flux://has_message" }],
        fields: [
            {
                nativeField: contentField,
                path: "flux://body",
                datatype: "http://www.w3.org/2001/XMLSchema#string",
            },
        ],
    };
}
