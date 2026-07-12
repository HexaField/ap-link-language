/**
 * SHACL-AF node-expression subset for outbound value transforms.
 *
 * Vocabulary and JSON shape are aligned with PROPOSAL_SHACL_TRANSFORM_DSL so a
 * projection profile's `projection://expression` reuses the same serializable
 * descriptor the model-query pipeline uses. Evaluation is pure: no store
 * access, no async — it folds an instance's already-resolved property values.
 */

export type NodeExpression =
    | { type: "focus" }
    | { type: "literal"; value: string | number | boolean }
    | { type: "path"; predicate: string }
    | { type: "exists"; expr: NodeExpression }
    | { type: "if"; cond: NodeExpression; then: NodeExpression; else?: NodeExpression }
    | { type: "concat"; args: NodeExpression[] }
    | { type: "coalesce"; args: NodeExpression[] };

export type EvalValue = string | number | boolean | undefined;

/** Property lookup: predicate path → already-decoded property value (or undefined). */
export type PathLookup = (predicate: string) => EvalValue;

function truthy(v: EvalValue): boolean {
    if (v === undefined || v === null) return false;
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "boolean") return v;
    return true; // numbers (incl. 0) count as present
}

/**
 * Evaluate a node expression against a focus value and a property lookup.
 * `focus` is the value of the property the expression annotates (the identity
 * input); `lookup` resolves `path()` sub-expressions against the whole instance.
 */
export function evalExpression(
    expr: NodeExpression,
    focus: EvalValue,
    lookup: PathLookup,
): EvalValue {
    switch (expr.type) {
        case "focus":
            return focus;
        case "literal":
            return expr.value;
        case "path":
            return lookup(expr.predicate);
        case "exists":
            return truthy(evalExpression(expr.expr, focus, lookup));
        case "if":
            return truthy(evalExpression(expr.cond, focus, lookup))
                ? evalExpression(expr.then, focus, lookup)
                : expr.else
                    ? evalExpression(expr.else, focus, lookup)
                    : undefined;
        case "concat": {
            const parts = expr.args
                .map((a) => evalExpression(a, focus, lookup))
                .filter((v): v is string | number | boolean => v !== undefined && v !== null);
            if (parts.length === 0) return undefined;
            return parts.map((p) => String(p)).join("");
        }
        case "coalesce": {
            for (const a of expr.args) {
                const v = evalExpression(a, focus, lookup);
                if (v !== undefined && v !== null && v !== "") return v;
            }
            return undefined;
        }
        default: {
            // Exhaustiveness guard — an unknown descriptor is malformed input.
            const _never: never = expr;
            throw new Error(`Unknown node expression: ${JSON.stringify(_never)}`);
        }
    }
}

/** Runtime type guard for a parsed `projection://expression` payload. */
export function isNodeExpression(v: unknown): v is NodeExpression {
    if (!v || typeof v !== "object") return false;
    const t = (v as { type?: unknown }).type;
    return t === "focus" || t === "literal" || t === "path" || t === "exists" ||
        t === "if" || t === "concat" || t === "coalesce";
}
