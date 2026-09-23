# 12 — Decoder GC walks the whole metadata with `for…in`

**Status:** closed (landed as `L12-refidx`, pending owner commit) · **Kind:** perf · **Risk:** low

## Evidence

Seen in the lead 02 profiles. `ReferenceTracker.garbageCollectDeletedRefs`
released a collected Schema's children with `for (const index in metadata)`:
a `for…in` over the class's metadata object for every collected Schema, a
string-keyed `metadata[index]` load per field, and a read of every field,
primitives included.

Profile on `W4` (= `bbf933c`), `--cpu-prof-interval 100`, line ticks as a share
of all samples:

| loop | `for…in` line | whole GC callback (self) |
| --- | --- | --- |
| decoder/churn | 5.1 % | 6.9 % |
| decoder/map-churn/str | 6.0 % | 9.3 % |
| callbacks/add-remove-churn | 3.8 % | 7.8 % |
| decoder/bulk-add/turnover | 9.0 % (+1.9 % on the two lines inside the loop) | 16.5 % |

## Change

The loop now walks `metadata[$refTypeFieldIndexes]`, the per-class list of
ref-typed field indexes that the encoder side already keeps (`forEachChild`,
`Schema` debug walk, Resync). It is filled by `Metadata.addField` for every
non-string, non-quantized type, so classes built by Reflection get it too.
`Metadata.initialize` copies it from parent to subclass, so inherited fields
are covered. Only primitive fields are skipped, and a primitive can't carry a
refId, so the set of released children is the same. The collection branch
(`values()` over Schema children) has no per-class work, so it is unchanged.

## Variants

- **`L12-refnames`** added `refNames: string[]` to `DecodeInfo`, read through
  the ref's decode record (`tree.decodeInfo.info`). It got the same churn wins,
  but in the broad compare it regressed rows that never reach the GC body:
  `callbacks/strategies/raw` +10.3 %, `decoder/tick` +4.0 %,
  `callbacks/strategies/legacy` +4.3 %, `callbacks/density/sparse1pct` +3.9 %
  (A/A ≤ 1.2 %). The likely cause is the changed `DecodeInfo` shape, which the
  decode hot loop reads, or layout. Rejected.
- **`L12-refidx`** (landed) reuses `$refTypeFieldIndexes`. It leaves
  `DecodeInfo` alone and adds no cache.

## Outcome (2026-09-23, on `bbf933c`)

`L12-refidx` vs `W4`, 20 samples/side, median:

| row | Δ | A/A |
| --- | --- | --- |
| decoder/map-churn/num | **−37.0 %** | +0.3 % |
| decoder/map-churn/str | **−32.4 %** | +0.4 % |
| callbacks/add-remove-churn | **−29.2 %** | +0.6 % |
| callbacks/map-churn/num | **−27.6 %** | +0.2 % |
| decoder/bulk-add/turnover | **−22.2 %** | −0.4 % |
| callbacks/map-churn/str | **−14.7 %** | +1.0 % |
| decoder/churn | **−13.4 %** | −0.1 % |
| decoder/resync/churn | −3.3 % | +0.7 % |
| decoder/tick, callbacks/strategies/\*, callbacks/density/\*, decoder/bootstrap, decoder/bulk-add/bootstrap, decoder/map-bootstrap/\* (3 of 4), decoder/resync/full | neutral (−1.6…+2.5 %, p ≥ .12) | — |
| decoder/map-bootstrap/players-str-1000 | +4.3 % (p .041), below its A/A floor of +3.3 %; with `--iters 150`, 16 samples: +2.5 %, p .17. A fresh bootstrap never reaches the GC body (no released refs), so this is noise | +3.3 % |

The churn gains are larger than the profile share. The `for…in` probably also
cost indirectly: enum-cache setup, the string index keys, and the megamorphic
`metadata[index]` load.

Bytes are unchanged (`bench_encode.js` 5 458 157). Tests: 1085 passing, 1 pending.
