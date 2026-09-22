# 06 — Recycle map / set wire indexes

**Status:** open · **Kind:** bytes + memory · **Risk:** medium

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
