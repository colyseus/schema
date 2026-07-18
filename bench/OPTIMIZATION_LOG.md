# Optimization log

Per-candidate record: hypothesis → measurement → verdict. Newest first.

## ROUND 1 CLOSE-OUT (2026-07-02) — cumulative pre-P1 → HEAD, N=20 full matrix
`bench/results/2026-07-02-cumulative-vs-baseline.json`. Wins at p<.001 unless noted:
- callbacks (all strategies/densities): **−13.5…−16.5%**, gcMs **−35…−45%**
- decoder/tick: **−15.8%**, steady-decode GC **eliminated** (13.3ms→0)
- encoder/heavy-tick: **−15.9%** · array-churn: **−11.4%**
- stateview/bootstrap: **−7.5%** (gcMs 14.0→1.07) · view-churn: **−8.2%** ·
  views/v1 −1.5% (p=.008) · v10 −2.2% (p=.024)
- No wall-clock regressions: churn flags at N=20 (+5.1%/+2.8%) dissolved at
  N=40 (+0.2% p=.54 / +2.2% p=.51 with gcMs −11% at p<.001) — inter-run
  variance on 0.035ms/frame scenarios under machine load.
- Accepted cost: memory-footprint +0.4% (+11KB/1000 entities — the
  `_needsCompaction` field on ArraySchema).

**Remaining queue** (see PROFILE_2026-07-02.md): #S1 encodeView concatBytes
(needs a buffer-lifetime decision: returned frame must stay valid until
transport send — consider per-view contiguous layout, reserving sharedOffset
bytes per view, instead of pooling), #E2 _appendToList pool starvation,
#S3 markInvisible growth + StateView._add walk, #E1 [$onEncodeEnd] tmpItems
slice gating, forEachWithCtx, MapJournal.indexOf, decoder main-loop peek.
Accepted criteria: target p<0.05 and |Δ|≥2% (or GC-metric win at p<0.05 with
wall-clock neutral), no other scenario regressing >2% at p<0.05, tests green.

<!-- template
## <candidate-name> (<date>)
- **Hypothesis:** <target function/path>; expect <metric> on <scenarios>.
- **Change:** <1-2 lines>
- **Result:** <compare table excerpt or numbers, p-values>
- **Verdict:** ACCEPTED / REVERTED (→ DEAD_ENDS.md)
-->

## e4a-refid-descriptor (2026-07-02) — ACCEPTED
- **Result:** (targeted N=20) decoder/bootstrap gcMs **22.1→16.4ms (−26%,
  p<.001)**, heap 45.5→42.2KB, wall −1.2% (n.s.); decoder/churn +2.3%
  (p=.86, noise); construct +1.5% (p=.99); deep-nested +0.5% (p=.80);
  entity-churn −2.3% (p=.14). Accepted via the GC criterion: allocation-site
  removal with wall-clock non-regressing everywhere.
- Original hypothesis below.

## e4a-refid-descriptor (queued)
- **Hypothesis:** `Object.defineProperty(ref, $refId, {value,…})` allocates a
  descriptor object per new ref in BOTH `Root.add` (13.8% self, deep-nested)
  and `ReferenceTracker.addRef` (6.1% self, decoder/churn). Reuse one shared
  mutable descriptor (mutate `.value`, pass same object) and, in `addRef`,
  skip re-defining when `ref[$refId]` already exists (property is
  `writable:true` — plain assignment preserves flags). Distinct from dead
  "$refId pre-install": property is still installed lazily at the same sites,
  same shape timeline; only the descriptor allocation + redundant redefine go.
- **Change:** shared module-level descriptor in both files; `addRef` fast path.

