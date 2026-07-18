# Porting notes: reconnect resync (`decodeResync`)

Audience: maintainers of non-JS decoder implementations (C#/Unity,
Defold/Lua, Haxe, C++). This documents what changed in `@colyseus/schema`
5.0.8 and exactly what a decoder port needs so reconnecting clients on
your platform get reconciled state instead of ghosts.

Reference implementation, in reading order:

1. `src/decoder/Resync.ts` — the generic algorithm + all design rationale
2. `src/decoder/Decoder.ts` — `decodeResync()`, the two mode fields, the
   sweep hook and the damage hook (4 integration points)
3. `src/decoder/DecodeOperation.ts` — the three guarded bookkeeping hooks
4. `[$resyncPrune]` in `src/types/custom/*.ts` — per-collection sweep
   semantics
5. `test/ResyncSweep.test.ts` — the behavioral contract (port these tests)

## Background: the two bug classes this fixes

A client that drops and reconnects mid-room receives a **full snapshot**
(rejoin `ROOM_STATE`) but decodes it with the regular, additive decode:

1. **Ghost entities** — DELETEs that happened while the client was
   offline are never replayed. Everything deleted during the outage
   survives client-side forever.
2. **RefId-reuse corruption** — servers < 5.0.8 recycled refIds; a stale
   client instance bound to refId R was adopted as an unrelated new
   entity when the server reused R (cross-type: permanent
   `field not defined` / `definition mismatch` spam; same-type: silent
   instance aliasing + callback bleed).

## Compatibility: what you get for free

**There is no wire-format change.** Nothing breaks for existing decoders.

- Bug 2 is fixed **server-side** by 5.0.8's monotonic refIds — old
  decoders benefit immediately, no port needed.
- Bug 1 (ghosts) requires the decoder-side port described below. Until
  ported, rejoin keeps the legacy additive behavior — no worse than
  before.

One behavioral consequence of monotonic ids your decoder must tolerate
(it almost certainly already does): **refIds grow without bound** over a
room's lifetime. They arrive as ordinary msgpack numbers (1 byte < 128,
3 bytes < 65,536, 5 bytes beyond). Do not assume refIds are small or
dense — size any refId-keyed structures accordingly (hash maps, not
arrays).

## The algorithm

`decodeResync(bytes)` is the regular decode plus bookkeeping plus a
post-decode sweep. **Only valid for full-snapshot payloads** — calling it
on an incremental patch would prune everything the patch doesn't touch.

### 1. Mode state (on the Decoder)

- `resyncVisited: Map<refId, Set<identity>> | null` — non-null only
  during a `decodeResync` call. Its non-nullness IS the mode flag.
- `resyncDamaged: boolean` — set when any structure had to be skipped.

### 2. During the decode walk (three hooks, all guarded by the mode flag)

**a. Visit recording** — in the collection-entry decode ops (key/value
and array), after the value is decoded, record
`visited[currentStructureRefId] += identity`, where identity is:

- MapSchema: the **string key** (NOT the wire index — the decoder-side
  journal never evicts stale index→key mappings on re-indexing, so
  index-based matching can mis-delete surviving entries)
- ArraySchema: the **resolved** element index (`ADD_BY_REFID` resolves to
  the instance's *current client-side* position, so visited indexes form
  a sparse set — the sweep is not a tail-trim)
- SetSchema / CollectionSchema: the wire index

Record **even when the decoded value equals the previous value** — change
events can't serve as the record, because unchanged entries produce none.

**b. Replaced-occupant release** — in the same hook: on a **plain ADD
op (exactly ADD, not DELETE_AND_ADD)** whose slot already holds a
*different* instance, release the previous instance's ref (decrement
refCount toward GC) and emit an `onRemove` change for it. Full-sync
always emits plain ADD, so an entry whose occupant changed while the
client was offline would otherwise leak (no `onRemove`, never GC'd).
This must stay **resync-only**: on the live patch path, arrays reuse
plain ADD for positional rewrites of still-alive instances
(shift/unshift), where releasing corrupts refcounts.

**c. Collection presence marking** — when a collection ref is introduced
by its parent's field op (the branch that resolves/creates the collection
instance and bumps its refCount), ensure `visited[collectionRefId]`
exists, as an empty set if absent. This marks "this collection is part of
the snapshot, possibly with zero entries."

