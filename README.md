# ActivityPub Link Language for AD4M

An AD4M Link Language that bridges Perspectives to the Fediverse via ActivityPub,
built around a content-addressed diff-DAG so it genuinely honours AD4M's
`perspective-sync` convergence contract — not just a best-effort mirror.

## Overview

This language implements the `perspective-commit`, `perspective-sync`,
`perspective-query`, and `peers` capabilities using ActivityPub as the transport.
It plays **two distinct roles** at once, and keeps them strictly separated:

- **Role A — convergence substrate (source of truth).** A content-addressed,
  causal, mergeable **diff-DAG** that stores *diffs* (link additions + tombstoned
  removals), NOT a materialised snapshot. This is what AD4M's `perspective-sync`
  actually requires: a revision that means the same thing on every replica, a
  fold that reproduces the link set, and removals that converge. ActivityPub has
  no native causal DAG, so the DAG is **emulated inside the activity stream**
  (see below).
- **Role B — native projection (best-effort bridge).** Plain Fediverse content —
  `Create{Note}`, `Like`, `Announce`, real remote `Delete` — is projected into
  the perspective as ordinary links so AD4M agents can see and interact with
  Mastodon/Pleroma posts. This projection is lossy and is *never* treated as the
  source of truth.

The cardinal error this language avoids is letting the lossy Role-B projection
stand in for convergence. Role-A links flow through the DAG; Role-B links are a
separate, clearly-marked overlay.

## The emulated diff-DAG (Role A)

Because an AP outbox is an activity *stream* and not a hash-linked graph, we
emulate a causal DAG **inside** the stream:

- Each AD4M diff is published as a single AP activity carrying an `ad4m:Diff`
  JSON-LD tag. The tag holds a **content-hash id**, the parents' content hashes
  (`ad4m:prev`), and the removed link hashes (`ad4m:removals`). The additions
  ride alongside as `ad4m:Link` tags, so a folder can materialise the link set
  with no extra fetches.
- The activity id is `${GROUP_ACTOR_URL}/diffs/${contentHash}`, so a `prev`
  pointer can be resolved back to the parent activity URL during sync.
- **Sync walks the `prev` DAG and folds it** — it does not diff the whole outbox
  against local state. The outbox is a transport for DAG nodes; the DAG is
  authoritative. Missing parents are re-requested until the local DAG is causally
  complete (bounded by a fetch budget).
- **`currentRevision()` is a content hash of the DAG head(s)** — the single head
  hash, or a deterministic digest of the sorted head set when there are
  concurrent heads. It is NEVER an activity-id URL, ETag, page cursor, or
  timestamp. It is deterministic for a given DAG state and stable across
  restarts.

### Merge = observed-remove set (OR-Set) keyed by link hash

Merging two DAG states is set-theoretic and needs no coordinator:

- an **addition** is an add-instance of a link hash, tagged by the id of the node
  that added it;
- a **removal carries the ORIGINAL link hash** it observed and tombstones the
  add-instances of that hash in its **causal past** only;
- a link survives iff it has at least one add-instance that no *observing*
  removal tombstoned.

This yields the full OR-Set contract, decided by causality rather than fold
order, so the fold is order-independent:

- add → remove (remove observes the add) ⇒ gone on every replica;
- remove → re-add (a new add-instance the old removal could not observe) ⇒
  present again;
