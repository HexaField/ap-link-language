/**
 * Parse projection profiles from SHACL shape links.
 *
 * Reads the `SHACLShape.toLinks()` format (rdf://type, sh://targetClass,
 * sh://property, sh://path, sh://datatype, sh://hasValue) plus the Channel-B
 * `projection://` annotation vocabulary. A class is projectable iff its
 * NodeShape carries a `projection://nativeType` link.
 */

import { decodeLiteral, isLiteral } from "./literal.js";
import { isNodeExpression, type NodeExpression } from "./expression.js";
import type {
    Link,
    ProjectionField,
    ProjectionFlag,
    ProjectionProfile,
} from "./types.js";

const P_NATIVE_TYPE = "projection://nativeType";
const P_AUTHOR_FIELD = "projection://authorField";
const P_TIMESTAMP_FIELD = "projection://timestampField";
const P_ID_FIELD = "projection://idField";
const P_FIELD = "projection://field";
const P_EXPRESSION = "projection://expression";

const SH_TARGET_CLASS = "sh://targetClass";
const SH_PROPERTY = "sh://property";
const SH_PATH = "sh://path";
const SH_DATATYPE = "sh://datatype";
const SH_HAS_VALUE = "sh://hasValue";

type Index = Map<string, Map<string, string[]>>; // source -> predicate -> targets

function buildIndex(links: Link[]): Index {
    const idx: Index = new Map();
    for (const l of links) {
        let byPred = idx.get(l.source);
        if (!byPred) {
            byPred = new Map();
            idx.set(l.source, byPred);
        }
        const arr = byPred.get(l.predicate);
        if (arr) arr.push(l.target);
        else byPred.set(l.predicate, [l.target]);
    }
    return idx;
}

function first(idx: Index, source: string, predicate: string): string | undefined {
    return idx.get(source)?.get(predicate)?.[0];
}

function all(idx: Index, source: string, predicate: string): string[] {
    return idx.get(source)?.get(predicate) ?? [];
}

/** Decode a `literal:string:` annotation target to its plain string. */
function decodeString(target: string | undefined): string | undefined {
    if (target === undefined) return undefined;
    const v = decodeLiteral(target);
    return typeof v === "string" ? v : target;
}

function parseExpression(target: string | undefined): NodeExpression | undefined {
    if (target === undefined) return undefined;
    const decoded = decodeLiteral(target);
    if (isNodeExpression(decoded)) return decoded;
    // Also tolerate a bare JSON string that wasn't literal-wrapped.
    if (typeof decoded === "string") {
        try {
            const parsed = JSON.parse(decoded);
            if (isNodeExpression(parsed)) return parsed;
        } catch {
            /* not JSON — ignore */
        }
    }
    return undefined;
}

/** Extract every projection profile present in a set of shape links. */
export function parseProfiles(shapeLinks: Link[]): ProjectionProfile[] {
    const idx = buildIndex(shapeLinks);
    const profiles: ProjectionProfile[] = [];

    for (const [nodeShapeUri, byPred] of idx) {
        const nativeTypeRaw = byPred.get(P_NATIVE_TYPE)?.[0];
        if (nativeTypeRaw === undefined) continue; // not projectable
        const nativeType = decodeString(nativeTypeRaw);
        if (!nativeType) continue;

        const targetClass = first(idx, nodeShapeUri, SH_TARGET_CLASS) ?? nodeShapeUri;
        const fields: ProjectionField[] = [];
        const flags: ProjectionFlag[] = [];

        for (const propShapeId of all(idx, nodeShapeUri, SH_PROPERTY)) {
            const path = first(idx, propShapeId, SH_PATH);
            if (!path) continue;

            const hasValue = first(idx, propShapeId, SH_HAS_VALUE);
            if (hasValue !== undefined) {
                // A type flag. Preserve the raw target (URIs pass through; a
                // literal flag value is decoded so ingest re-encodes identically
                // is unnecessary — flags emit verbatim, so keep raw).
                flags.push({ path, value: hasValue });
                continue;
            }

            const nativeField = decodeString(first(idx, propShapeId, P_FIELD));
            if (!nativeField) continue; // property not projected

            fields.push({
                nativeField,
                path,
                datatype: first(idx, propShapeId, SH_DATATYPE),
                expression: parseExpression(first(idx, propShapeId, P_EXPRESSION)),
            });
        }

        profiles.push({
            nodeShapeUri,
            targetClass,
            nativeType,
            authorField: decodeString(byPred.get(P_AUTHOR_FIELD)?.[0]),
            timestampField: decodeString(byPred.get(P_TIMESTAMP_FIELD)?.[0]),
            idField: decodeString(byPred.get(P_ID_FIELD)?.[0]),
            fields,
            flags,
        });
    }

    return profiles;
}

/** The predicate a profile can be looked up by, for adapters keyed on native type. */
export function profileByNativeType(
    profiles: ProjectionProfile[],
): Map<string, ProjectionProfile> {
    const m = new Map<string, ProjectionProfile>();
    for (const p of profiles) if (!m.has(p.nativeType)) m.set(p.nativeType, p);
    return m;
}

/** True if a flag target is a literal (vs a URI) — informational for callers. */
export function flagIsLiteral(flag: ProjectionFlag): boolean {
    return isLiteral(flag.value);
}