### 3. Damage flag

Wherever your decoder skips ahead on an unknown refId or a definition
mismatch (the `skipCurrentStructure` equivalent): if resync mode is
active, set `resyncDamaged`. A skipped range can swallow *other*
structures' ADDs, so the visited data is untrustworthy in ways that
cannot be attributed to a single ref.

### 4. The sweep (after the op loop, BEFORE change callbacks and GC)

If `resyncDamaged`: warn and **abort the sweep entirely**. Keeping a
ghost until the next resync beats deleting live entries on incomplete
data.

Otherwise, depth-first walk **from the root instance** (NOT by iterating
the refId table) over ref-typed fields, with a visited-refId set as the
cycle/shared-ref guard:

- Skip `@transient` fields if your metadata knows them. Reflection does
  NOT transmit `@transient`, so for reflected clients the load-bearing
  rule is presence: **a collection whose refId is absent from
  `resyncVisited` is left completely untouched** (it is not part of
  full-sync: `@transient`, view-invisible, etc.). An *empty* visited set
  means "present with zero entries" → prune everything.
- For each present collection, delete every entry whose identity is not
  in its visited set, **through your regular DELETE machinery** so
  `onRemove` fires with the real previous value and refcounts/GC stay
  correct. Per kind:
  - Map: remove by key; also drop the journal's key→index and *all*
    index→key mappings of swept keys (including stale ones).
  - Array: delete by index, then compact (the array is hole-free when
    the sweep runs: full-sync emits dense ADDs — no DELETEs, no
    gap-writes — so no mid-decode compaction happened).
  - Set/Collection: delete by index.
  - **Stream: never prune.** Stream contents are trickle-delivered, not
    part of full-sync — absence from a snapshot does not mean deleted.
- Recurse into **retained** Schema entries only. Entries removed by the
  sweep are left to your GC's transitive walk — sweeping their subtrees
  directly would double-decrement shared children.

Then run your normal end-of-decode sequence: change callbacks (the
sweep's DELETE changes fire `onRemove`), then garbage collection.

### 5. Client SDK integration

The platform SDK's full-state handler (`ROOM_STATE`) should call
`decodeResync` **only when the decoder already holds refs beyond the
root** — i.e. this is a rejoin over existing state. First joins keep the
plain decode (a fresh tree has nothing to reconcile; the bookkeeping
measured +10–25% on large first-join decodes in JS). Patches stay
additive. No new user-facing API is needed: reconciliation is what
"apply a full state" should have always meant.

## The behavioral contract (port these tests)

`test/ResyncSweep.test.ts` pins, at minimum:

1. Map-of-Schema ghost deletion (`onRemove` once, with the real instance)
2. Primitive-map prune by key
3. Nested collection of a *retained* parent swept; parent identity kept
4. View-filtered array: interior entry swept + compacted (sparse visited)
5. Collection emptied server-side → fully swept
6. No double-decrement for swept entities carrying nested collections
7. Late DELETE patch arriving after the sweep → tolerated, no re-fire
8. Stream entries retained
9. Survivor identity: same instance, no `onAdd` re-fire, field listeners
   still wired for subsequent patches
10. Re-key while offline → same instance under the new key
    (one `onRemove(oldKey)` + one `onAdd(newKey)`)
11. Replaced-under-same-key → `onRemove(old)` + `onAdd(new)`, old ref
    GC'd
12. Damaged payload → sweep aborted, nothing deleted, warning logged
13. `@transient` collection untouched
14. Plain patches remain additive; only `decodeResync` reconciles
