# 05 — `MapSchema.set`: three string hashes per REPLACE

**Status:** measured, **declined by the user (2026-09-20)** — kept as a
reference so it is not re-walked without a write-dominated workload.

## Evidence

After the `KeyedRecorder` fix, a REPLACE-heavy tick (1 000
`scores.set(key, n)`) spends 56 % of its time in three hash operations on the
same string key inside `MapSchema.set`:

| line | share |
| --- | --- |
| `this.indexByKey.get(key)` | 28.4 % (pays the cold lookup) |
| `this.$items.get(key)` (previous value, for the `===` early-out) | 14.4 % |
| `this.$items.set(key, value)` | 13.0 % |

`$items` (key → value) and `indexByKey` (key → wire index) cover the same key
set.

## Designs measured (ns per entry, 1 000-entry string-keyed map)

| | two Maps (today) | both Maps + value table | one Map + value table |
| --- | --- | --- | --- |
| REPLACE | 30.9 | 25.1 (−19 %) | 13.8 (−55 %) |
| `get` | 10.6 | ≈ | 14.6 (+38 %) |
| `forEach` | 6.0 | ≈ | 8.7 (+45 %) |
| `for…of` | 7.1 | ≈ | 19.1 hand-written (+70 %) / 36.3 generator |

Why the single-Map design loses on reads: once values leave the Map, V8's
native Map iterator cannot serve `for…of` / `entries()`, and `get` pays a second
dependent load. Iterating the index table instead is proportional to slots, not
live entries — a few long-lived entries scattered over many pages is what a
long-running room produces.

## If it is ever reopened

- The middle option (keep both Maps, add `valueByIndex: RefTable<V>`) is API
  neutral: REPLACE −19 %, and `$getByIndex` — called per encoded map entry and by
  the decoder — becomes an array load instead of `keyByIndex.get` + `$items.get`.
  Cost: +8 B per entry and one more structure to keep in sync in `set`,
  `delete`, `clear`, `$reset`, `$applyKeyType`, `$deleteByIndex`,
  `$resyncPrune`, and the decoder's direct `ref.$items.set(...)` writes in
  `DecodeOperation.ts`.
- Semantics that must survive any redesign: membership is defined by `$items`
  alone (after `delete`, the index mappings linger until `$onEncodeEnd` so a
  same-tick re-set keeps its wire index and records REPLACE → DELETE_AND_ADD),
  and a re-set key moves to the END of iteration order, like a JS `Map`.
- `Map.prototype.getOrInsert` (one probe instead of get + set) is not available
  on Node 22's V8; worth re-checking when the minimum runtime moves.
