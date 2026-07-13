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
- **Role B — native projection (derived; SHACL-driven).** A **derived**,
  bidirectional bridge between AD4M subject-class instances and human-facing
  Fediverse content (an ActivityStreams `Note`):
  - *outbound* — committed AD4M instances (e.g. Flux chat messages) are
    **projected** into plain `Create{Note}` activities so Mastodon/Pleroma render
    them, with **no `ad4m` envelope** attached (the Note is indistinguishable from
    an ordinary post). This projection is a pure fold of Role A, is lossy, and is
    **never read back** to rebuild the DAG;
  - *inbound* — plain Fediverse content (`Note`, `Like`, `Announce`, real remote
    `Delete`) is surfaced as ordinary links so AD4M agents can see it, and
    genuinely **native-authored** Notes — from actors that exist *only* on the
    fediverse (no AD4M DID mapping) — are **ingested as NEW authoritative links**
    that then enter Role A.

The cardinal error this language avoids is letting the lossy Role-B projection
stand in for convergence. Role-A links flow through the DAG; Role-B is a derived
overlay whose only write-back into truth is the ingest of genuinely-native posts
(which become first-class Role-A links, never a shadow copy).

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

## Native projection (Role B)

Role B is the derived, human-facing overlay. It is **SHACL-driven**: a subject
class's shape declares how its instances map to a native ActivityStreams object,
and the transformer folds a matched instance's links into that object (and back).
The projection core lives in `src/projection/` and is **protocol-agnostic** —
byte-identical to the Matrix link language's copy — so every plain-text link
language shares one transformer. The only AP-specific half is the
`NativeAdapter` in `src/activitypub-projection.ts`, which knows the AS2 `Note`
shape.

### SHACL profile → `Note`

A projection profile pairs type flags (which links mark an instance) with field
mappings (which link's target fills a native property). The default Flux message
profile — used when no on-graph shape is found — is
`defaultFluxMessageProfile(AP_NOTE_TYPE, "content")`:

- **flag** `base --flux://entry_type--> flux://has_message` marks the instance;
- **field** `base --flux://body--> literal:string:<text>` supplies the text,
  projected into the Note's **`content`** property.

The `content` field is the one required mapping — `toNative` throws if a profile
omits it. An optional `summary` field maps to the Note's `summary` (content
warning). No other AD4M state is emitted.

### Outbound — instances → `Create{Note}`

On `commit`, after the Role-A diff node is federated, `projectAndFederate` folds
the diff's **native-origin** additions (never ap-ingested ones — that would echo
external content straight back out) through `projectInstances`, and wraps each
resulting Note in a plain `Create{Note}` via `projectionNoteToActivity`. The
activity carries **no `ad4m:Diff`/`ad4m:Link` tag and no `ad4m` envelope** — it
is indistinguishable from an ordinary Fediverse post, so Mastodon/Pleroma render
it. This projection is a pure fold of Role A, is lossy, and is **never read back**
to rebuild the DAG. Setting the rendering `strategy` to `"native"` turns Role B
off in both directions (Role A then carries everything).

### Inbound — genuinely-native `Note`s → authoritative links

On `sync`, alongside the Role-A DAG walk, `ingestNativeNotes` scans outbox
`Create{Note}` activities and ingests only those authored **natively on the
fediverse**. Echo suppression skips: our own group actor; any actor that resolves
to a known AD4M DID (`resolveAuthor` returns a `did:`-prefixed string for mapped
agents, `ap:<url>` for pure-fediverse ones); activities carrying an `ad4m:Diff`
tag (those are Role-A substrate, not native content); and note ids already
ingested. A surviving native Note is reversed via the adapter's `fromNative` into
its constituent links (base = `ap://note/<note-id>`, author = `attributedTo`,
timestamp = `published`) and published through `publishDiffRoleA` — so a
pure-fediverse post becomes a **first-class Role-A link**, entering the diff-DAG
exactly like a locally-committed one, never a shadow copy.

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
│  Role B — native projection (SHACL) + AP plumbing                   │
│    projection/  — protocol-agnostic SHACL transformer (shared,      │
│                   verbatim across link languages): profiles,        │
│                   projectInstances, ingestNative, literal codec.    │
│    activitypub-projection.ts — the AP NativeAdapter: Projection ↔   │
│                   AS2 Note (content field); apNoteBase; no envelope. │
│    translate.ts — link ↔ AP activity; diffNode ↔ ad4m:Diff activity;│
│                   projectionNoteToActivity (plain Create{Note});    │
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
  order-independent merge across every ingestion permutation. **§5.5** federates
  two replicas through the *real* `diffNodeToActivity → activityToDiffNode`
  encoding (not a raw byte copy), with the AP actor URL deliberately unrelated to
  the committing DID — the direct guard for the co-located C1 partition where the
  node author failed to round-trip and every peer node was dropped on re-seal.
- **`tests/translate.test.ts`** — link ↔ AP activity translation, diff-DAG
  activity encode/decode, rendering strategies, and the external-note removal
  round-trip (removal is triple-identical to the add it cancels).