- **concurrent** add + remove (neither in the other's causal past) ⇒ add-wins.

### The removal fix (killing `ap://deleted`)

The previous implementation turned a delete into a synthetic link with predicate
`ap://deleted`, whose content hash differed from the original add — so it could
never match, and removals silently never took effect. That placeholder is gone.

Two honest removal paths now exist:

1. **AD4M convergence removals** flow through the diff-DAG carrying the original
   link hash, so they converge against the exact add they cancel.
2. **Genuine external Fediverse `Delete`s** come from a different actor at a
   different time and cannot reconstruct the original content hash, so they are
   matched by `(source, predicate, target)` triple against the `ap://external-note`
   link the original `Create{Note}` produced (see `store.removeExternalLink`).

A regression test (`tests/dag.test.ts`) reproduces the old `ap://deleted` shape
and asserts it fails to cancel a link — locking the bug out.

## Capabilities

| Capability | Status | Notes |
|---|---|---|
| `perspective-commit` | ✓ | Appends one diff node to the DAG (parented on current heads); the KV cache is re-folded and the materialised delta emitted; the node is federated as one `ad4m:Diff` activity. |
| `perspective-sync` | ✓ | Walks the emulated `prev` DAG, folds it (OR-Set), rebuilds the derived cache, and projects external AP content. **Kept, not dropped** — real convergence is achieved. |
| `perspective-query` | ✓ | Link-pattern queries against the derived KV cache (indexed by source/target/predicate). |
| `peers` | ✓ | AP followers with DIDs form the peer set. |
| telepresence | ✗ | No ActivityPub equivalent. |

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  AP Link Language instance                                          │
│                                                                     │
│  index.ts — defineLanguage entry point; wires Deno adapters and     │
│             the commit/sync/query/peers capability handlers.        │
│                                                                     │
│  Role A — convergence substrate (source of truth)                   │
│    dag.ts     — content-addressed diff-DAG: seal/putNode/heads,     │
│                 currentRevision (head-hash), fold (causal OR-Set),  │
│                 commitDiff, topoOrder, missingParents.              │
│    store.ts   — derived KV cache folded FROM the DAG; link indexes; │
│                 rebuildCacheFromDag; external-link triple removal.  │
│    sync.ts    — outbox transport + DAG ingest (re-seal to verify    │
│                 content hash) + prev-walk + fold + external project. │
│                                                                     │
│  Role B — native projection + AP plumbing                           │
│    translate.ts — link ↔ AP activity; diffNode ↔ ad4m:Diff activity;│
│                   SDNA pattern detection; dual-language origin      │
│                   tracking; external-note / Delete translation.     │
│    inbox.ts     — inbound routing: ad4m diff activities → DAG,      │
│                   external activities → projection; Follow/Undo.    │
│    delivery.ts  — sign + deliver activities to follower inboxes.    │
│    actors.ts    — actor resolution + DID extraction + cache.        │
│    follow.ts    — Follow/Accept/Undo handshake.                    │
│    security.ts  — membership, rate limiting, block list, followers. │
│    http-signatures.ts — HTTP Signature signing/verification.       │
│    activitypub.ts — AP types + JSON-LD context (incl. ad4m:Diff).  │
│    settings.ts / types.ts — settings parsing + local types.        │
│                          ↕ injected adapters                        │
│    adapters.ts      — Transport / StorageAdapter / SigningAdapter / │
│                       RuntimeAdapter interfaces + singletons.       │
│    adapters-deno.ts — Deno implementations; the ONLY ad4m:host      │
│                       import boundary alongside index.ts.           │
└────────────────────────────────────────────────────────────────────┘
```

### Cross-runtime design

All core logic is runtime-agnostic. Four adapter interfaces (in `adapters.ts`)
abstract every external dependency; the Deno implementations (in
`adapters-deno.ts`) are the only place — besides `index.ts` — that imports
`ad4m:host`.

| Adapter | Purpose | Deno impl | WASM (future) |
|---|---|---|---|
| `Transport` | HTTP requests | `DenoTransport` → `httpFetch` | `WasmTransport` → `http-ext.fetch` |
| `StorageAdapter` | KV persistence | `DenoStorageAdapter` → `storage*` | Component Model KV |
| `SigningAdapter` | Cryptographic signing | `DenoSigningAdapter` → `agentSignStringHex` | WASM crypto import |
| `RuntimeAdapter` | Content-address hash, signals, diffs | `DenoRuntime` → `hash`, `emitSignal` | WASM host calls |

The same hash function is wired into **both** `store.ts` and `dag.ts` at init, so
a link's content hash is identical in the KV cache and the DAG OR-Set — the
invariant that lets a removal's hash line up with its add. `wit/http-ext.wit`
sketches the proposed executor HTTP extension for a future WASM runtime.

## Template variables

| Variable | Description |
|---|---|
| `GROUP_ACTOR_URL` | AP Group Actor URL (also the base for `…/diffs/<hash>` DAG node URLs) |
| `GROUP_INBOX_URL` | Group inbox endpoint |
| `GROUP_OUTBOX_URL` | Group outbox endpoint (DAG transport) |
| `FEDERATION_DOMAIN` | Domain for AP federation |
| `NEIGHBOURHOOD_META` | JSON-encoded Neighbourhood metadata |

## Building & testing

```bash
# Type-check
pnpm run typecheck            # tsc --noEmit

# Bundle for the AD4M executor (output: build/bundle.js)
deno run --allow-all esbuild.ts

# Run the test suite
NODE_ENV=development pnpm run test
```

> On a fresh checkout use `NODE_ENV=development` so devDependencies (tsx,
> esbuild) install; the default `production` env skips them.

### Test suite

- **`tests/dag.test.ts`** — the convergence acceptance criteria: content-hash
  revision (deterministic + stable across restart), DAG-fold reproduces the link
  set, removal convergence carrying the original hash (incl. the `ap://deleted`
  regression, add-after-remove, and concurrent add/remove OR-Set cases), and
  order-independent merge across every ingestion permutation.
- **`tests/translate.test.ts`** — link ↔ AP activity translation, diff-DAG
  activity encode/decode, rendering strategies, and the external-note removal
  round-trip (removal is triple-identical to the add it cancels).
- **`tests/cross-runtime.test.ts`** — full stack through mock adapters (store,
  delivery, sync, actors, follow, security, HTTP signatures, round-trip);
  proves the core has no hidden `ad4m:host` dependency and that the revision is
  a DAG content hash rather than an outbox cursor.
- **`tests/actors.test.ts`**, **`tests/follow.test.ts`**, **`tests/inbox.test.ts`**,
  **`tests/security.test.ts`**, **`tests/sdna.test.ts`**,
  **`tests/dual-language.test.ts`** — actor resolution/DID extraction,
  Follow/Accept/Undo, inbox routing, membership/rate-limiting/blocks, SDNA
  pattern detection, and federation echo-loop dedup.

### What is (and is not) covered without live federation

The DAG algebra is fully unit-tested: walk, fold, OR-Set merge, revision
determinism, restart stability, and removal convergence are exercised against
in-memory fixtures, modelling two replicas as two storages that exchange sealed
diff nodes. What still needs a **live multi-instance federation harness** (two
real AD4M executors + AP servers) is the end-to-end wire path: HTTP-signed
delivery to real inboxes, actor/webfinger resolution against live servers, and
prev-walk re-fetching parent activities over the network. Those paths are
covered by mock-adapter tests here but not against live peers.

## `ad4m:host` import boundary

`ad4m:host` is imported **only** in:

- `src/adapters-deno.ts` — `httpFetch`, `storage*`, `agentSignStringHex`,
  `agentSigningKeyId`, `hash`, `emitSignal`, `emitPerspectiveDiff`.
- `index.ts` — `defineLanguage`, `agentDid`, `languageSettings`, `hash`,
  `emitPerspectiveDiff`.

Every other file is runtime-agnostic and imports only from `adapters.ts`.

## License

CAL-1.0 — same as AD4M.
