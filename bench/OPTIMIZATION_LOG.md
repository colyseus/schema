# Optimization log

Per-candidate record: hypothesis → measurement → verdict. Newest first.
Accepted criteria: target p<0.05 and |Δ|≥2% (or GC-metric win at p<0.05 with
wall-clock neutral), no other scenario regressing >2% at p<0.05, tests green.

<!-- template
## <candidate-name> (<date>)
- **Hypothesis:** <target function/path>; expect <metric> on <scenarios>.
- **Change:** <1-2 lines>
- **Result:** <compare table excerpt or numbers, p-values>
- **Verdict:** ACCEPTED / REVERTED (→ DEAD_ENDS.md)
-->

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