- **`tests/cross-runtime.test.ts`** — full stack through mock adapters (store,
  delivery, sync, actors, follow, security, HTTP signatures, round-trip);
  proves the core has no hidden `ad4m:host` dependency and that the revision is
  a DAG content hash rather than an outbox cursor.
- **`tests/projection.test.ts`** — the SHACL projection core plus the AP
  `NativeAdapter`: literal codec, node-expression evaluation, profile parsing,
  instance collection/projection, native ingest, and the `Note` round-trip
  (asserting `toNative` emits ONLY AS2 fields — no `ad4m` envelope or tags).
- **`tests/channel-b-bridge.test.ts`** — the Role-B orchestration glue over the
  AP adapter: `toAuthoredLink`, `projectInstances` (graph → clean `Note`),
  `ingestNative` (`Note` → authoritative links, with container parenting), and
  the `defaultFluxMessageProfile` fallback.
- **`tests/actors.test.ts`**, **`tests/follow.test.ts`**, **`tests/inbox.test.ts`**,
  **`tests/security.test.ts`**, **`tests/sdna.test.ts`**,
  **`tests/dual-language.test.ts`** — actor resolution/DID extraction,
  Follow/Accept/Undo, inbox routing, membership/rate-limiting/blocks, SDNA
  pattern detection, and federation echo-loop dedup.

### Verified live against a real group actor (co-located C1)

The AD4M wind-tunnel C1 scenario runs this language end-to-end against a **live
ActivityPub group actor** (a dependency-free AS2 outbox-reflecting server that
stands in for a Lemmy/Guppe-style group): two executors each write 10 links, then
each removes one, and the harness proves convergence via each executor's own
`queryLinks`. **Both agents reached 20/20 links in 1.05 s and a removal converged
in 3.05 s.** The group's outbox held 21 diff activities (20 adds + 1 removal),
each an `ad4m:Diff`-tagged `Create{Note}` folded identically on both replicas.
This exercises, for real, what the unit suite can only mock:

- **Outbox fan-out** — each agent POSTs its diff activities to the group inbox;
  the group reflects them into its outbox; both agents pull via `syncFromOutbox`
  and fold the emulated `prev` DAG.
- **AP-encoded federation** — every node crosses the full
  `diffNodeToActivity → activityToDiffNode → sealDiff` path, so the content hash
  (including the committing DID) must survive the JSON-LD round-trip.

The live run surfaced two defects the fixtures could not: the executor **discards
`sync()`'s return value** (peer folds must be pushed through `emitPerspectiveDiff`,
now trapped after `syncFromOutbox`), and the **DAG node author was not
round-tripped** through the `ad4m:Diff` tag — the receiver reconstructed it from
the AP actor URL, changing the content hash so every peer node was silently
rejected on re-seal (the A=10/B=10 partition). Both are regression-guarded
(`tests/dag.test.ts` §5.5) and documented in `AGENTS.md`.

### Role B — projection is real, but self-delivery to the Fediverse is not

Channel B was tested against a **real GoToSocial instance**, and the honest
result splits along the two questions:

- **Is the projection real? Yes.** The `Create{Note}` this language emits is
  standards-valid AS2 — a live GoToSocial server **accepted and rendered it as an
  ordinary post**. The native object is correct.
- **Can the language deliver it itself? Not yet.** GTS only accepted the post
  because the delivery was hand-signed with a compliant **RSA-SHA256** HTTP
  signature and pointed at a resolvable actor. This language's **own** outbound
  path cannot yet satisfy a real Fediverse server (see the self-delivery gaps
  below).

So Channel B is **projection-consumable but self-delivery-blocked**: any
Fediverse server will render the object, but making *this language* the sender
requires the signing/serving work listed next.

### What still needs distinct-instance federation

The C1 model is **co-located** — both executors share one group actor on the same
host, so the wire path is exercised but not across a trust/network boundary. Still
only mock-adapter-tested, not run end-to-end against live remote peers:

- HTTP-signed delivery to a **remote** inbox with signature *verification* on the
  receiver (the co-located group accepts signatures without verifying them).
- Actor/WebFinger resolution against a real Mastodon/Pleroma/Lemmy instance.
- Prev-walk **re-fetching** a missing parent activity over the network (co-located,
  every parent already rides in the same outbox pull, so no gap-fill fetch fires).
- **Role-B self-delivery signing/serving** (verified blocked against live
  GoToSocial above): replace the djb2 `ad4m-ldk=` body digest with
  `Digest: SHA-256=<base64>`, sign with **RSA-SHA256** (not Ed25519-`hs2019`),
  actually **serve** `buildGroupActor` at a dereferenceable URL, and expose
  WebFinger — the four gaps that stop this language from delivering its own
  Role-B `Create{Note}` to a real Fediverse server under its own signature.

## `ad4m:host` import boundary

`ad4m:host` is imported **only** in:

- `src/adapters-deno.ts` — `httpFetch`, `storage*`, `agentSignStringHex`,
  `agentSigningKeyId`, `hash`, `emitSignal`, `emitPerspectiveDiff`.
- `index.ts` — `defineLanguage`, `agentDid`, `languageSettings`, `hash`,
  `emitPerspectiveDiff`.

Every other file is runtime-agnostic and imports only from `adapters.ts`.

## License

CAL-1.0 — same as AD4M.
