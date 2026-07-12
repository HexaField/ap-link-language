/**
 * Settings for the AP Link Language.
 *
 * Parsed from the JSON string returned by `languageSettings()` at
 * runtime. Provides sensible defaults.
 *
 * Spec §4.4 + §9.
 */

export interface RenderingSettings {
    /** Rendering strategy: "auto" detects chat predicates, "semantic"
     *  always includes ad4m:Link tags, "chat" renders as plain notes,
     *  "raw" emits the triple, "native" turns the Channel-B projection off
     *  in BOTH directions (no derived Notes are projected out, and inbound
     *  native Notes are not ingested — Role A carries everything). */
    strategy: "auto" | "semantic" | "chat" | "raw" | "native";
    /** Predicates that indicate a chat-style message. */
    chatPredicates: string[];
    /** Whether to resolve Expression URIs for Note content. */
    resolveExpressions: boolean;
    /** Include ad4m:Link tags for lossless round-trip. */
    includeAd4mTags: boolean;
}

export type SyncMode = "bidirectional" | "publish-only" | "subscribe-only";

export type MembershipMode = "open" | "followers-only" | "members-only" | "admin-approved";

export interface RateLimitSettings {
    /** Maximum requests per minute per actor */
    maxPerMinute: number;
}

export interface APLanguageSettings {
    rendering: RenderingSettings;
    syncMode: SyncMode;
    allowExternalAuthors: boolean;
    requireApproval: boolean;
    /** Membership mode per Spec §14.1 */
    membership: MembershipMode;
    /** Rate limiting per actor */
    rateLimit: RateLimitSettings;
}

/** Default settings — sensible defaults for bidirectional federation. */
export const DEFAULT_SETTINGS: APLanguageSettings = {
    rendering: {
        strategy: "auto",
        chatPredicates: ["flux://has_message", "sioc://content_of"],
        resolveExpressions: true,
        includeAd4mTags: true,
    },
    syncMode: "bidirectional",
    allowExternalAuthors: true,
    requireApproval: false,
    membership: "followers-only",
    rateLimit: { maxPerMinute: 30 },
};

/**
 * Parse settings from a raw JSON string, falling back to defaults
 * for any missing or invalid fields.
 */
export function parseSettings(raw: string | null | undefined): APLanguageSettings {
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
        const parsed = JSON.parse(raw);
        return {
            rendering: {
                strategy: parsed?.rendering?.strategy ?? DEFAULT_SETTINGS.rendering.strategy,
                chatPredicates:
                    Array.isArray(parsed?.rendering?.chatPredicates)
                        ? parsed.rendering.chatPredicates
                        : DEFAULT_SETTINGS.rendering.chatPredicates,
                resolveExpressions:
                    typeof parsed?.rendering?.resolveExpressions === "boolean"
                        ? parsed.rendering.resolveExpressions
                        : DEFAULT_SETTINGS.rendering.resolveExpressions,
                includeAd4mTags:
                    typeof parsed?.rendering?.includeAd4mTags === "boolean"
                        ? parsed.rendering.includeAd4mTags
                        : DEFAULT_SETTINGS.rendering.includeAd4mTags,
            },
            syncMode: parsed?.syncMode ?? DEFAULT_SETTINGS.syncMode,
            allowExternalAuthors:
                typeof parsed?.allowExternalAuthors === "boolean"
                    ? parsed.allowExternalAuthors
                    : DEFAULT_SETTINGS.allowExternalAuthors,
            requireApproval:
                typeof parsed?.requireApproval === "boolean"
                    ? parsed.requireApproval
                    : DEFAULT_SETTINGS.requireApproval,
            membership:
                ["open", "followers-only", "members-only", "admin-approved"].includes(parsed?.membership)
                    ? parsed.membership
                    : DEFAULT_SETTINGS.membership,
            rateLimit: {
                maxPerMinute:
                    typeof parsed?.rateLimit?.maxPerMinute === "number" && parsed.rateLimit.maxPerMinute > 0
                        ? parsed.rateLimit.maxPerMinute
                        : DEFAULT_SETTINGS.rateLimit.maxPerMinute,
            },
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}
