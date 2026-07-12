/**
 * Channel-B native projection — shared, protocol-agnostic core.
 *
 * SHACL-driven transform between AD4M graph data (subject-class instances) and
 * a native protocol's human-facing content. Copy this directory verbatim into
 * every link language whose native app renders only plain text; each language
 * adds one thin `NativeAdapter` that knows its native schema.
 *
 * The DAG is authoritative; this projection is derived. No DAG bytes enter
 * human content; human content is never used to rebuild the DAG.
 */

export * from "./types.js";
export * from "./literal.js";
export * from "./expression.js";
export * from "./profile.js";
export * from "./project.js";
export * from "./bridge.js";
