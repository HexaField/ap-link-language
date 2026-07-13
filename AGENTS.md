# AGENTS.md — ap-link-language

AD4M link language that syncs a Perspective over **ActivityPub** by embedding a
hash-DAG in the activity stream, and projects links as ActivityStreams **`Note`**
objects so Mastodon-compatible servers render them as posts.

## Architecture (the load-bearing idea)

Two roles, kept strictly separate:

- **Role A — convergence substrate (source of truth).** A hash-DAG carried inside
  activities: each activity references its parent activity hash(es) and carries
  link additions + tombstone removals (original link hash). Merge folds an
  **OR-Set keyed by link hash**.
- **Role B — native projection (derived).** A SHACL-driven transform renders
  Role-A links as AS2 `Note` objects delivered to followers' inboxes.

Invariants — do not break these:

- `currentRevision()` is a **content hash of the DAG head activity hash(es)** —
  never an inbox delivery timestamp, an OrderedCollection page cursor, or an
  activity count.
- Removals are **tombstones carrying the original link hash**; an observed-remove
  converges against its add.
- Sync walks parent activity hashes and re-folds — never diffs an inbox snapshot.
- The projection is a **pure fold of Role A, never read back to rebuild the DAG**.
  Genuinely native-authored notes whose author has **no AD4M DID** are
  echo-suppressed and ingested as new Role-A links.

## Channel-B projection (shared, verbatim)

`src/projection/` is a **protocol-agnostic SHACL→native transformer copied
verbatim** across all Channel-B languages (matrix, nostr, atproto, solid, ap):
`bridge.ts`, `expression.ts`, `index.ts`, `literal.ts`, `profile.ts`,
`project.ts`, `types.ts`. **Do not edit it in isolation** — mirror any change to
every Channel-B repo or the copies drift (asserted identical by diff). A
`NodeShape` annotated `projection://nativeType` selects the native body property;
`projection://field` marks projected properties. `src/activitypub-projection.ts`
is the thin per-protocol `NativeAdapter` mapping to/from an AS2 `Note`.

## Layout

- `src/activitypub.ts` — AS2 activity/object model + hash-DAG embedding.
- `src/dag.ts` — parent-hash DAG: build, walk, compute heads, fold.
- `src/actors.ts` — actor documents + key management.
- `src/delivery.ts` — outbound activity delivery to inboxes.
- `src/inbox.ts` — inbound activity handling.
- `src/follow.ts` — follow/accept membership flow.
- `src/http-signatures.ts` — HTTP Signatures signing/verification.
- `src/security.ts` — key handling + verification helpers.
- `src/activitypub-projection.ts` — the AS2 `Note` `NativeAdapter` (Channel B).
- `src/projection/` — the shared SHACL transformer (see above).
- `src/sync.ts` — head discovery → parent walk → re-fold → diff.
- `src/translate.ts` — link ↔ activity translation.
- `src/store.ts` — derived link cache + query indexes.
- `src/{settings,types}.ts` — settings + shared types.
- `src/adapters.ts` / `src/adapters-deno.ts` — injected adapters; `ad4m:host`
  confined to `adapters-deno.ts` + `index.ts`.

## Build / test / typecheck

```bash
NODE_ENV=development pnpm install     # NODE_ENV=production skips devDeps — installs look broken
deno run --allow-all esbuild.ts       # bundle → build/ (needs @coasys/ad4m-ldk at ../ad4m/ad4m-ldk/js or AD4M_LDK_ENTRY)
npx tsc --noEmit                      # typecheck — the ONLY type gate; tsx/esbuild transpile without checking
node --experimental-vm-modules --import tsx --test tests/*.test.ts   # full suite
```

ESM imports use explicit `.js` extensions even for `.ts` sources. `npm test`
summary lines are `ℹ tests N` / `ℹ pass N` / `ℹ fail N`.

## What's unit-tested vs what needs a live backend

Hermetic: the parent-hash DAG fold, OR-Set merge, HTTP-signature sign/verify,
revision stability, and the projection (AS2 `Note` payload shape + echo-suppressed
ingest) against in-memory fixtures. **Not** in CI: live inbox delivery to a
federated server and **live rendering in Mastodon**.

## Live C1 convergence (wind-tunnel) — verified, with two fixes

The AD4M wind-tunnel **C1** scenario runs two co-located executors against a live
AP group actor (outbox-reflecting shim). **Verified pass:** A=20/B=20 adds in
~1.05 s, removal converged in ~3.05 s. Topology is **outbox-pull**: each agent
POSTs its diff activities to the group inbox → the group reflects them into its
outbox → both agents pull via `syncFromOutbox` and fold the emulated `prev` DAG.

Two defects the hermetic fixtures missed (both now regression-guarded):

1. **The executor discards `sync()`'s return value.** Inbound peer folds become
   queryable ONLY if pushed through `emitPerspectiveDiff`. After `syncFromOutbox`,
   `index.ts` emits the combined delta when non-empty. Symptom without it: C1
   add-freeze (peers fold internally but `queryLinks` never sees them).
2. **The DAG node `author` MUST round-trip through the `ad4m:Diff` tag.** The node
   author (committing DID) is part of the content hash (`dag.canonicalDiff`), so a
   receiver re-seals the decoded node and rejects it if the recomputed id ≠
   `ad4m:diffId` (`sync.ingestDiffActivities`). The old decoder reconstructed the
   author from the **AP actor URL** (`ap:${actor}`) instead of carrying the DID —
   changing the hash so **every peer node was silently dropped** (the A=10/B=10
   partition). Fix: `diffNodeToActivity` writes `ad4m:author: node.author`;
   `activityToDiffNode` reads it back (falling back to the actor URL only for
   pre-fix activities, which correctly fail re-seal). Guard: `tests/dag.test.ts`
   §5.5 federates two replicas through the real `diffNodeToActivity →
   activityToDiffNode` encoding with a non-DID actor URL. **The existing
   `transport()` fixture copies raw node bytes and re-seals with the author
   intact — it can NEVER catch an encoding-layer author-loss bug. Any new
   federation-path test must go through the AP activity encoding.**

Link-level additions already round-tripped `ad4m:author`/`ad4m:timestamp` via
`buildAd4mTag`; the bug was only the node-level author on the `ad4m:Diff` tag.

## Gotchas

- ActivityPub delivery is HTTP push only — no bidirectional presence channel, so
  no telepresence. Do not claim it.
- `src/projection/` is shared — edit here and propagate, never fork.
