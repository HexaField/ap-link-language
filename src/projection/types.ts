/**
 * Channel-B projection types — shared, protocol-agnostic.
 */

import type { NodeExpression } from "./expression.js";

/** Minimal triple shape (matches the `data` of an AD4M LinkExpression). */
export interface Link {
    source: string;
    predicate: string;
    target: string;
}

/** A link carrying authorship + time (the fields we need off a LinkExpression). */
export interface AuthoredLink {
    author?: string;
    timestamp?: string;
    data: Link;
}

/** One projected property of a subject class. */
export interface ProjectionField {
    /** Native content-body field this property fills (e.g. `body`, `text`). */
    nativeField: string;
    /** The predicate path on the instance. */
    path: string;
    /** xsd datatype from `sh://datatype`, if declared. */
    datatype?: string;
    /** Optional outbound value transform (SHACL-AF node expression). */
    expression?: NodeExpression;
}

/** A type-flag property (`sh://hasValue`) — discriminates + types instances. */
export interface ProjectionFlag {
    path: string;
    /** Raw target value (a URI like `ad4m://message`, emitted/compared verbatim). */
    value: string;
}

/** A parsed projection profile for one projectable subject class. */
export interface ProjectionProfile {
    nodeShapeUri: string;
    targetClass: string;
    nativeType: string;
    authorField?: string;
    timestampField?: string;
    idField?: string;
    fields: ProjectionField[];
    flags: ProjectionFlag[];
}

/** A subject-class instance collected from the link store. */
export interface SubjectInstance {
    base: string;
    author: string;
    timestamp: string;
    /** predicate path → raw target. */
    properties: Map<string, string>;
}

/** Generic native content — the intermediate an adapter maps to/from a payload. */
export interface Projection {
    nativeType: string;
    base: string;
    author?: string;
    timestamp?: string;
    fields: Record<string, string | number | boolean>;
}

/**
 * Per-language native adapter. Knows only its native schema (which field is the
 * message body, how to build a base URI from the native id). The SHACL profile
 * supplies which graph property fills each field.
 */
export interface NativeAdapter<TNative = unknown> {
    /** Outbound: generic projection → exact native wire payload. */
    toNative(projection: Projection): TNative;
    /** Inbound: native payload → generic projection (or null if not a projected type). */
    fromNative(payload: TNative): Projection | null;
}