## e5-foreachchild-alloc (2026-07-02) — ACCEPTED
- **Result:** (targeted N=20–30) stateview/view-churn **−9.7%** (p<.001) with
  gcMs 199→185 (p<.001); stateview/views/v10 **−1.9%** (p<.001);
  encoder/deep-nested −2.0% (p=.25); construct/e2e neutral. decoder/churn
  showed +2.6–3.1% (p=.056/.024) but no forEachChild* call is reachable from
  the decode loop — artifact of setup-induced heap-state difference (the
  scenario's setup runs an encoder whose attach path DID change) plus a busy
  machine (load 5–9 during the first pass; view-churn A-median inflated +25%
  in that window and normalized later).
- **Iteration:** first cut used `$items.forEach(closure)` for the Map branch —
  regressed construct gcMs +10% (p<.001). Closure-free `keys()` loop fixed it.
- **Attribution caveat:** an unrelated reflection refactor (2637ac7, colon
  string grammar retirement) landed between the A and B builds of this
  comparison, so e5's per-candidate numbers include it on the B side. The
  cumulative sweep below brackets both cleanly.
- **Lessons:** (1) `for..of entries()` pair allocation is worth killing on hot
  walks, but replace with keys()+get, NOT a forEach closure; (2) check system
  load before trusting borderline p-values.

## e5-foreachchild-alloc (queued)
- **Hypothesis:** `forEachChild`/`forEachChildWithCtx` iterate collections via
  `for (const [key, value] of ref.entries())` — iterator + pair array per
  child (7.4% of stateview/views_v10 allocations, 5.3% of encoder/deep-nested).
  Plain `forEachChild` also invokes the `_collectionIndexes` getter per child.
  Replace with `COLLECTION_KIND` dispatch: index loop over `items` for Array
  (zero alloc), `$items.forEach` + hoisted journal lookup for Map (one closure
  per call instead of one pair per child); `entries()` fallback for the rest.
- **Change:** treeAttachment.ts only; iteration order preserved per kind.

## c1-callbacks-map (2026-07-02)
- **Hypothesis:** `ReferenceTracker.callbacks` is `{[refId]: SchemaCallbacks}` —
  integer-keyed plain object with per-ref `delete` on GC → dictionary-mode
  elements; `triggerChanges` does one lookup per change (8.4% self, dense).
  `Map<number, SchemaCallbacks>` should beat dictionary-mode object access.
  Expect: callbacks/strategies/state + density/dense ms/frame; churn variants.
- **Change:** outer registry object → Map in ReferenceTracker (+5 consumer
  lookup sites in Callbacks.ts / getDecoderStateCallbacks.ts). Inner
  SchemaCallbacks stays a plain object (string field keys + small-int ops).
- **Result:** (N=20, full matrix) REGRESSED everywhere the registry is hot:
  density/dense **+7.1%** (p<.001), strategies/state **+6.5%**, legacy
  **+6.8%**, sparse1pct **+5.8%**, add-remove-churn **+3.1%**. Neutral
  elsewhere. Root cause of the wrong hypothesis: refIds are small sequential
  integers → V8 keeps the integer-keyed object in dense ELEMENTS backing
  (array-indexed access), which beats Map hashing; per-ref `delete` only
  happens on ref-GC, not per frame, so dictionary-mode never dominates.
- **Verdict:** **REVERTED** → DEAD_ENDS.md.

## p1-proxy-unwrap (2026-07-02)
- **Hypothesis:** ArraySchema symbol hooks (`$getByIndex`, `$deleteByIndex`,
  `$onEncodeEnd`, `$onDecodeEnd`, static `$filter`) execute with `this`/`ref`
  bound to the Proxy, paying the `get`/`set` trap (incl. `isNaN(prop)`
  ToNumber) on every internal field access. Proxy traps show 13.5%+9.1% self
  in decoder/tick (setup-excluded), and `$onDecodeEnd` is 15.8% total.
  `$onDecodeEnd` also allocates `items.filter(...)` copy per structure switch
  even with zero deletes. Expect: decoder/tick, callbacks/*, encoder/heavy-tick,
  array-churn, stateview improvements; GC drop on decode.
- **Change:** `const self = this[$proxyTarget] ?? this` unwrap in the four
  hooks + `$filter` (established idiom used by 10+ sibling methods);
  `_needsCompaction` flag (set by `$deleteByIndex` and gap-creating `$setAt`)
  gates the `$onDecodeEnd` filter copy.
- **Result:** (N=20, full matrix) decoder/tick **−15.3%** with steady-state GC
  eliminated (11.7ms→0, p<.001); callbacks raw/state/legacy/density
  **−12.9%…−15.6%** with gcMs ~40% lower (p<.001); encoder/heavy-tick
  **−11.2%**; array-churn **−8.9%**; decoder/churn −4.9%; add-remove-churn
  −3.0%; decoder/bootstrap −2.5%. First cut regressed encode-all +16.1% and
  stateview/bootstrap +4.2% — caused by unwrapping BEFORE the `!view`
  short-circuit in `$filter` (encodeAll hits it per element with no view);
  after reordering: encode-all −1.2% (p=.019), bootstrap +0.5% (p=.24).
  Cost: +8B/ArraySchema instance (`_needsCompaction`), memory-footprint +0.7%.
- **Verdict:** **ACCEPTED** (commit follows). Lesson recorded: keep guard-order
  when adding unwraps to shared predicates — `!view` short-circuits must stay first.
