/**
 * Channel-B fold: instances → generic native content, and native content → links.
 *
 * `project` is a pure fold of the authoritative DAG (never read back). `ingest`
 * is the reverse, used only for genuinely native-authored content, which then
 * enters Channel A as new links.
 */

import { decodeLiteral, encodeTyped } from "./literal.js";
import { evalExpression, type EvalValue, type PathLookup } from "./expression.js";
import type {
    AuthoredLink,
    Link,
    Projection,
    ProjectionProfile,
    SubjectInstance,
} from "./types.js";

/** Coerce a decoded literal to a scalar the projection/expression layer uses. */
function scalar(value: unknown): EvalValue {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    return JSON.stringify(value);
}

/**
 * Group links by subject base and keep those that satisfy every flag of the
 * profile (i.e. genuine instances of the class).
 */
export function collectInstances(
    links: AuthoredLink[],
    profile: ProjectionProfile,
): SubjectInstance[] {
    const bySource = new Map<string, AuthoredLink[]>();
    for (const l of links) {
        const arr = bySource.get(l.data.source);
        if (arr) arr.push(l);
        else bySource.set(l.data.source, [l]);
    }

    const instances: SubjectInstance[] = [];
    for (const [base, group] of bySource) {
        const flagsOk = profile.flags.every((flag) =>
            group.some((l) => l.data.predicate === flag.path && l.data.target === flag.value),
        );
        if (!flagsOk) continue;

        const properties = new Map<string, string>();
        for (const l of group) properties.set(l.data.predicate, l.data.target);

        // Author = creator of the (first) flag link if present, else first link.
        const flagLink = profile.flags.length > 0
            ? group.find((l) =>
                profile.flags.some((f) => f.path === l.data.predicate && f.value === l.data.target),
            )
            : group[0];
        const author = flagLink?.author ?? group[0]?.author ?? "";

        // Timestamp = earliest link in the group (instance creation time).
        let timestamp = group[0]?.timestamp ?? "";
        for (const l of group) {
            if (l.timestamp && (!timestamp || l.timestamp < timestamp)) timestamp = l.timestamp;
        }

        instances.push({ base, author, timestamp, properties });
    }
    return instances;
}

/** Fold one instance into generic native content. Flags are never projected. */
export function project(instance: SubjectInstance, profile: ProjectionProfile): Projection {
    const lookup: PathLookup = (predicate) => scalar(decodeLiteral(instance.properties.get(predicate)));

    const fields: Record<string, string | number | boolean> = {};
    for (const field of profile.fields) {
        const focus = lookup(field.path);
        const value = field.expression
            ? evalExpression(field.expression, focus, lookup)
            : focus;
        if (value !== undefined && value !== null) fields[field.nativeField] = value;
    }

    return {
        nativeType: profile.nativeType,
        base: instance.base,
        author: instance.author || undefined,
        timestamp: instance.timestamp || undefined,
        fields,
    };
}

/**
 * Reverse projection: native content → the links that constitute the instance
 * (type flags + content-field links). Author/timestamp are envelope metadata,
 * carried by the caller when it wraps these into LinkExpressions — never content.
 */
export function ingest(
    projection: Projection,
    profile: ProjectionProfile,
    base?: string,
): Link[] {
    const subjectBase = base ?? projection.base;
    if (!subjectBase) throw new Error("ingest: no base URI for the subject instance");

    const links: Link[] = [];

    // Type flags first, so the ingested subject is a proper class instance.
    for (const flag of profile.flags) {
        links.push({ source: subjectBase, predicate: flag.path, target: flag.value });
    }

    for (const field of profile.fields) {
        const value = projection.fields[field.nativeField];
        if (value === undefined || value === null) continue;
        links.push({
            source: subjectBase,
            predicate: field.path,
            target: encodeTyped(value, field.datatype),
        });
    }

    return links;
}
