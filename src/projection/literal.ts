/**
 * AD4M literal codec — byte-exact with `@coasys/ad4m`'s `Literal`.
 *
 * Encode always emits the current `literal:<type>:<rfc3986>` form; decode also
 * tolerates the deprecated `literal://<type>:…` form. A target that is not a
 * `literal:` URL is a URI reference and passes through unchanged.
 *
 * This is the Channel-B value boundary: AD4M link targets ⇄ plain JS values.
 * Kept dependency-free so the whole `projection/` core copies verbatim across
 * every link language.
 */

export type LiteralValue = string | number | boolean | Record<string, unknown> | unknown[];

function encodeRFC3986(str: string): string {
    return encodeURIComponent(str).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

/** Encode a JS value to an AD4M literal URL (matches `Literal.from(v).toUrl()`). */
export function encodeLiteral(value: LiteralValue): string {
    switch (typeof value) {
        case "string":
            return `literal:string:${encodeRFC3986(value)}`;
        case "number":
            return `literal:number:${encodeRFC3986(String(value))}`;
        case "boolean":
            return `literal:boolean:${encodeRFC3986(String(value))}`;
        case "object":
            if (value === null) throw new Error("Cannot encode null literal");
            return `literal:json:${encodeRFC3986(JSON.stringify(value))}`;
        default:
            throw new Error(`Cannot encode literal of type ${typeof value}`);
    }
}

/**
 * Coerce a raw string value to the JS type implied by an xsd datatype, then
 * encode. Used on ingest where the native value arrives as a string but the
 * SHACL `sh://datatype` says it should be numeric/boolean.
 */
export function encodeTyped(value: string | number | boolean, datatype?: string): string {
    if (typeof value !== "string") return encodeLiteral(value);
    const dt = (datatype ?? "").toLowerCase();
    if (dt.includes("integer") || dt.includes("decimal") || dt.includes("double") ||
        dt.includes("float") || dt.includes("long") || dt.includes("int")) {
        const n = Number(value);
        if (!Number.isNaN(n)) return encodeLiteral(n);
    }
    if (dt.includes("boolean")) {
        if (value === "true") return encodeLiteral(true);
        if (value === "false") return encodeLiteral(false);
    }
    return encodeLiteral(value);
}

/**
 * Decode an AD4M literal URL to its JS value (matches `Literal.fromUrl(u).get()`).
 * Non-literal targets (URI references) are returned unchanged as strings.
 */
export function decodeLiteral(url: string | undefined | null): LiteralValue | undefined {
    if (url === undefined || url === null) return undefined;
    // Normalise the deprecated `literal://` form to `literal:`.
    let u = url;
    if (u.startsWith("literal://")) u = "literal:" + u.slice("literal://".length);
    if (!u.startsWith("literal:")) return url; // plain URI reference — passthrough

    const body = u.slice("literal:".length);
    if (body.startsWith("string:")) return decodeURIComponent(body.slice("string:".length));
    if (body.startsWith("number:")) return parseFloat(body.slice("number:".length));
    if (body.startsWith("boolean:")) return decodeURIComponent(body.slice("boolean:".length)) === "true";
    if (body.startsWith("json:")) return JSON.parse(decodeURIComponent(body.slice("json:".length)));
    // Unknown literal subtype — return the raw url so nothing is silently lost.
    return url;
}

/** True if the string is an AD4M literal URL (either form). */
export function isLiteral(url: string): boolean {
    return url.startsWith("literal:");
}
