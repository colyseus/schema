# 06 — Recycle map / set wire indexes

**Status:** v1 landed (MapSchema only, 2026-09-24) · **Kind:** bytes + memory · **Risk:** medium

## Outcome (v1)

Owner decisions: MapSchema-only v1 with no wire or decoder change; SetSchema,
CollectionSchema and StreamSchema (and `.stream()` maps) never recycle;
`forEachLive` walks maps in `$items` order as its own commit. Design:
`06-wire-index-recycling-design.md`.

- **Rule.** An index whose DELETE was encoded (`endEncode`, never `discard`)
  goes on the recorder's free stack (`KeyedRecorder.free`, a LIFO `number[]`)
  and is reused by a new key from the next tick on. An index some view still
  holds a `view.changes` entry for is quarantined until that view drains
  (`Root.pendingViewChanges()`, once per `encodeEpoch`). StateView writes a
  Map child's entry only while the child holds its index (a child replaced
  this tick still gets its DELETE). `clear()` and pooled `$reset` drop the
  free set. `MapSchema.set` on a new key pays one `rec.free` load and
  compare.
- **Stack, not bitset.** Push/pop micro-bench: 4.8 ns/op (stack) vs 5.8–6.4
  (lowest-first bitset). The churn benches free exactly the indexes deleted
  the tick before, so bytes are the same either way.
- **Bytes** (W7 → L06, bytes per op as the bench prints them):
  `encoder/map-churn` −4.5…−8.6 % (str-16 464 → 424), `encoder/entity-churn`
  −2.8 %, `decoder/map-churn` −4.6 / −5.5 %; everything else identical,
  `bench_encode.js` still 5 458 157 bytes. Over 20 000 cycles `nextIndex`
  stays at the live size (100 / 1000 / 16; same-tick 110) instead of 200 100+,
  and bytes per cycle in the last window drop 475 → 449 (str-100), 395 → 369
  (num-100), 475 → 435 (str-16).
- **Time.** No reproducible regression; `encoder/map-churn` −2…−6 %.
- **Follow-up: decoder overwrite landed (2026-09-25).** An ADD onto an occupied
  Set / Collection / Stream index now replaces the entry (`storeKeyValue`),
  and the collection-body path releases the previous Schema child like the op
  path does (`decodeKeyValueBody`, which also covered Map bodies). Both were
  pinned by `test/MapIndexRecycling.test.ts`, now real assertions. Set /
  Collection recycling itself is still off: 5.x clients are rejected at the
  handshake, so every 6.x client carries the fix, but each non-JS SDK port must
  implement the same overwrite rule (SPEC: an ADD onto an occupied index is the
  replacement) before servers recycle.


## Evidence

Wire indexes of `MapSchema` / `SetSchema` / `StreamSchema` entries are handed
out by `nextIndex++` and never recycled (only `clear()` restarts at 0).

- **Bytes.** A keyed op is `uvarint(index * 4 + code)`: one byte up to index 31,
  two up to 8 191, three beyond. A churned map passes 8 192 within a few
  thousand add / remove cycles, and every op on it grows by a byte from then on
  (noted in `bench/v6-results.md`, "MapSchema rewrite → Lessons": a 3-bit op
  field hit the 3-byte threshold at 2 048 and measured +8…+17 % on churn
  decode, which is why the field is 2 bits).
- **Memory / tables.** Everything keyed by wire index grows with the highest
  index, not the live size: `keyByIndex` (`RefTable`, pages released when empty,
  so bounded by live entries *per page*), the `KeyedRecorder` byte pages (idle
  pages dropped), the decoder's `keyByIndex`. The paging added this session
  bounds memory but not the index magnitude.

## Proposal

Keep a free-list of indexes whose DELETE has shipped to every client
(`$onEncodeEnd` is where the mapping is purged today) and reuse the lowest one
on the next ADD.

## Why it is not trivial

- A per-view `changes` entry can still reference a recycled index: a stale
  DELETE / ADD queued for view X would address the NEW occupant. The per-view
  drain would have to re-check identity (compare the value / its refId) or the
  free-list must wait until no view holds an entry for that index.
- The decoder derives DELETE_AND_ADD from "ADD onto an occupied index"; a reused
  index must be free on every client that will receive the ADD — reconnecting /
  resyncing clients included (`decoder/Resync.ts` prunes by key, not index).
- Iteration order on the decoder follows its own `$items` insertion order, so
  it is unaffected; `liveIteration` walks `keyByIndex` in index order, so
  full-sync order would change (bytes of `encodeAll` change — acceptable, but
  the A/B byte guard will flag it).

## How to measure

`encoder/map-churn`, `decoder/map-churn`, `encoder/entity-churn` byte columns
over a long run (raise the cycle count until indexes pass 8 192), plus
`stateview/view-churn` for the view-drain correctness cost.
