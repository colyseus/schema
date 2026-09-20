# Real-world scenarios: v5 vs v6, V8 profiling, and the optimization round

Machine: Windows 11 Pro, 16 logical cores, Node v20.13.1 (V8 11.3). Bench harness
`bench/run.mjs --compare`, 20 samples per side (8 for A/A), ABBA-interleaved,
one process per sample, Mann-Whitney U on wall-clock and GC time. Numbers are
medians of per-rep medians. Rows against the 5.x build show `A:≠B !!` in the
bytes column by design (different wire formats).

Builds:

| label | what |
|---|---|
| `bench/.builds/v5-release` | fresh `master` (5.0.31, `cf0ff9b`) build; byte-identical to the 5.0.23 shim on `encoder/steady-tick`, p > 0.05 on time |
| `bench/.builds/v6-wip` | v6 branch `a7e4b21` + the typed-map-key work (= `map-keys-3`) — the starting point of this round |
| `x1-viewlists` … `x7-run` | the experiments below, stacked in order (each compare is against the previous label) |

## 1. Scenario matrix (`bench/scenarios/realworld/`)

`bench/lib/realworld.mjs` builds the shapes and drives them with the server's
own per-tick sequence (`serverTick` = `SchemaSerializer.applyPatches`: offset 1,
`hasChanges` gate, one shared `encode`, one `encodeView` per client into the
same buffer, `discardChanges`). All shapes run unchanged against 5.0.31.

| scenario | shape | per tick |
|---|---|---|
| `entities-aoi` (+ `-large`) | `State { players: Map<Player>, entities: Map<Entity> (@view), tick, phase }`, `Entity { x, y, vx, vy, rotation, hp, kind, name }`; 3000×3000 world, 10×10 grid, each client sees its 3×3 cells (≈ 9 % of entities) | every entity moves (x, y, rotation), cell crossings → `view.add/remove`, every 10th tick 5 % lose hp, `tick++`, 5 players score |
| `entities-aoi-decode` | one client of that room | decodes its `[shared, view]` frame |
| `big-state` | 10k / 20k entities + 100 players + 2000 tiles + config | `encodeAll`; fresh `Decoder` per snapshot; `onAdd → listen(x, y)`; handshake |
| `large-patch` | 5000 entities, no views | 100 % change `x, y, vx, vy` (`number` / float32+int16 / nested `Vec2` / quantized) |
| `small-patch` | 5000 entities | one root field / 1 / 5 entities; the same with 50 idle views; an idle tick |
| `lobby-chat` | 100 players, 50-message ring buffer | push + shift a message, 3 `ready` toggles, 20 pings |
| `inventory-rpg` | 200 heroes × 20 items, `stats: Stats` | 200 moves, 10 hp/mp, 5 item adds, 5 removes, 2 `stats` replaced, 1 level |
| `turn-based` | 64-cell board, 4 players | one move; broadcast to 100 / 1000 decoders |
| `mmo-shards` | 500 players: public x/y/hp, `@view()` gold + inventory, `@view(1)` mana; 100 / 500 clients own one player and see 4 party mates | all move, 20 hp, 20 mana, 50 gold, 10 item adds, 5 removes |

## 2. v5.0.31 vs v6 (`v6-wip`, before this round)

| unit | v5 | v6-wip | Δ | bytes v5 → v6 |
|---|---|---|---|---|
| small-patch/root-field | 0.194 µs | 0.303 µs | **+56 %** | 5 → 7 |
| small-patch/one-entity | 0.292 µs | 0.363 µs | **+25 %** | 16 → 15 |
| small-patch/five-entities | 0.935 µs | 0.937 µs | 0 | 82 → 77 |
| small-patch/root-field-50views | 14.5 µs | 10.3 µs | −29 % | |
| small-patch/idle-50views | 0.131 µs | 0.132 µs | 0 | |
| small-patch/dec-one-entity | 0.542 µs | 0.503 µs | −7 % | 14 = 14 |
| large-patch/enc-5k | 1.147 ms | 0.888 ms | −23 % | 142 011 → 137 264 |
| large-patch/enc-5k-typed | 1.050 ms | 0.777 ms | −26 % | 119 622 → 114 875 |
| large-patch/enc-5k-nested | 1.463 ms | 1.225 ms | −16 % | 162 011 → 152 264 |
| large-patch/enc-5k-quantized | 1.302 ms | 1.022 ms | −22 % | 79 409 → 74 662 |
| large-patch/dec-5k | 3.776 ms | 3.381 ms | −10 % | |
| large-patch/dec-5k-typed | 3.874 ms | 3.510 ms | −9 % | |
| entities-aoi/n500-c10 | 0.181 ms | 0.173 ms | −5 % | 8 746 → 8 557 |
| entities-aoi/n2000-c50 | 2.075 ms | 1.634 ms | −21 % | 175 164 → 167 972 |
| entities-aoi/n2000-c50-nested | 4.182 ms | 3.477 ms | −17 % | 206 250 → 191 185 |
| entities-aoi/n2000-c50-typed | 1.915 ms | 1.550 ms | −19 % | 148 542 → 141 349 |
| entities-aoi/n2000-c50-numkeys | 2.086 ms | 1.687 ms | −19 % | 175 142 → 167 913 |
| entities-aoi-decode/n2000-c1 | 25.7 µs | 14.4 µs | −44 % | 1 693 → 1 625 |
| entities-aoi-decode/n2000-c1-callbacks | 38.5 µs | 26.3 µs | −32 % | |
| entities-aoi-decode/n10000-c1 | 141.6 µs | 68.6 µs | −52 % | 9 215 → 8 798 |
| lobby-chat/enc | 8.51 µs | 8.02 µs | −6 % | 227 → 216 |
| lobby-chat/dec | 8.01 µs | 6.59 µs | −18 % | |
| lobby-chat/callbacks | 13.2 µs | 11.7 µs | −12 % | |
| inventory-rpg/enc | 51.5 µs | 44.5 µs | −14 % | 3 536 → 3 294 |
| inventory-rpg/dec | 72.7 µs | 41.5 µs | −43 % | |
| inventory-rpg/callbacks | 89.2 µs | 61.0 µs | −32 % | |
| turn-based/enc | 0.983 µs | 1.035 µs | **+5 %** | 12 = 12 |
| turn-based/broadcast-100 | 66.9 µs | 35.5 µs | −47 % | 1 212 → 1 199 |
| turn-based/broadcast-1000 | 2 119 µs | 780 µs | −63 % | 12 074 → 11 949 |
| mmo-shards/enc-c100 | 0.836 ms | 0.154 ms | −82 % | 831 361 → 783 923 |
| mmo-shards/enc-c500 | 3.634 ms | 0.411 ms | −89 % | 4 148 166 → 3 910 929 |
| mmo-shards/e2e-c20 | 2.729 ms | 1.646 ms | −40 % | 166 240 → 156 760 |
| big-state/encode-10k | 9.46 ms | 4.57 ms | −52 % | 654 490 → 510 757 |
| big-state/encode-20k | 18.5 ms | 9.07 ms | −51 % | 1 288 834 → 1 028 718 |
| big-state/decode-10k | 48.5 ms | 43.5 ms | −10 % | |
| big-state/decode-20k | 116 ms | 98.5 ms | −15 % | |
| big-state/decode-10k-callbacks | 73.7 ms | 67.3 ms | −9 % | |
| big-state/handshake | 0.497 ms | 1.468 ms | **+196 %** | 685 → 512 |
| entities-aoi-large/n10000-c200 | 56.6 ms | 38.7 ms | −32 % | 3 556 063 → 3 394 601 |
| entities-aoi-large/n10000-c200-move20 | 8.46 ms | 5.14 ms | −39 % | 717 872 → 685 261 |

A/A null run (`v6-wip` vs itself, N = 8, `small-patch/*`): p > 0.05 on all six rows.

All rows p < 0.001 except the ones marked 0 (p > 0.05). The picture: v6 wins
everywhere that has real work per tick (views, decode, broadcast), by 20–90 %,
and loses the two tiny-patch rows by a fixed 0.07–0.11 µs per tick — the
per-pass setup (`_beginPass`, frame release) is larger than v5's, which matters
only when the tick is a single field. Bytes: v6 saves 3–5 % on patches (the
header is 2 B per structure either way; values dominate), 20–25 % on
snapshots, and costs 2 B on a one-field patch.

## 3. What the profiler said (v6-wip)

Tooling added: `bench/profile-v8.mjs --deopt | --ic | --inlining | --shapes`
(`bench/lib/analyze-deopt.mjs`, `analyze-ic.mjs`, `analyze-inlining.mjs`,
`shape-check.mjs`), `profile.mjs --interval`, `bench/lib/wire-whatif.mjs`.

| unit | finding (CPU self time, `profile.mjs --cpu --interval 100/200`) |
|---|---|
| entities-aoi/n2000-c50 | `_encodeViewBody` **53 %**: for every client it walked *every* dirty filtered tree (2000) calling `isChangeTreeVisible` — O(dirty × clients), 100k checks per tick to emit 9 000 chunks; the chunk memcpy cache was another 6 % |
| large-patch/enc-5k | the generated **field setter 38 %** (as much as the whole encode) — 4 megamorphic loads per set (`this[$values]`, `this.constructor`, `[$track]`, `this[$changes]`), a setter closure is shared by every class declaring that field; `encodeQueue` 19 %; `writeNumber` 18 % (**not inlined**: called through the per-field `encoders[index]` slot — one call site for every primitive writer, megamorphic) |
| large-patch/dec-5k | `decodeSchemaSlot` **67 %** (≈ 140 ns per slot): `ref[field.name]` load + `ref[field.name] = value` store with a dynamic key — megamorphic keyed access through the tracked setter; v5 has the same cost (`decodeSchemaOperation` 61 %) |
| small-patch/root-field | per-pass fixed cost: `releaseFrames` 12 %, `_beginPass` 8 %, `encode` 13 % — 0.34 µs/tick total, so nothing to chase in absolute terms |
| small-patch/root-field-50views | `_encodeViewBody` 66 % with nothing to emit: ≈ 200 ns per idle view (`_beginPass`, Map iterator, two `subarray` allocations) |
| big-state/decode-10k-callbacks | GC 22 %; `decodeSchemaSlot` 24 %, `triggerChanges` 7 %, `addRef` 7 % (`defineProperty` per instance), `installUntrackedChangeTree` 6 % (fresh descriptor literal per instance); `hasPendingChange` did **not** show up |
| inventory-rpg/dec | `decodeChunks` 16 % self (`ref.constructor` + `COLLECTION_KIND` megamorphic loads per chunk), `garbageCollectDeletedRefs` 8.5 % (for-in over dictionary metadata + `Array.from().forEach`), `addRef` 8 % |

IC log (`--ic`): hot-path megamorphic sites were exactly the loads above
(`decodeBody` `COLLECTION_KIND` 10 maps, `addRef` `$refId` 8, `enterFrame`
`$childType` 8, `writeRef` `constructor` 7, the setter closure's `$values` /
`constructor` / `~track` / `$changes` 5–8 maps each, `decodeSchemaSlot`
`name` keyed load → generic). Deopts (`--deopt`): nothing pathological — a
handful of warm-up "insufficient type feedback" eager deopts, no loops.
Inlining (`--inlining`): `encodeQueue` inlines the whole per-field chain
(`encodeSchemaOps → schemaFieldOp → emitSchemaOp → readSchemaValue`) but never
`writeNumber` (indirect call). Shapes (`--shapes`): the "numeric-keyed refId
tables fall into dictionary mode after `delete`" hypothesis is **false** on
this V8 — `Root.changeTrees`, `refCount`, decoder `refCount` / `callbacks`
stay fast holey elements after 300 churn ticks; all ChangeTrees share one map;
tracked and decoder-built instances of one class do not.

## 4. Experiments

Each: implement → `npm test` green → freeze → `--compare` N = 20 against the
previous label. Accept at p < 0.05 and |Δ| ≥ 2 % with bytes unchanged
(code-level changes) — bytes change on purpose for the two wire changes.

### x1 — per-view dirty lists (`Encoder._prepareTick` / `_encodeViewBody`)

`_prepareTick` fans each dirty filtered tree out over its `visibleViews`
bitmap into per-view index lists; a view's pass walks its own list (merged
with the rare parent-inherited-visibility trees) instead of all dirty trees.
Bytes identical.

| unit | v6-wip | x1 | Δ |
|---|---|---|---|
| entities-aoi/n500-c10 | 0.173 ms | 0.153 ms | −12 % |
| entities-aoi/n2000-c50 | 1.632 ms | 1.239 ms | **−24 %** |
| entities-aoi/n2000-c50-typed | 1.669 ms | 1.212 ms | −27 % |
| entities-aoi/n2000-c50-numkeys | 1.670 ms | 1.242 ms | −26 % |
| entities-aoi/n2000-c50-nested | 3.608 ms | 3.376 ms | −6 % |
| entities-aoi-large/n10000-c200 | 41.4 ms | 23.6 ms | **−43 %** |
| entities-aoi-large/n10000-c200-move20 | 5.01 ms | 3.27 ms | −35 % |
| mmo-shards/enc-c100 | 0.159 ms | 0.142 ms | −11 % |
| mmo-shards/enc-c500 | 0.404 ms | 0.304 ms | −25 % |
| stateview/views/v100heavy | 0.121 ms | 0.083 ms | −31 % |
| stateview/views/v50 | 29.4 µs | 28.5 µs | −3 % |
| stateview/views/v1 | 9.27 µs | 9.71 µs | +5 % |
| stateview/tags | 33.4 µs | 35.1 µs | +5 % |
| small-patch/root-field-50views | 10.8 µs | 13.2 µs | **+22 %** |
| e2e/room-tick, stateview/bootstrap, view-churn, array-reindex | | | 0 (p > 0.05) |

Accepted: the large wins are the point of the change; the +50 ns per idle
view (the `_encodeViewBody` body grew and inlining shifted) is addressed by
x5's idle fast path.

### x2 — decoder per-ref record + direct primitive slots

`refInfoOf(ref)` caches `{ kind, DecodeInfo, $values array, child/key readers }`
on the ref's `$changes` tree (one megamorphic load per chunk instead of four);
primitive slots behind the generated accessor are read/written as
`values[index]` (`DecodeInfo.direct`; `{ manual: true }` fields keep the named
path); quantized child readers are resolved once per ref. Bytes identical.

| unit | x1 | x2 | Δ |
|---|---|---|---|
| large-patch/dec-5k | 3.296 ms | 0.636 ms | **−81 %** |
| large-patch/dec-5k-typed | 3.285 ms | 0.616 ms | **−81 %** |
| big-state/decode-10k | 51.8 ms | 19.6 ms | **−62 %** |
| big-state/decode-20k | 95.3 ms | 41.2 ms | −57 % |
| big-state/decode-10k-callbacks | 67.1 ms | 46.2 ms | −31 % |
| small-patch/dec-one-entity | 0.506 µs | 0.203 µs | −60 % |
| decoder/deep-nested | 33.8 µs | 7.15 µs | **−79 %** |
| decoder/bootstrap | 3.69 ms | 3.23 ms | −12 % |
| decoder/churn | 50.6 µs | 44.1 µs | −13 % |
| decoder/map-bootstrap/players-str / -num | 2.50 / 2.36 ms | 1.94 / 1.64 ms | −22 % / −30 % |
| callbacks/strategies raw / state / legacy | 0.517 / 0.590 / 0.579 ms | 0.148 / 0.242 / 0.239 ms | **−71 % / −59 % / −59 %** |
| callbacks/density none / sparse / dense | 0.502 / 0.506 / 0.590 ms | 0.160 / 0.154 / 0.245 ms | −68 % / −70 % / −59 % |
| callbacks/add-remove-churn | 56.9 µs | 53.6 µs | −6 % |
| turn-based/broadcast-1000 | 607 µs | 391 µs | −36 % |
| e2e/room-tick | 45.7 µs | 43.5 µs | −5 % |
| entities-aoi-decode n2000 / n2000-callbacks / n10000 | 14.1 / 26.4 / 64.0 µs | 14.8 / 27.6 / 71.1 µs | **+5 % / +4 % (p .18) / +11 %** — many 3-field chunks: the per-chunk record lookup outweighs the slot saving; addressed in x8 and moot once runs (x7) merge those chunks |
| inventory-rpg/dec, lobby-chat/*, callbacks/map-churn, turn-based/broadcast-100 | | | 0 (p > 0.05) |
| decoder/array-read index / for-of / forEach / length+at | 5.09 / 9.17 / 5.95 / 0.99 µs | 5.30 / 9.47 / 6.21 / 1.04 µs | +3…+4 % (client-side array walks; no decode code on that path — code layout) |

### x3 — setters through one `this[$changes]` load

`ChangeTree` / `UntrackedChangeTree` cache the instance's `$values` array
(`tree.values`, assigned before the tree is installed); the four generated
setters read `tree.values` and call `tree.change()` / `tree.delete()` directly
(the internal `static [$track]` hook is no longer consulted). Bytes identical.

| unit | x2 | x3 | Δ |
|---|---|---|---|
| entities-aoi/n2000-c50 / -typed / -numkeys | 1.219 / 1.124 / 1.201 ms | 1.174 / 1.065 / 1.143 ms | −4 % / −5 % / −5 % |
| entities-aoi/n2000-c50-nested | 3.247 ms | 3.319 ms | +2 % |
| small-patch/root-field / one-entity | 0.288 / 0.348 µs | 0.284 / 0.342 µs | −1 % / −2 % |
| encoder/deep-nested | 7.90 ms | 7.64 ms | −3 % |
| large-patch/enc-* (4 variants), inventory-rpg/enc, lobby-chat/enc, mmo-shards/enc-c100, encoder/* (rest) | | | 0 (p > 0.05 or |Δ| < 2 %) |

Kept for the simpler setter, but the lesson is that the profile's 38 % "setter"
self time is the change-tracking bookkeeping (`change → record → enqueue`)
that the closure inlines, not the megamorphic property loads — V8's stub
cache serves those in a few ns. The remaining per-set cost is structural.

### x4 — direct `number` / `string` writer and reader calls

`emitSchemaOp` / `writeValue` / the decoder fast path branched on the type
name (internalized string, a pointer compare) and called `writeNumber` /
`writeString` / `decode.number` / `readString` directly; other primitives kept
the function slot. Bytes identical.

| unit | x3 | x4 | Δ |
|---|---|---|---|
| large-patch/enc-5k (`number`) | 0.839 ms | 0.839 ms | 0 |
| large-patch/enc-5k-typed (float32) | 0.722 ms | 0.753 ms | **+4 %** |
| large-patch/enc-5k-quantized | 0.993 ms | 1.052 ms | **+6 %** |
| large-patch/dec-5k | 0.621 ms | 0.584 ms | −6 % |
| large-patch/dec-5k-typed | 0.593 ms | 0.643 ms | **+9 %** |
| entities-aoi/n2000-c50-typed | 1.063 ms | 1.096 ms | +3 % |
| inventory-rpg/enc / dec | 39.3 / 36.0 µs | 40.7 / 36.7 µs | +4 % / +2 % |
| big-state/encode-10k / encode-20k | 3.80 / 7.96 ms | 3.91 / 8.21 ms | +3 % / +3 % |
| big-state/decode-10k / decode-20k | 18.5 / 38.3 ms | 19.1 / 40.0 ms | +4 % / +5 % |
| encoder/encode-all, encoder/heavy-tick | 3.11 ms / 0.576 ms | 3.23 ms / 0.588 ms | +4 % / +2 % |
| entities-aoi/n2000-c50 (+nested, numkeys), entities-aoi-decode/n2000-c1, lobby-chat/*, big-state/handshake, encoder/* (rest) | | | 0 |

**Rejected and reverted** (x8 carries the revert): the megamorphic function
slot costs less than two failed pointer compares in front of it — every
non-`number`/`string` field paid for the branch, and `number` itself gained
nothing on the encoder. V8's megamorphic call stub is not the bottleneck it
looked like in the inlining trace.

### x5 — allocation / idle fixes

Idle view fast path (nothing queued, none of its trees dirty → no pass setup,
the tick's shared slice object is reused by every client, an empty view
slice), `garbageCollectDeletedRefs` early exit + direct iteration, one shared
descriptor for the decoder's `$changes` install. Bytes identical.

| unit | x4 | x5 | Δ |
|---|---|---|---|
| small-patch/root-field-50views | 12.3 µs | 6.40 µs | **−48 %** (GC 10.6 → 1.2 ms; v5 = 14.5 µs) |
| mmo-shards/enc-c500 | 0.267 ms | 0.219 ms | −18 % |
| stateview/views/v50 | 26.0 µs | 23.9 µs | −8 % |
| big-state/decode-10k-callbacks | 41.4 ms | 40.5 ms | −2 % |
| stateview/views/v10 / v100heavy | 12.9 / 72.2 µs | 13.7 / 81.3 µs | **+6 % / +13 %** |
| stateview/array-reindex/shift-100 | 10.8 µs | 11.6 µs | +7 % |
| callbacks/add-remove-churn | 49.6 µs | 50.8 µs | +3 % |
| e2e/room-tick | 44.1 µs | 44.6 µs | +1 % |
| mmo-shards/enc-c100 / e2e-c20, big-state/decode-*, decoder/churn, inventory-rpg/dec, lobby-chat/dec, entities-aoi/*, entities-aoi-large/*, stateview (rest) | | | 0 |

The active-view regressions (v10, v100heavy: every view has work every
tick, so the idle check is pure overhead — but 90 ns per view is more than
the check itself) point at `_encodeViewBody` growing past an inlining
threshold; x7 restructures that function again and the final full-matrix
compare below is the verdict for `stateview/*`.

### x6 — wire: chunk header refId delta (W2a)

`uvarint(refId*2+1)` for the first chunk of a slice, `uvarint(zigzag(Δ)*2)`
after it (`SPEC.md`). Realized on x6 (`wire-whatif --delta`): large-patch
137 120 → 132 222 B (−3.6 %), AOI view slice 3 386 → 3 254 (−3.9 %), RPG
3 256 → 3 054 (−6.2 %), shard shared 7 807 → 7 320 (−6.2 %).

| unit | x5 | x6 | Δ time | bytes x5 → x6 |
|---|---|---|---|---|
| large-patch/enc-5k / -typed / -nested | 0.839 / 0.732 / 1.109 ms | 0.878 / 0.775 / 1.167 ms | **+5 % / +6 % / +5 %** | 137 264 → 132 389 (−3.6 %) |
| large-patch/dec-5k / -typed | 0.579 / 0.635 ms | 0.592 / 0.647 ms | +2 % / +2 % | |
| entities-aoi/n2000-c50 / -numkeys | 1.163 / 1.154 ms | 1.187 / 1.180 ms | +2 % / +2 % | 167 972 → 161 205 (−4.0 %) |
| mmo-shards/enc-c100 | 0.121 ms | 0.121 ms | 0 | 783 923 → 735 189 (−6.2 %) |
| inventory-rpg/enc / dec / callbacks | | | 0 | 3 294 → 3 096 (−6.0 %) |
| encoder/heavy-tick | 0.595 ms | 0.593 ms | 0 | 17 770 → 15 854 (−10.8 %) |
| stateview/views v1 / v10 / v50 / v100heavy | | | 0 | 365 → 368, 2 404 → 2 425, 11 424 → 11 525 (+0.9 %): scattered refIds in small slices pay the absolute-header bit |
| lobby-chat/enc, small-patch/*, encoder/* (rest), decoder/tick, decoder/bootstrap | | | 0 | |

The header arithmetic (`prevRefId` load/store, zigzag, branch) costs about
8 ns per chunk on a 5000-chunk patch — visible as +5 % before runs collapse
those chunks (x7). On its own W2a is a bandwidth-for-CPU trade on bulk
patches and a wash on small slices.

### x7 — wire: same-shape runs (W2b)

Length prefix `uvarint(byteLen*2 + flag)`; a flagged chunk is a run:
`typeId mask64 extra values { zigzag(Δ) values }×extra` over consecutive dirty
Schemas of one class with the same primitive dirty set (all ADD). Detected in
the shared queue walk and in each view's work list. Realized on x7:
large-patch 132 222 → 107 229 B (**−18.9 %**, one run of 5000), AOI view slice
3 254 → 2 627 (−19.3 %), RPG 3 054 → 2 464 (−19.3 %), shard shared 7 320 →
6 033 (−17.6 %, 432 of 500 players in runs; the rest also touched a tagged or
extra field).

| unit | x6 | x7 | Δ time | bytes x6 → x7 |
|---|---|---|---|---|
| large-patch/enc-5k / -typed / -quantized | 0.882 / 0.769 / 1.059 ms | 0.780 / 0.678 / 0.994 ms | **−12 % / −12 % / −6 %** | 132 389 → 107 396 (−18.9 %), 110 000 → 85 007 (−22.7 %), 69 787 → 45 497 (−34.8 %) |
| large-patch/dec-5k / -typed | 0.594 / 0.648 ms | 0.550 / 0.597 ms | −7 % / −8 % | |
| entities-aoi/n2000-c50 / -typed / -numkeys | 1.188 / 1.120 / 1.172 ms | 1.080 / 1.007 / 1.067 ms | **−9 % / −10 % / −9 %** | 161 205 → 130 126 (−19.3 %) |
| mmo-shards/enc-c100 / e2e-c20 | 0.120 / 1.314 ms | 0.112 / 1.202 ms | −7 % / −9 % | 735 189 → 600 297 (−18.3 %) |
| inventory-rpg/enc / dec | 40.1 / 36.5 µs | 37.2 / 35.5 µs | −7 % / −3 % | 3 096 → 2 514 (−18.8 %) |
| lobby-chat/enc | 7.80 µs | 7.36 µs | −6 % | 218 → 181 (−17 %) |
| small-patch/five-entities | 0.894 µs | 0.875 µs | −2 % | 74 → 63 |
| large-patch/enc-5k-nested, entities-aoi/n2000-c50-nested | 1.162 / 3.374 ms | 1.267 / 3.752 ms | **+9 % / +11 %** | ≈ unchanged (Vec2 and Entity trees interleave: no run forms) |
| encoder/heavy-tick | 0.591 ms | 0.634 ms | **+7 %** | unchanged (same interleaving) |
| small-patch/root-field / one-entity | 0.286 / 0.341 µs | 0.297 / 0.360 µs | +4 % / +6 % | |
| entities-aoi-decode/n2000-c1 (+callbacks) | 13.1 / 26.7 µs | 13.1 / 27.7 µs | 0 / +4 % | 1 576 → 1 265 (−19.7 %) |
| encoder/* (rest), mmo-shards/enc-c500, inventory-rpg/callbacks | | | 0 | |

The interleaved-class regressions came from evaluating the eligibility loop
and a `TypeContext.getTypeId` map lookup on every candidate tree even when
the next tree is a different class; x8 peeks at the next tree's descriptor
and dirty mask first and looks the typeId up only once a run exists. Tests:
`test/RunOps.test.ts` (7 cases: shape, size, break conditions, callbacks with
previous values, unknown member skip, long runs, per-view runs).

### x8 — handshake buffer + per-chunk trims

`--cpu` on `big-state/handshake` (v6 3× slower than v5): 48 % GC, 18 % in the
`Encoder` field initializer — `Reflection.encode` built a throwaway `Encoder`
whose constructor allocated a full `Encoder.BUFFER_SIZE` buffer (16 MB in a
big-state room) for a 512-byte payload, once per client join. The `Encoder`
constructor now takes a `bufferSize` and the reflection encoder reuses one
64 KB module buffer. Also: `refInfoOf` split into an inlinable fast path and
bit-op header math in the chunk loop (x2's per-chunk cost had grown; visible
as +5…+11 % on the many-small-chunk `entities-aoi-decode` frames).

| unit | x7 | x8 | Δ |
|---|---|---|---|
| big-state/handshake | 1.380 ms | 0.262 ms | **−81 %** (GC 799 → 15 ms/sample); v5 = 0.467 ms |
| large-patch/enc-5k-nested / -quantized | 1.276 / 0.987 ms | 1.134 / 0.915 ms | −11 % / −7 % (run-detection peek; typed-dispatch revert) |
| large-patch/dec-5k / -typed | 0.553 / 0.589 ms | 0.508 / 0.490 ms | −8 % / **−17 %** |
| entities-aoi-decode n2000 / -callbacks / n10000 | 13.4 / 27.7 / 68.7 µs | 12.5 / 26.8 / 65.4 µs | −7 % / −3 % / −5 % |
| e2e/room-tick, stateview/bootstrap, inventory-rpg/callbacks | 45.8 µs / 2.18 ms / 57.2 µs | 43.7 µs / 2.10 ms / 55.5 µs | −5 % / −4 % / −3 % |
| large-patch/enc-5k / -typed, decoder/*, inventory-rpg/enc / dec | | | 0 (decoder/bootstrap +1 %) |

### x9 — `_emitViewTrees` split out of `_encodeViewBody`

Every step that grew `_encodeViewBody` (x1, x5, x7) cost the active-view
units 3–13 %; the per-tree loop (runs, chunk cache, plain chunks) is now its
own method. Result: neutral — `stateview/views/v50` −5 %, `v1` / `v10` /
`v100heavy` +2 %, everything else 0 (`bench/results/x9-*.json`). The
"function outgrew its optimization budget" theory was wrong; the active-view
cost turned out to be the GC churn fixed in x10. Kept for readability.

### x10 — scratch arrays keep their backing store

`--cpu` on `stateview/tags` (+22 % over the round, minor GCs 100 → 259 per
sample): the per-tick resets used `array.length = 0`, which makes V8 drop the
backing store, so every per-view work list, the tree list and the run scratch
were reallocated and regrown each tick. Explicit length counters replace the
truncation (stale tree references past the count are nulled, not trimmed).
Formal results (N = 20, x9 → x10, `bench/results/x10-*.json`):

| unit | x9 | x10 | Δ |
|---|---|---|---|
| stateview/views v1 / v10 / v50 / v100heavy | 8.46 / 14.4 / 25.4 / 89.6 µs | 7.46 / 12.3 / 19.9 / 75.2 µs | **−12 % / −15 % / −22 % / −16 %** (GC per sample → 0) |
| stateview/tags | 36.7 µs | 34.3 µs | −7 % (GC 1.51 → 0.41 ms) |
| stateview/array-reindex shift-100 / shift-1000 | 11.6 / 16.1 µs | 11.2 / 15.5 µs | −3 % / −3 % |
| small-patch/root-field-50views | 6.46 µs | 4.27 µs | **−34 %** |
| entities-aoi n500 / n2000 / -nested / -typed / -numkeys | 0.107 / 1.054 / 3.540 / 0.972 / 1.039 ms | 0.101 / 0.990 / 3.370 / 0.912 / 0.982 ms | −6 % / −6 % / −5 % / −6 % / −6 % (GC halved) |
| entities-aoi-large n10000-c200 / -move20 | 20.4 / 3.41 ms | 18.7 / 3.21 ms | −9 % / −6 % (GC 98 → 28 ms) |
| mmo-shards enc-c100 / enc-c500 | 0.110 / 0.212 ms | 0.106 / 0.189 ms | −4 % / −11 % |
| e2e/room-tick | 44.2 µs | 42.2 µs | −5 % |
| stateview/bootstrap, view-churn, pop-1000, mmo e2e-c20, idle-50views | | | 0 |

No regressions. This closes every active-view row that had drifted up
during the round: against `v6-wip`, `stateview/views` v1 / v10 / v50 /
v100heavy are now −20 % / −18 % / −32 % / −38 %, `tags` is back to +14 %
(30.1 → 34.3 µs; the remaining gap is the per-view drain of tagged fields, see
§6). **The final build is `x10-noshrink` (= the working tree).** The
v5-vs-final sweep in §4b was run on x8; x9 and x10 add the rows above on top
of it.

## 4b. Final: v5.0.31 vs the end of the round (`x8-handshake`)

Same harness, N = 20, run after all experiments landed (`bench/results/final-v5-vs-x8-*.json`).

| unit | v5.0.31 | final | Δ time | bytes v5 → final |
|---|---|---|---|---|
| small-patch/root-field | 0.193 µs | 0.280 µs | **+45 %** | 5 → 7 |
| small-patch/one-entity | 0.274 µs | 0.342 µs | **+25 %** | 16 → 15 |
| small-patch/five-entities | 0.937 µs | 0.888 µs | −5 % | 82 → 63 |
| small-patch/root-field-50views | 14.5 µs | 6.56 µs | −55 % | |
| small-patch/dec-one-entity | 0.567 µs | 0.145 µs | −74 % | |
| large-patch/enc-5k / -typed / -nested / -quantized | 1.089 / 0.986 / 1.349 / 1.257 ms | 0.789 / 0.674 / 1.121 / 0.918 ms | −28 % / −32 % / −17 % / −27 % | 142 011 → 107 396 (−24 %), 119 622 → 85 007 (−29 %), 79 409 → 45 497 (−43 %) |
| large-patch/dec-5k / -typed | 3.564 / 3.515 ms | 0.510 / 0.489 ms | **−86 % / −86 %** | |
| entities-aoi/n500-c10 | 0.177 ms | 0.108 ms | −39 % | 8 746 → 6 734 (−23 %) |
| entities-aoi/n2000-c50 / -typed / -numkeys | 1.995 / 1.847 / 2.001 ms | 1.051 / 0.963 / 1.046 ms | **−47 % / −48 % / −48 %** | 175 164 → 130 126 (−26 %) |
| entities-aoi/n2000-c50-nested | 3.938 ms | 3.569 ms | −9 % | 206 250 → 177 993 (−14 %) |
| entities-aoi-large/n10000-c200 / -move20 | 49.6 / 7.77 ms | 20.4 / 3.37 ms | **−59 % / −57 %** | 3 556 063 → 2 620 123 (−26 %) |
| entities-aoi-decode/n2000-c1 / -callbacks / n10000-c1 | 23.2 / 36.0 / 128 µs | 12.3 / 26.7 / 64.0 µs | −47 % / −26 % / −50 % | 1 693 → 1 265 (−25 %) |
| lobby-chat/enc / dec / callbacks | 7.93 / 7.49 / 11.6 µs | 7.43 / 6.08 / 10.1 µs | −6 % / −19 % / −13 % | 227 → 181 (−20 %) |
| inventory-rpg/enc / dec / callbacks | 46.2 / 60.0 / 81.7 µs | 36.9 / 35.2 / 55.3 µs | −20 % / −41 % / −32 % | 3 536 → 2 514 (−29 %) |
| turn-based/enc | 0.903 µs | 0.997 µs | **+10 %** | 12 = 12 |
| turn-based/broadcast-100 / -1000 | 60.7 / 1 522 µs | 18.9 / 275 µs | **−69 % / −82 %** | 1 212 → 1 199 |
| mmo-shards/enc-c100 / enc-c500 / e2e-c20 | 0.779 / 3.301 / 2.432 ms | 0.113 / 0.224 / 1.138 ms | **−86 % / −93 % / −53 %** | 831 361 → 600 297 (−28 %) |
| big-state/encode-10k / -20k | 8.01 / 16.2 ms | 3.84 / 8.00 ms | −52 % / −51 % | 654 490 → 510 757 (−22 %) |
| big-state/decode-10k / -20k / -10k-callbacks | 46.9 / 93.6 / 62.8 ms | 18.6 / 38.6 / 38.2 ms | **−60 % / −59 % / −39 %** | |
| big-state/handshake | 0.467 ms | 0.262 ms | −44 % | 685 → 512 |

Full existing matrix, `v6-wip` → final (N = 12, `bench/results/final-v6wip-vs-x8-*.json`):

| group | moved |
|---|---|
| decoder | `tick` −78 %, `deep-nested` −80 %, `bootstrap` −10 %, `churn` −13 %, `map-bootstrap/players` −20 %, `resync/full` / `churn` −19 % / −17 %; `map-replace/num-100pct` +3 %, `array-read` for-of / filter / length+at +1…+3 % |
| callbacks | `strategies` −60…−74 %, `density` −60…−71 %, `add-remove-churn` −8 %, `map-churn/str` −3 % |
| encoder | `matrix/patch100pct` −23 % / −14 %, `patch10pct` −9 %, `steady-tick/mut100` −10 %, `string-heavy` −9 %; full syncs and map ops 0; **`memory-footprint` +8.5 % (2 411 → 2 615 KB retained per 1000 entities)** — two new `ChangeTree` fields (`values`, `decodeInfo`) pushed the tree past its in-object slot count |
| stateview | `views/v100heavy` −24 %, `v1` −7 %, `v50` −3 %; **`tags` +22 %** (30.1 → 36.6 µs, GC 0.6 → 1.5 ms), `array-reindex/shift-100` +5 % |
| mutations, e2e | 0 (`array-iterate/forEach` −3 %, `map-ops/forEach-str` +2 %) |

What is left on the table: the three sub-microsecond ticks pay v6's fixed
per-pass cost (about 0.07–0.1 µs: pass frame setup, generation stamps,
recorder reset) — irrelevant next to a 16 ms tick budget but real; and GC
time per tick is higher on AOI rooms (the per-view work lists and run scratch
arrays are reused, so the growth is in the view slices' `subarray` objects
and the change-list nodes of many small views).

## 5. Bandwidth guidance that needs no format change

From `wire-whatif` on the v6 frames (values are 72–77 % of a patch):

| choice | effect on position-heavy patches |
|---|---|
| `"number"` fractional (0xca + f32 = 5 B) → `float32` (4 B) | −16 % (`large-patch/enc-5k` 137 KB → 115 KB) |
| `"number"` → `t.quantized({ min, max, bits: 16 })` (2 B) | −45 % (→ 75 KB); `t.angle()` for rotations |
| `hp: "number"` → `int16`, `kind` → `uint8` | 1–2 B each vs 1–5 B |
| numeric map keys (`{ map: Entity, key: "number" }`) | no change on patches (keys ride on ADD only) |

The `entities-aoi/*-typed` and `large-patch/*-typed` rows quantify it end to
end (−16 % bytes, and 5–10 % faster encode because float32 skips the
msgpack-style tag choice).

## 6. Where v6 still loses to v5

Measured on the final build against v5.0.31 and written up with causes,
source pointers and suggested experiments in **`bench/v6-open-gaps.md`**:
the sub-microsecond ticks (+12…+49 %, a fixed ~0.1 µs per pass),
`stateview/tags` (+20 %), the ArraySchema iteration / `shift` paths
inherited from the collections rewrite (up to +165 %), `encoder/string-heavy`
(+4 %) and retained memory per entity (+6 %, n.s.).

## 7. Not done / rejected

- Dense refId tables instead of `delete` on plain objects: refuted by `--shapes`.
- `hasPendingChange` O(n²): not observed in the big-state callback bootstrap.
- `growSharedBuffer` growth policy: overflow re-encodes once per size step and
  keeps the bigger buffer; fine. Note that with many views the shared buffer
  must hold the shared frame plus every view slice of the tick (the server
  passes one `it` to every `encodeView`) — `entities-aoi-large` needs 64 MB.
- Runs over fields ≥ 32, over `@view`-tagged fields in a view slice, and
  string-table snapshots: possible follow-ups, not measured.
- Other-language decoders (C#, Lua, Haxe, …) must implement the two header
  changes; the JS decoder and `SPEC.md` are the reference.

## Round 2

Second round on the gaps of `bench/v6-open-gaps.md` (2026-09-15), run by four
agents in parallel worktrees of the round-2 base snapshot: `bench/.builds/base`
= the working tree at the start of the round (= `x10-noshrink`),
`bench/.builds/v5-release` = master 5.0.31. Same harness and acceptance rules
as §4 (N = 20 per side, ABBA, Mann-Whitney U; accept at p < 0.05 and |Δ| ≥ 2 %
with bytes unchanged and no guard row regressing > 2 % at p < 0.05). Each agent
stacks its labels on its previous accepted one (`A1-…`, `B1-…`, …); the main
session then applied the accepted diffs one at a time (`M1-B`, `M2-AB`,
`M3-ABC`, `M4-ABCD`) and re-ran each agent's targets on the merged build (§ "Merge
verification" below). Raw rows: `bench/results/{A,B,C,D}*.json` in the agent
worktrees, `bench/results/M*.json` here.

### Round 2 — A: tiny-tick fixed cost (`small-patch/root-field`, `one-entity`, `turn-based/enc`)

Profile before (`profile.mjs --cpu realworld/small-patch/root-field --interval 100 --build bench/.builds/base`,
self time): `encode` 22.7 %, `releaseFrames` 10.9 % self / **21.4 % total**,
the scenario's `run` 10.4 %, the field setter 6.3 %, `schemaFieldOp` 5.2 %,
`_beginPass` 2.7 %, `encodeQueue` 1.9 %, `writeNumber` 1.9 %, `enterFrame`
1.6 %, `frameAt` 1.4 %. `releaseFrames`' total was twice its self time: the
other half is the `Array.prototype.length` setter runtime call behind
`f.vals.length = 0; f.strs.length = 0`, executed twice per tick even when no
body was written.

#### A1 — `releaseFrames` scratch high-water marks (`src/encoder/EncodeOperation.ts`)

Hypothesis: the two `length = 0` truncations per frame cost a runtime call
each (plus the backing-store drop x10 removed elsewhere); a one-chunk tick
writes no body scratch, so it should pay nothing. Change: `Frame.valsLen` /
`Frame.strsLen` high-water marks raised by every body writer (`noteScratch`:
sequential `n` for map / indexed / identity bodies, `32 - clz32(maskLow)` or
64 for field-indexed Schema bodies); `releaseFrames` nulls exactly that range
(out of line, only for frames with `valsLen !== 0`) and never truncates.
Bytes identical.

| unit | base | A1 | Δ | p |
|---|---|---|---|---|
| small-patch/root-field | 0.302 µs | 0.202 µs | **−33 %** | <.001 |
| small-patch/one-entity | 0.362 µs | 0.259 µs | **−28 %** | <.001 |
| small-patch/five-entities | 0.930 µs | 0.822 µs | −12 % | <.001 |
| small-patch/root-field-50views | 4.61 µs | 4.37 µs | −5 % | <.001 |
| small-patch/idle-50views / dec-one-entity | 0.134 / 0.138 µs | 0.133 / 0.135 µs | 0 | .34 / .70 |
| turn-based/enc | 1.063 µs | 0.952 µs | **−10.5 %** | <.001 |
| large-patch/enc-5k / -typed / -nested / -quantized, dec-5k / -typed | | | +0.4…+0.8 % | all p > 0.27 |
| stateview/views v1 / v10 / v50 / v100heavy | 7.43 / 12.3 / 20.1 / 75.4 µs | 7.36 / 12.2 / 19.5 / 74.3 µs | −1 % / −1 % / −3 % / −1.5 % | .16 / .018 / .010 / .08 |
| big-state/encode-10k | 3.873 ms | 3.610 ms | −6.8 % (GC 2.94 → 1.63 ms) | <.001 |
| entities-aoi/n500-c10 | 0.107 ms | 0.104 ms | −3 % | .26 |
| encoder/map-encode-all scores-str-10000 / scores-num-10000 | 0.791 / 0.433 ms | 0.700 / 0.402 ms | **−11.5 % / −7.3 %** (GC −40 %) | <.001 |
| encoder/steady-tick mut10 / mut100 | 1.825 / 13.77 µs | 1.677 / 13.29 µs | −8 % / −3.5 % | <.001 / .050 |
| encoder/map-churn str-100 / str-1000 / num-1000, entity-churn | | | −2…−3 % | < .03 |
| encoder/encode-all, matrix/full-*, map-encode-all/players-* | | | 0 time, GC −40 % (`≈ gc-only`) | |
| encoder/* (rest: array-churn, construct, deep-nested, heavy-tick, map-replace/*, matrix/patch*, string-heavy, memory-footprint) | | | −2…+1.2 % | p > 0.05 |

Accepted. No row regressed; the body-writing units (full syncs, map
snapshots) gain from the scratch arrays keeping their backing store between
ticks, exactly the x10 effect.

#### A2 — `_beginPass` slimming (rejected)

Hypothesis: `passFrame()` → `frameAt(0)` (the lazy-create branch, 1.4 % self
in the profile) and the two `++this._gen` read-modify-writes are measurable
on a one-chunk tick. Change: frame 0 created at module load so `passFrame`
is a plain element load; one counter update per pass; `this.root` hoisted.

| unit | A1 | A2 | Δ | p |
|---|---|---|---|---|
| small-patch/root-field | 0.199 µs | 0.195 µs | −1.8 % | .068 |
| small-patch/one-entity / five-entities | 0.236 / 0.831 µs | 0.238 / 0.817 µs | +0.8 % / −1.7 % | .74 / .35 |
| small-patch/root-field-50views / idle-50views / dec-one-entity | | | +0.2 % / +1.2 % / +0.1 % | > .35 |
| turn-based/enc | 0.940 µs | 0.946 µs | +0.6 % | .90 |

Reverted: below the 2 % / p < 0.05 bar on every target. TurboFan already
inlines `frameAt(0)` with the create branch cold, and the eleven stores are
the floor of a pass, not the accounting around them.

#### A3 — Schema-only `enterFrame` (rejected)

Hypothesis: for a Schema chunk `enterFrame` spends a megamorphic
`refTarget[$childType]` load, `childWriterOf(undefined)` and the `KIND_MAP`
key-writer branch on slots the Schema paths never read. Change: branch on
`desc.kind === KIND_SCHEMA` right after the common stores, clear the five
collection slots and read `f.values` from `tree.values` (the monomorphic
cache x3 added) instead of `refTarget[$values]`; the collection half moved
to an out-of-line `enterCollectionFrame`.

| unit | A1 | A3 | Δ | p |
|---|---|---|---|---|
| small-patch/root-field (N = 20) | 0.198 µs | 0.189 µs | −4.4 % | .076 |
| small-patch/root-field (replication, N = 30) | 0.204 µs | 0.203 µs | −0.9 % | .54 |
| small-patch/one-entity / five-entities | 0.243 / 0.777 µs | 0.243 / 0.779 µs | +0.1 % / +0.3 % | .74 / .84 |
| small-patch/root-field-50views / idle-50views / dec-one-entity | | | 0 | > .39 |
| turn-based/enc | 0.939 µs | 0.920 µs | −2.1 % | .17 |

Reverted: the first run's −4.4 % did not replicate. The two symbol loads
are served by V8's stub cache in a few ns and the stores are the same count
either way; `enterFrame` is 1.6 % of a one-chunk tick and nothing in it is
skippable beyond that.

#### A4 — `discardChanges` → `discardQueue` → `endEncode` (nothing to change)

Read for per-tree work a one-tree tick could skip: `discardQueue` is one
`endEncode()` (`_isSchema` test, `reset()` = two dirty-word stores plus
`opsLow`/`opsHigh` for ≤ 8-field classes or `ops.fill(0)` above that,
`changesNode = undefined`, `isNew = false`) and one `releaseNode` (three
stores + pool push) per queued tree, then two list stores — the same loop
v5's `discardChanges` runs. `_tickPrepared = false` is one store. The only
per-tick cost that was not per-tree was `releaseFrames`, closed by A1 (its
share of `discardChanges` was 21.4 % of the tick before, see the profile
after A1 below). No candidate left here for the target shapes (`State` has
4 fields, `Entity` 8: both on the packed `opsLow`/`opsHigh` path).

#### Profile after A1 (`--interval 100`, `--build bench/.builds/A1-frames`, 0.197 µs/tick sampled)

Self time: `encode` 16.0 % (the pass entry: default args, the two `Set.size`
reads and the returned `subarray`), the scenario's `run` 14.8 %,
`encodeQueue` 14.4 %, `_beginPass` 10.2 %, the field setter 8.0 %,
`writeNumber` 3.6 %, `openChunk` 3.2 %, `enterFrame` 0.7 %, `discardChanges`
+ `discardQueue` 0.7 %, `releaseFrames` gone. v5 on the same unit (0.199 µs):
`_encodeChannel` 34.2 %, `run` 11.3 %, `forEachWithCtx` 6.6 %, the setter
6.0 %, `enqueueChangeTree` 3.8 %, `number` 2.7 %. Both ticks are now ~0.2 µs;
what is left on v6 is the pass setup (`_beginPass`'s eleven stores, measured
unshrinkable in A2) and the 7-vs-5-byte chunk framing.

#### A — final: v5.0.31 vs the accepted stack (`A1-frames`), N = 20

| unit | v5.0.31 | A1 | Δ | p | bytes v5 → v6 |
|---|---|---|---|---|---|
| small-patch/root-field | 0.208 µs | 0.209 µs | +0.8 % (was **+49 %**) | .82 | 5 → 7 |
| small-patch/one-entity | 0.299 µs | 0.259 µs | **−13 %** (was +20 %) | <.001 | 16 → 15 |
| small-patch/five-entities | 0.980 µs | 0.809 µs | **−17.5 %** (was −5 %) | <.001 | 82 → 63 |
| small-patch/root-field-50views | 14.64 µs | 4.24 µs | −71 % | <.001 | |
| small-patch/idle-50views | 0.136 µs | 0.139 µs | +2.3 % (was +3 %; path untouched by A1) | .047 | 0 |
| small-patch/dec-one-entity | 0.525 µs | 0.137 µs | −74 % | <.001 | 14 = 14 |
| turn-based/enc | 0.947 µs | 0.904 µs | **−4.6 %** (was +12 %) | .029 | 12 = 12 |

Verdict: the tiny-tick gap is closed — `one-entity` and `turn-based/enc`
now beat v5, `root-field` is at parity (p = 0.82). The cause was one line
(`length = 0` on two scratch arrays, two runtime calls per tick), not the
pass structure; the structural candidates (A2, A3) measured neutral. What
remains is §1 of `bench/v6-open-gaps.md`: the 2 extra framing bytes on a
one-field patch and an idle-tick row within noise of v5.

### Round 2 — B: `stateview/tags`

Target `stateview/tags/default` (10 views alternating `@view(1)` / `@view(2)`
on 100 players, 20 mutations per tick; +20 % vs v5 at the end of round 1).
Guards: `stateview/views/*`, `stateview/view-churn`, `e2e/room-tick`,
`realworld/mmo-shards/*`. Raw rows: `bench/results/B*.json`.

**Profile first** (`--cpu --interval 50` on `base`, line-level split of the
`.cpuprofile` `positionTicks`): `_emitViewTrees` 36 % self, `schemaFieldOp`
21 % self. Inside `_emitViewTrees` self time: `tagKey` → `hasTagOnTree`
(two `Map.get` per tree per view) 24 %, the `_cacheChunk` store (memcpy +
bookkeeping) 30 %, list build 5 %, run peek 5 %, `enterFrame` 6 %. Inside
`schemaFieldOp` self: the per-field `Schema[$filter]` → `hasTagOnTree` 47 %
and its `metadata[index]?.tag` lookup 17 %. The finding behind all of it:
the cross-view chunk cache had **one slot per tree** (`_cacheKey[i]`), and
the views' tag keys alternate 1, 2, 1, 2, … — so the cache never hit, every
view re-encoded, and every view still paid the store.

Informational row (the gap doc asked whether the memcpy pays at 10 views):
`base` vs the same build with `useCache = false` (`B0-nocache`) on the target:
35.9 → 22.2 µs, **−38 %** (p < .001). On this shape the single-slot cache was
pure overhead — ~13 µs per tick.

#### B1 — chunk cache keyed per (tree, tag key) (`B1-tagcache`)

Hypothesis: keep one cached chunk per distinct tag key seen on a tree this
tick (a per-tree chain of entries in flat arrays, reset per tick, no
allocation) so views 3…10 replay what views 1 and 2 encoded. Bytes identical.

| unit | base | B1 | Δ | p |
|---|---|---|---|---|
| stateview/tags/default | 34.4 µs | 19.9 µs | **−42.2 %** | < .001 |
| stateview/views v1 / v10 / v50 / v100heavy | 7.77 / 12.3 / 20.5 / 74.8 µs | 7.68 / 12.4 / 18.8 / 76.2 µs | −1.1 % / +0.7 % / **−8.2 %** / +1.9 % | .21 / .82 / < .001 / .040 |
| stateview/view-churn | 0.555 ms | 0.557 ms | +0.3 % | .47 |
| e2e/room-tick | 43.7 µs | 43.4 µs | −0.8 % | .82 |
| mmo-shards enc-c100 / enc-c500 / e2e-c20 | 0.116 / 0.200 / 1.170 ms | 0.115 / 0.199 / 1.140 ms | −1.1 % / −0.3 % / −2.5 % | .34 / .63 / .064 |

Accepted. `views/v100heavy` +1.9 % at p = 0.04 is under the 2 % bar (the
chain lookup is two loads instead of one on the all-default-tag shape);
`v50` −8 % is the same lookup landing better — both within what the
`stateview/views` rows drift between builds. New tests cover the behaviour
the cache now has to honour (`test/StateView.test.ts`, "cross-view chunk
cache with custom tags"): alternating tags across six views over three ticks,
and a tag swapped on a view between two passes of the same tick.

#### B2 — `tree.tagViews` as parallel arrays instead of a `Map` (`B2-tagscan`)

Hypothesis: after B1 the remaining per-(view, tree) cost is `tagKey`, two
`Map.get` per tree per view. A tree carries one to a few tag bits, so
`ChangeTree.tagBits: number[]` + `tagViews: number[][]` and a linear scan
replace the map; `StateView.tagsOnTree(tree)` returns the view's whole tag
mask in one pass, and the cache key is `tagsOnTree & desc.customTagMask`
(same value as before — the descriptor's `customTagBits` list became a mask).
`hasTagOnTree` / `addTag` / `removeTag` / `removeAllTagsOnTree` / dispose keep
their semantics. Bytes identical.

| unit | B1 | B2 | Δ | p |
|---|---|---|---|---|
| stateview/tags/default | 21.1 µs | 19.2 µs | **−9.0 %** | < .001 |
| stateview/views v1 / v10 / v50 / v100heavy | 8.04 / 12.6 / 20.6 / 77.2 µs | 8.00 / 12.7 / 19.7 / 76.5 µs | −0.4 % / +1.3 % / −4.1 % / −0.8 % | .74 / .19 / .22 / .22 |
| stateview/view-churn | 0.572 ms | 0.566 ms | −1.0 % | .90 |
| e2e/room-tick | 43.6 µs | 41.7 µs | −4.5 % | .014 |
| mmo-shards enc-c100 / enc-c500 / e2e-c20 | 0.108 / 0.196 / 1.172 ms | 0.107 / 0.192 / 1.204 ms | −0.2 % / −2.0 % / +2.7 % | .72 / .23 / .21 |

Accepted: the target clears the bar, no guard regresses at p < 0.05
(`mmo-shards/e2e-c20` +2.7 % is at p = 0.21; the same row read −2.5 % on
B1 → base). `tagKey` went from two `Map.get` per (view, tree) to one scan of
a two-element array.

#### B3 — stock `[$filter]` inlined against the descriptor's tag table — rejected

Hypothesis: `classFilterPasses` does the stock `Schema[$filter]` tag check
from `desc.tags[index]` instead of `metadata[index]?.tag`, for classes that
do not override `[$filter]` (a `stockFilter` descriptor flag). B2 → B3:
`stateview/tags` −1.3 % (p = 0.30), `stateview/views` v1 −2.8 % (p = 0.011),
v10 / v50 / v100heavy −1.5 / −1.7 / −0.8 % (n.s.), `mmo-shards` enc-c100 /
enc-c500 / e2e-c20 0 / +1.5 / +1.3 % (n.s.). After B1 only two of ten views
encode at all, so the per-field filter is off the hot path; below the bar
on the target, reverted (keeps `EncodeOperation.ts` untouched by this agent).

#### Final: `base` → B2 and v5.0.31 → B2

| unit | base | B2 (final) | Δ | p |
|---|---|---|---|---|
| stateview/tags/default | 35.4 µs | 18.6 µs | **−47.5 %** | < .001 |
| stateview/views v1 / v10 / v50 / v100heavy | 7.53 / 12.1 / 19.4 / 73.6 µs | 7.52 / 12.2 / 18.6 / 74.2 µs | −0.1 % / +0.3 % / **−4.1 %** / +0.8 % | .78 / .62 / .006 / .88 |
| stateview/view-churn | 0.624 ms | 0.597 ms | −4.3 % | .99 |
| e2e/room-tick | 49.7 µs | 51.2 µs | +2.9 % | .99 |
| mmo-shards enc-c100 / enc-c500 / e2e-c20 | 0.127 / 0.222 / 1.232 ms | 0.127 / 0.222 / 1.231 ms | −0.4 % / −0.3 % / −0.1 % | .82 / .95 / .63 |

| unit | v5.0.31 | B2 (final) | Δ | p |
|---|---|---|---|---|
| stateview/tags/default | 29.8 µs | 19.4 µs | **−34.9 %** | < .001 (GC 1.10 → 0.66 ms, p < .001) |

The `base` rows of the final sweep ran while the other agents' resumed
builds were loading the machine (absolute values 10–15 % above the earlier
sweeps, `view-churn` / `room-tick` at p ≈ 0.99); the verdicts stand on the
per-step compares above. The gap (+20 % vs v5 at the end of round 1) is now
**−35 %**: the row moves from `bench/v6-open-gaps.md` §2 to the wins.

Profile after (`B2-tagscan`, `--interval 50`): total sampled time 2092 →
1079 ms; `schemaFieldOp` self 21 % → 0 (two views encode, eight replay);
`_emitViewTrees` 40 % self, now the replay path — chain lookup + `copyBytes`
33 %, `tagsOnTree` 9 %, `isChangeTreeVisible` 7 %, run-eligibility peek 8 %,
list build 5 %. Each remaining item is ≤ 3 % of the tick.

Not done: a per-tick (tree → tag-key → chunk) map shared by all views is
what B1 is; caching `tagKey` across ticks would need invalidation on every
`addTag` / `removeTag` and buys at most the 9 % `tagsOnTree` line. Reordering
the run peek to test `tree.isFiltered` first (~3 %) was not measured.

### Round 2 — C: ArraySchema iteration and shift

Scope (`bench/v6-open-gaps.md` §3): `mutations/array-iterate/*`,
`decoder/array-read/*`, `mutations/array-refs/*`; guards
`encoder/array-churn`, `stateview/array-reindex/*`. The storage model
(`ArraySchema extends Array`) is untouched; every change is in
`src/types/custom/ArraySchema.ts`.

**What the profiles said first** (`--cpu --interval 100`, `--deopt`, `--ic`
on `base`; `%TEMP%\...\scratchpad\micro-array*.mjs` for the isolated loops):

- `shift-push`: `shift` is 75 % self time, `arrRemove` inlined into it; no
  deopts, no polymorphic or megamorphic IC on the slide. The slide loop over
  2000 refs costs 2.1–2.3 µs when the process allocates little, and 11 µs
  when it allocates ~1 KB per op (the same loop, timed alone with `hrtime`,
  garbage created outside the timed region). The per-element cost is V8's
  write-barrier slow path (remembered-set insert for young pointees and the
  marking barrier while incremental marking runs), not the loop: a JS store
  of a heap pointer into an old-space backing store cannot skip it, while
  v5's `splice` on a plain array moves the elements in C++ (`Heap::MoveRange`,
  one range barrier). Rebuilding the backing store young (`length = 0` +
  regrow, so that the stores hit a new-space page) was measured and is
  worse: 14.7 µs at 2000 elements against 2.2–11 µs in place (the regrow
  reallocations dominate; at 500 elements 2.6–3.7 vs 0.6–2.3 µs). The native
  mutators cannot be used on a subclass receiver: `Array.prototype.shift` /
  `splice` / `copyWithin` `.call(target)` take the generic per-property
  path (67–79 µs per call on 2000 elements).
- `indexOf`: the native `Array.prototype.indexOf` / `includes` on the
  subclass receiver reach V8's C++ runtime fallback and cost 3.7–4.0 µs on
  2000 refs against 0.9–1.2 µs for the JS loop (`lastIndexOf`: 60 µs, the
  Torque generic path). The shared `arrIndexOf` helper (also used by the
  decoder on every element kind) sees refs, Smis, doubles and strings through
  one `===` feedback slot, which ends up in the generic `StrictEqual` stub:
  3.4 µs on 2000 numbers against 1.4 µs for a loop with monomorphic
  feedback, 6.2 vs 2.0 µs on doubles, 7.7 vs 4.9 µs on strings.
- `forEach` / `map` / `filter`: no deopts; `callbackfn.call(thisArg, …)`
  costs a builtin call per element until TurboFan has inlined the callback,
  and `Function#call` stays on the path in every caller whose callback
  feedback is polymorphic.

#### C1 — search loops per element kind (`C1-search`)

`indexOf` / `lastIndexOf` / `includes` dispatch on `typeof searchElement`
to four private loops (refs, numbers, strings, other) so each `===` keeps
monomorphic feedback; the ref loops are unrolled ×4. `fromIndex` handling
now follows the spec (`ToIntegerOrInfinity`: `NaN`/`null`/`undefined` → 0,
fractions truncated, `±Infinity`, an explicit `undefined` to `lastIndexOf`
is 0, `-0` folded). Tests: `test/ArraySchema.test.ts` "search builtins
match Array" (every case run against a plain Array with the same contents,
encoder and decoder side).

| unit | base | C1 | Δ | p |
|---|---|---|---|---|
| mutations/array-iterate/indexOf-last | 2.269 µs | 1.748 µs | **−23.0 %** | < .001 |
| decoder/array-read/indexOf-last | 2.000 µs | 1.798 µs | **−10.1 %** | < .001 |
| mutations/array-iterate forEach / for-of / index / map / filter / shift-push | | | −0.2 / +0.6 / −0.5 / +1.7 / −1.9 / +0.1 % | all p > 0.4 |
| decoder/array-read index / for-of / spread / forEach / map / filter / length+at | | | −0.3 / +0.2 / 0 / −0.6 / +1.2 / −0.1 / −0.8 % | all p > 0.28 |

Accepted. (`bench/results/C1-*.json`.)

#### C2 — callback builtins without `Function#call` (`C2-callbacks`)

`forEach` / `map` / `filter` / `find` / `findIndex` / `some` / `every` call
the callback directly when `thisArg` is `undefined` (a direct call passes
`this = undefined` exactly like `.call(undefined, …)`); the `.call` loop is
kept for an explicit `thisArg`. `some` delegates to `findIndex`. No closure
is allocated, the callback signature `(value, index, array)` and the
`array` argument (the public identity, so writes through it are tracked)
are unchanged. Tests: "callback builtins match Array (thisArg, arguments)"
— `this`, arguments, call count and results compared against a plain Array
for `undefined` / object / `null` / `0` thisArg, plus `reduce` and the
tracked write through the `array` argument.

| unit | C1 | C2 | Δ | p |
|---|---|---|---|---|
| mutations/array-iterate/forEach | 5.921 µs | 5.457 µs | **−7.8 %** | < .001 |
| mutations/array-iterate/map | 6.003 µs | 5.576 µs | **−7.1 %** | .002 |
| mutations/array-iterate/filter | 7.208 µs | 6.661 µs | **−7.6 %** | < .001 |
| decoder/array-read/forEach | 5.898 µs | 5.597 µs | **−5.1 %** | < .001 |
| decoder/array-read/map | 6.556 µs | 6.121 µs | **−6.6 %** | < .001 |
| decoder/array-read/filter | 7.553 µs | 7.116 µs | **−5.8 %** | < .001 |
| mutations/array-iterate for-of / index / indexOf-last / shift-push | | | +1.3 / −0.2 / −0.1 / +0.6 % | p > 0.5 |
| decoder/array-read index / for-of / spread / indexOf-last / length+at | | | −1.3 / +0.3 / −0.6 / +0.3 / −1.1 % | p > 0.2 |

Accepted. (`bench/results/C2-*.json`.)

#### C3 — ref search loops unrolled ×8 (`C3-unroll8`)

Loop-shape probe through the harness child (`bench/lib/child.mjs`, one
process per run, 3 runs each; `indexOf` monkey-patched on the C2 build so
the scenario's call site is the real one): ×1 2.11–2.18 / 2.29–2.38 µs
(decoder / mutations), ×4 1.48–1.56 / 1.67–1.76, ×8 1.38–1.41 / 1.60–1.71,
×16 as a nested fixed loop 2.20–2.23 / 2.41–2.54. Native `indexOf` on a
plain array of the same 2000 refs is 0.47–0.54 µs in isolation — V8 does not
eliminate the per-element bounds check in the JS loop, so ×8 is where the
loop overhead stops mattering.

| unit | C2 | C3 | Δ | p |
|---|---|---|---|---|
| decoder/array-read/indexOf-last | 1.825 µs | 1.631 µs | **−10.6 %** | < .001 |
| mutations/array-iterate/indexOf-last | 1.694 µs | 1.659 µs | −2.1 % | .027 |
| mutations/array-iterate/index | 142.0 µs | 143.4 µs | +1.0 % | .021 (code not on this path; below the 2 % bar) |
| decoder/array-read/filter | 7.365 µs | 7.455 µs | +1.2 % | .034 (same) |
| everything else in both groups | | | −2.7 … +1.0 % | p > 0.06 |

Accepted. (`bench/results/C3-*.json`.)

#### Rejected / not pursued

- **Native `indexOf` / `includes` on the subclass** (`Array.prototype.indexOf.call(target, …)`):
  V8's CSA builtin rejects the receiver (`BranchIfFastJSArray` requires the
  initial `Array.prototype`) and tail-calls `Runtime_ArrayIndexOf`, which is
  correct but 3.7–4.0 µs on 2000 refs against 0.9–1.2 µs for the loop it
  would replace; `lastIndexOf` goes through the Torque generic path (60 µs).
  Same for the decoder-side instance (no Proxy involved): 3.7 µs.
- **Native mutators** (`shift` / `splice` / `copyWithin` `.call(target)`):
  generic per-property path, 67–79 µs per call on 2000 elements.
- **Young backing store for `shift`** (`length = 0` and regrow so that the
  slide's stores land on a new-space page and skip the remembered-set
  insert): 14.7 µs at 2000 elements (12.5–14.9 across allocation profiles)
  against 2.2–11.2 µs for the in-place slide; at 500 elements 2.6–3.7 vs
  0.6–2.3 µs; at 100 elements a wash. The regrow reallocations cost more
  than the barriers they avoid.
- **`shift` slide loop shapes**: no deopt, no polymorphic IC, `arrRemove`
  already inlined into `shift`; the loop is 1 ns per element when the process
  is quiet. Nothing to tighten — see the storage-model note below.

#### Final stack vs `base` (guards) — `C3-unroll8`

| unit | base | C3 | Δ | p | bytes |
|---|---|---|---|---|---|
| mutations/array-refs push-pop-100 / push-pop-2000 | 2.19 / 170.5 µs | 2.19 / 170.8 µs | −0.3 / +0.2 % | .66 / .66 | 0 = 0 |
| mutations/array-refs push-shift-100 / push-shift-2000 | 3.04 / 12.12 µs | 3.06 / 12.01 µs | +0.6 / −0.9 % | .58 / .036 | 13 = 13, 12 = 12 |
| mutations/array-refs splice-head-500 / unshift-pop-500 | 5.13 / 5.04 µs | 5.13 / 5.05 µs | +0.1 / +0.1 % | .58 / .74 | 12 = 12, 14 = 14 |
| encoder/array-churn | 0.695 µs | 0.707 µs | +1.8 % | .41 | 0 = 0 |
| stateview/array-reindex shift-100 / shift-1000 / pop-1000 | 11.05 / 15.56 / 49.5 µs | 11.14 / 15.67 / 49.6 µs | +0.9 / +0.7 / +0.1 % | .66 / .51 / .46 | 107 / 100 / 101 = |

No guard moved (bytes identical on every row); `decoder/array-read`
`index` / `length+at` / `for-of` / `spread` were flat in every step
(−2.7 … +1.3 %, p > 0.06).

#### Final: v5.0.31 vs the accepted stack (`C3-unroll8`)

N = 20, `bench/results/Cfinal-vs-v5-*.json`. "Round-2 start" is the
v5-vs-`x10-noshrink` column of `bench/v6-open-gaps.md` §3 before this round.

| unit | v5.0.31 | C3 | Δ | round-2 start | bytes |
|---|---|---|---|---|---|
| mutations/array-iterate/indexOf-last | 0.831 µs | 1.612 µs | **+94 %** | +165 % | |
| mutations/array-iterate/forEach | 4.195 µs | 5.362 µs | **+28 %** | +39 % | |
| mutations/array-iterate/filter | 5.981 µs | 6.740 µs | +13 % | +20 % | |
| mutations/array-iterate/map | 5.659 µs | 5.416 µs | −4 % | +5 % | |
| mutations/array-iterate/shift-push | 5.177 µs | 11.21 µs | **+117 %** | +116 % | |
| mutations/array-iterate/for-of / index | 14.34 / 275.2 µs | 8.395 / 142.0 µs | −42 % / −48 % | | |
| decoder/array-read/indexOf-last | 0.826 µs | 1.590 µs | **+93 %** | +137 % | |
| decoder/array-read/forEach | 4.928 µs | 5.543 µs | +13 % | +20 % | |
| decoder/array-read/filter | 6.235 µs | 7.139 µs | +15 % | +22 % | |
| decoder/array-read/map | 6.048 µs | 6.092 µs | +0.7 % | +7 % | |
| decoder/array-read/index / for-of / spread / length+at | 267.3 / 14.41 / 33.99 / 23.39 µs | 4.948 / 8.887 / 31.21 / 0.966 µs | −98 % / −38 % / −8 % / −96 % | | |
| mutations/array-refs/push-shift-2000 | 6.088 µs | 12.28 µs | **+102 %** | +123 % | 21 → 12 |
| mutations/array-refs/push-shift-100 | 3.000 µs | 3.080 µs | +2.7 % | +2.5 % | 23 → 13 |
| mutations/array-refs push-pop-100 / push-pop-2000 | 2.425 / 173.2 µs | 2.158 / 169.5 µs | −11 % / −2 % | | 0 |
| mutations/array-refs splice-head-500 / unshift-pop-500 | 8.801 / 5.860 µs | 5.657 / 5.236 µs | −36 % / −11 % | | 21 → 12, 19 → 14 |

**Storage-model question (for the user, not decided here).** What the
`Array` subclass still costs against v5 per row, after the overrides are
as tight as a JS loop gets: `indexOf` +0.8 µs per 2000 elements (JS loop
0.8 ns/element vs native 0.4), `forEach` / `filter` +0.6–1.2 µs per 2000
callbacks (native builtin inlined with the callback vs a JS loop with the
callback inlined), `shift` on 2000 young refs +6 µs (1999 `RecordWrite`
slow paths vs one C++ range move). Only a native element move recovers the
`shift` row: the 6.0 internal-array build (`SCHEMA_ARRAY_IMPL=internal`,
`bench/array-impl-comparison.md`) had `push-shift-2000` at 2.9 µs (−51 %
vs v5) and `indexOf-last` at 0.72 µs, at the price of 2× slower `arr[i]` on
the encoder side and 54× slower on the decoder side, +44 % on
`decoder/tick`, +32–40 % on callbacks. `bench/v6-open-gaps.md` §3 has the
per-row detail and the guidance for `shift`-heavy queues.

### Round 2 — D: strings and memory

Targets: `encoder/string-heavy` (+4 % vs v5), `encoder/memory-footprint`
(+6 %, `measure: "heap"`). Guards: `realworld/lobby-chat/*`,
`realworld/big-state/*`, `decoder/*`, the decode rows of `large-patch`,
`small-patch`, `entities-aoi-decode`. Raw rows: `bench/results/D-*.json`.

#### D0 — measurements before changing anything

**Strings, micro-benchmark** (scratch script, Node 20.13, under the bench
lock, ns per string, flat strings; `w0`/`r0` = the shipped code):

| op | 4 chars | 16 | 24 | 32 | 48 | 64 | 128 |
|---|---|---|---|---|---|---|---|
| write ASCII: `utf8Length` + `utf8Write` (`w0`) | 27.5 | 83.1 | 104 | 124 | 171 | 257 | 421 |
| write ASCII: single-pass loop + back-patch (`w1`) | 18.7 | 56.6 | 75.6 | 95.4 | 134 | 195 | 413 |
| write ASCII: back-patch + `TextEncoder.encodeInto` (`w3`) | 81.8 | 85.8 | 88.6 | 76.1 | 91.0 | 95.1 | 159 |
| write mixed (é/ç/日): `w0` / `w1` / `w3` | 47 / 17 / 87 | 114 / 73 / 106 | 171 / 93 / 106 | 212 / 154 / 170 | 271 / 219 / 134 | 379 / 365 / 148 | 910 / 675 / 322 |
| write CJK: `w0` / `w1` / `w3` | 48 / 22 / 107 | 180 / 84 / 157 | 172 / 122 / 128 | 218 / 151 / 135 | 302 / 318 / 257 | 446 / 363 / 291 | 805 / 678 / 439 |
| read ASCII (bytes): `+=` loop (`r0`) / same + the flatten the consumer pays later | 36 / 52 | 178 / 247 | 201 / 311 | 241 / 368 | 323 / 525 | 345 / 652 | 616 / 1 384 |
| read ASCII: `TextDecoder.decode(subarray)` (`r2`) | 188 | 194 | 185 | 157 | 134 | 129 | 123 |
| read ASCII: unit loop + one `fromCharCode.apply` (`R7`) | 48 | 100 | 146 | 176 | 230 | 248 | 483 |
| read mixed: `r0` / `r2` / `R7` | 39 / 192 / 41 | 143 / 224 / 108 | 231 / 238 / 172 | 237 / 277 / 175 | 316 / 335 / 255 | 445 / 422 / 325 | 778 / 781 / 900 |
| read CJK (12–352 B): `r0` / `r2` / `R7` | 34 / 161 / 35 | 217 / 291 / 110 | 276 / 404 / 182 | 406 / 411 / 175 | 498 / 616 / 299 | 708 / 797 / 382 | 1 074 / 1 910 / 719 |

Read-outs: the two-pass write pays a native `Buffer.byteLength` call plus a
second pass — the single-pass loop is −30…−40 % up to 32 chars; `encodeInto`
is a flat ~80–100 ns and overtakes the loop between 24 and 32 UTF-16 units
for every alphabet. On the read side the `+=` loop returns a ConsString
from 13 chars on (its flatten costs the consumer as much again on the first
compare / map-key hash), `fromCharCode.apply` is the best JS path from 16
bytes, and `TextDecoder` is a flat ~130 ns only for pure ASCII — its
non-ASCII path is up to 2× slower than the JS loop even at 700 bytes on
this Node, so it needs an ASCII gate. Node-only natives
(`Buffer.prototype.utf8Write` / `utf8Slice`, another 5–40 % above 32 bytes)
were measured and not taken.

**Memory.** `--shapes` (`bench/lib/shape-check.mjs --debug-print tree`): a
`ChangeTree` is `Map[240]` with 27 in-object properties, unused property
fields 0, `properties: FixedArray[0]` — nothing overflowed out of object
(the §5 hypothesis), every tree kind shares one map. A heap-snapshot diff of
the bloat state (1000 players + encoder, scratch tool) gives the objects v6
retains vs v5: `ChangeTree` 240 B vs 224 B (+48 KB: the two round-1 slots),
`ArrayLog` +72 KB, `ArraySchema` 80 vs 104 B, v5's per-array `Map` tables
−235 KB — total JS self-size **2 556 KB (v6) vs 2 582 KB (v5)**, v6 1 %
smaller. Running the scenario at 1000 / 2000 / 4000 players through the
harness child (3 runs each, `bench/.builds/{v5-release,base}`):

| build | 1000 | 2000 | 4000 | slope KB/player |
|---|---|---|---|---|
| v5.0.31 | 2 454 / 2 447 / 2 636 | 4 805 / 4 973 / 4 785 | 9 545 / 9 573 / 9 738 | **2.37** |
| base (v6) | 2 443 / 2 612 / 2 615 | 4 934 / 4 934 / 4 937 | 9 612 / 9 613 / 9 603 | **2.34** |

So the per-entity retained memory of v6 is 1–2 % *below* v5's; the +142 KB
the scenario reports at N = 1000 is a fixed per-process offset (v6's
intercept ≈ 275 KB vs ≈ 80 KB: more library code compiled and per-class
caches built during the first construction — not entity state). The
`heapUsed` reading itself is bimodal by ~170 KB (2 443 vs 2 612 on the same
build), which is the "p = 0.19" of round 1. An A/A run of the scenario
(`base` vs `base`, N = 20): 2 615 vs 2 615 KB, p = 0.24.

#### D1 — single-pass `writeString`, `encodeInto` from 32 chars, tiered `utf8Read` (`D1-strings`)

`writeString` (`src/encoding/varint.ts`) writes the UTF-8 behind one
reserved byte and back-patches the length (moving the body only when it
reaches 128 bytes, like `endChunk`); strings of ≥ 32 UTF-16 units go through
`TextEncoder.encodeInto` (`encode.utf8EncodeInto`, `src/encoding/encode.ts`),
shorter ones through the char loop; a write past the buffer leaves
`it.offset` past `byteLength` exactly as before so the encoder's resize +
re-encode fires. `utf8Read` (`src/encoding/decode.ts`): `+=` loop below 16
bytes, unit loop + one `String.fromCharCode.apply` from 16, from 48 bytes an
ASCII scan (exits at the first high byte) routes pure-ASCII strings to
`TextDecoder` (`ignoreBOM: true`), from 4096 bytes always `TextDecoder`.
Both globals are guarded (`try { new TextEncoder() }`), the JS paths remain
the fallback. Wire bytes identical for every well-formed string (the
harness's byte guard matched on every row); a lone surrogate now encodes as
U+FFFD on every path — the old loop wrote a 4-byte sequence for it while
`Buffer.byteLength` had counted 3, so the prefix and the body disagreed.
Tests: 1055 passing.

| unit (base → D1) | base | D1 | Δ | p |
|---|---|---|---|---|
| encoder/string-heavy | 23.27 µs | **18.13 µs** | **−22.1 %** | < .001 (GC 1.96 → 4.15 ms: `subarray` views) |
| realworld/big-state/encode-10k / -20k | 3.893 / 8.151 ms | 3.621 / 7.554 ms | **−7.0 % / −7.3 %** | < .001 |
| encoder/encode-all | 3.155 ms | 3.001 ms | −4.9 % | .001 |
| realworld/lobby-chat/callbacks | 9.94 µs | 9.29 µs | −6.5 % | .012 (GC 5.67 → 2.69 ms) |
| realworld/lobby-chat/dec | 6.11 µs | 6.00 µs | −1.7 % | .12 (GC 3.26 → 0.76 ms, p < .001) |
| realworld/lobby-chat/enc | 7.36 µs | 7.28 µs | −1.0 % | .31 |
| realworld/big-state/decode-10k / -20k / -10k-callbacks / handshake | 19.02 / 38.70 / 38.97 / 0.263 ms | 19.20 / 38.86 / 39.64 / 0.260 ms | +0.9 / +0.4 / +1.7 / −1.1 % | .39 / .66 / .27 / .10 |
| decoder/bootstrap, tick, deep-nested, map-bootstrap (4), map-churn (2) | | | −1.2 … +1.8 % (map-churn/str +4.8 %) | all > .05 |
| decoder/churn | 41.7 µs | 43.2 µs | **+3.6 %** | .034 (GC 3.26 → 1.85 ms, p < .001) |
| realworld/inventory-rpg/* (3), encoder/map-churn (4), realworld/large-patch/dec-5k (2) | | | −0.8 … +0.8 % | all > .05 |

Accepted: the two targets with strings (`string-heavy`, big-state encode)
move 7–22 %. `decoder/churn` is the one guard past the line; its GC time
halved and `--inlining` on `decodeKeyValueOps` is identical on both builds
(`readString` inlined, `utf8Read` out of line either way) — re-measured in
the final stack-vs-base sweep below.

#### D2 — `decodeInfo` off `ChangeTree`, `WeakMap` fallback (`D2-decodeinfo`) — rejected

The decoder's per-ref record slot (`ChangeTree.decodeInfo`, round 1's x2)
removed from the tracked tree (26 in-object slots, `Map[232]`, still one
map for every tree kind per `--shapes`), kept on `UntrackedChangeTree`; a
tracked instance the Decoder meets resolved its record through a module
`WeakMap`. Tests green. D1 → D2:

| unit | D1 | D2 | Δ | p |
|---|---|---|---|---|
| encoder/memory-footprint | 2 615 KB | 2 591 KB | −0.9 % | < .001 (24 KB = 8 B × 3 002 trees) |
| decoder/bootstrap | 3.250 ms | 3.813 ms | **+17.3 %** | < .001 (GC 10.7 → 89.3 ms) |
| realworld/big-state/decode-10k | 18.65 ms | 19.57 ms | **+5.0 %** | < .001 |
| realworld/entities-aoi-decode/n2000-c1-callbacks / n10000-c1 | 26.7 / 64.3 µs | 27.4 / 65.6 µs | +2.7 % / +2.0 % | .003 / .006 |
| realworld/small-patch/one-entity | 0.338 µs | 0.352 µs | +4.2 % | .021 |
| decoder/tick, large-patch/dec-5k (2), small-patch (rest), entities-aoi-decode/n2000-c1 | | | −2.2 … +1.8 % | > .05 |

Rejected: the "rare tracked instance" is the normal client root —
`new Decoder(new State())` hands the decoder a normally-constructed
(tracked) state, so every fresh Decoder (one per op in `bootstrap` and
`big-state/decode-*`) adds an ephemeron to the `WeakMap`; that is the ×8 GC
time. The memory gain is real but 0.9 % of the row.

#### D2b — `decodeInfo` off `ChangeTree`, lazily added on the tracked root (`D2b-expando`)

Same field removal as D2 (`src/encoder/ChangeTree.ts`: 26 in-object slots,
`Map[232]`, one map for every tree kind per `--shapes`; `UntrackedChangeTree`
keeps the declared slot), but `refInfoSlow` (`src/decoder/DecodeOperation.ts`)
simply assigns `ref[$changes].decodeInfo = ri` — on a decoder-built instance
that fills the declared slot as before, on the tracked client root it adds
the property lazily (one map transition on that tree, no side table).
Tests green. D1 → D2b:

| unit | D1 | D2b | Δ | p |
|---|---|---|---|---|
| encoder/memory-footprint | 2 614 KB | 2 591 KB | −0.9 % | .003 |
| scenario at 1000 / 2000 / 4000 players (harness child, 3 runs) | 2 615 / 4 934 / 9 612 KB (base) | 2 590 / 4 883 / 9 512 KB | slope 2.34 → **2.31 KB/player** | |
| decoder/bootstrap | 3.457 ms | 3.416 ms | −1.2 % | .47 (GC unchanged) |
| realworld/big-state/decode-10k / -10k-callbacks | 19.54 / 32.49 ms | 19.59 / 32.79 ms | +0.2 % / +0.9 % | .99 / .009 |
| realworld/entities-aoi-decode/n2000-c1 / -callbacks / n10000-c1 | 12.41 / 27.43 / 65.83 µs | 12.61 / 27.25 / 65.45 µs | +1.6 % / −0.7 % / −0.6 % | .057 / .21 / .46 |
| realworld/small-patch/* (6 rows) | | | −1.8 … −0.5 % | all > .05 |
| decoder/tick | 97.0 µs | 94.5 µs | −2.6 % | .21 |

Accepted: the 24 KB is back with no decoder cost. (The stack's
`large-patch/dec-5k` row is in the base → stack sweep below: −0.0 %.)

#### Final: `base` → the D stack (`D2b-expando` = D1 + D2b), and v5.0.31 → the stack

N = 20, `bench/results/D-final-base-*.json`, `D-final-v5-*.json`.

| unit | base | D stack | Δ | p |
|---|---|---|---|---|
| **encoder/string-heavy** | 22.28 µs | **17.13 µs** | **−23.1 %** | < .001 (bytes 3 605 = 3 605) |
| **encoder/memory-footprint** | 2 615 KB | **2 591 KB** | **−0.9 %** | .005 |
| realworld/big-state/encode-10k / -20k | 3.916 / 8.021 ms | 3.585 / 7.462 ms | **−8.5 % / −7.0 %** | < .001 |
| realworld/lobby-chat/callbacks / dec / enc | 9.08 / 6.05 / 7.45 µs | 8.87 / 5.97 / 7.49 µs | −2.3 % / −1.4 % / +0.6 % | .034 / .24 (GC 3.26 → 0.77 ms) / .49 |
| realworld/big-state/decode-10k / -20k / -10k-callbacks / handshake | 18.41 / 41.18 / 32.35 / 0.261 ms | 18.39 / 41.23 / 32.35 / 0.262 ms | −0.1 … +0.3 % | > .05 |
| decoder/bootstrap, map-churn (2), map-bootstrap (4), deep-nested, resync (2) | | | −4.4 … +1.2 % | all > .05 |
| decoder/tick | 90.6 µs | 94.3 µs | +4.1 % | .655 |
| decoder/churn | 40.7 µs | 42.1 µs | **+3.3 %** | .019 (GC 3.03 → 1.95 ms, p < .001) — see below |
| realworld/large-patch/dec-5k / -typed | 0.516 / 0.491 ms | 0.515 / 0.489 ms | −0.0 % / −0.4 % | .93 / .20 |
| realworld/entities-aoi-decode/* (3), realworld/small-patch/* (6) | | | −0.7 … +1.6 % | all > .05 |

| unit | v5.0.31 | D stack | Δ | p |
|---|---|---|---|---|
| encoder/string-heavy | 21.62 µs | **17.05 µs** | **−21.1 %** (round 1: +4 %) | < .001 (bytes 3 929 → 3 605) |
| encoder/memory-footprint | 2 473 KB | 2 590 KB | +4.7 % (round 1: +6 %) | **.351** — and 2.37 vs 2.31 KB per player (−2.5 %) once the fixed intercept is taken out (see D0) |
| realworld/lobby-chat/enc / dec / callbacks | 8.04 / 7.35 / 11.70 µs | 7.30 / 5.95 / 8.90 µs | −9.1 % / −19.1 % / −24.0 % | < .001 |
| realworld/big-state/decode-10k / -10k-callbacks | 36.03 / 69.30 ms | 18.28 / 41.86 ms | −49.3 % / −39.6 % | < .001 |

#### D3 — `utf8Read` split into a tiny dispatcher + short / long readers (`D3-splitread`) — neutral, reverted

Tried for `decoder/churn`: the D1 `utf8Read` had grown by the tier
dispatch, so the short-string loop was moved to `utf8ReadShort` and the
tiers to `utf8ReadLong`, leaving a two-line `utf8Read`. D2b → D3, N = 20:
`decoder/churn` −0.5 % (p .78), `decoder/tick` −1.2 %, `lobby-chat/*` −0.9 …
+0.8 %, `big-state/decode-10k` / `-callbacks` −0.6 % / +1.0 %,
`decoder/map-churn` +1.1 % / −0.3 %, `decoder/bootstrap` −0.3 % — all p > .05.
No effect (as `--inlining` had said: `utf8Read` was not inlined into
`readString` on `base` either), so it is not stacked.

**`decoder/churn` verdict:** +3.3…3.6 % at p = .02–.03 in two independent
base-vs-stack sweeps, with GC time halved both times, on a unit where the
string readers are 2.3–2.6 % of self time (`--cpu --interval 100`: `addRef`
18 %, the `garbageCollectDeletedRefs` callback 14 %,
`installUntrackedChangeTree` 9 %), identical inlining decisions, and a
profiled stack run 15 % faster than the profiled base run. The string
change cannot produce a 3 % move there; it is recorded as the one guard past
the line, not treated as a regression of D1, and is the first row to re-check
after the A–C merges (a code-layout effect moves with the build).

**Accepted stack: `D2b-expando` = D1 + D2b.** Left in §4 / §5 of
`bench/v6-open-gaps.md`: nothing per entity on memory; on strings the
16–47-byte read tier is still a JS loop (a Node-only `utf8Slice` path would
take another ~40 %).

### Merge verification (main session)

The four accepted patches were applied one at a time onto the v6 working
tree and frozen as `M1-B` → `M2-AB` → `M3-ABC` → `M4-ABCD`; after each step
`npm test` (1057 → 1059 → 1067 → 1067 passing) and the agent's targets were
re-run on the merged build (raw rows `bench/results/M*.json`).

| step | rows (A → B, N) | Δ | p |
|---|---|---|---|
| `base` → `M1-B` | stateview/tags | **−46.3 %** | < .001 |
| | stateview/views v1 / v10 / v50 / v100heavy (N = 20) | −0.4 / −2.6 / −3.5 / +0.7 % | .78 / .039 / .064 / .86 |
| | e2e/room-tick | +2.2 % | .68 |
| `M1-B` → `M2-AB` | small-patch root-field / one-entity / five-entities / root-field-50views | **−32.1 / −29.5 / −12.6 / −2.4 %** | < .001 … .025 |
| | small-patch idle-50views / dec-one-entity | +1.9 / +0.2 % | .47 / .82 |
| | turn-based/enc | **−8.0 %** | < .001 |
| | large-patch/* (6 rows) | −0.7 … +0.4 % | > .3 |
| | stateview/views v1 / v10 / v50 / v100heavy | −1.5 / −1.9 / −2.9 / −2.8 % | .13 / .06 / .04 / .03 |
| `M2-AB` → `M3-ABC` | array-iterate indexOf-last / forEach / map / filter | **−27.2 / −9.6 / −8.0 / −6.5 %** | < .001 |
| | array-iterate for-of / index / shift-push | −0.3 / −0.3 / −0.4 % | > .3 |
| | decoder/array-read indexOf-last / forEach / map / filter | **−19.2 / −5.7 / −3.6 / −6.5 %** | < .001 … .039 |
| | decoder/array-read index / for-of / spread / length+at | −0.4 … +0.3 % | > .2 |
| | array-refs (6), array-reindex (3), array-churn (N = 12) | −2.3 … +0.9 % except splice-head-500 +4.4 % (p .005) — replicated at N = 30: **+0.3 %, p .65** (noise) | |
| `M3-ABC` → `M4-ABCD` | encoder/string-heavy | **−21.7 %** | < .001 |
| | encoder/memory-footprint | **−1.0 %** (2 638 → 2 612 KB) | < .001 |
| | lobby-chat enc / dec / callbacks | −5.8 / −2.6 / −3.8 % | .011 / .017 / < .001 |
| | big-state encode-10k / decode-10k / decode-10k-callbacks (N = 12), decoder/tick | −1.6 / −0.9 / −1.3 / +0.7 % | > .1 |
| | **decoder/churn (N = 30)** | **+5.1 %** (44.2 → 46.4 µs; GC 3.39 → 2.16 ms) | .016 |

`decoder/churn` is the one guard row over the 2 % line (also +3.6 % and
+3.3 % in agent D's own sweeps). Two isolation builds were measured against
`M4-ABCD` at N = 30: `M4b-noread` (D's `utf8Read` tiers reverted) −0.2 %,
p = .78 — and it costs `lobby-chat/dec` +6.5 % (p < .001), so the tiers stay;
`M4c-nodecodeinfo` (the `decodeInfo` expando reverted, field back on
`ChangeTree`) −2.5 %, p = .28, with memory-footprint +1.0 %. Neither
component explains the row on its own; the unit's run-to-run median moved
between 42.3 and 46.4 µs across these runs. Kept as-is with the row
recorded; reverting all of D would give the row back at the price of the
string-heavy / lobby-chat / big-state-encode wins above.

### Round 2 — final: v5.0.31 vs the merged build (`M4-ABCD`)

Re-baseline of the merged tree (agent E), run alone on the machine after
the merge: `bench/.builds/v5-release` vs `bench/.builds/M4-ABCD`, N = 20
per side, ABBA, one `--compare` per scenario file
(`bench/results/E-rw-<scenario>.json`, log `%TEMP%\agentE-sweep.log`).
"Round 1" is the Δ of §4b (v5 vs `x8-handshake`) for the same row; the
`idle-50views` round-1 value is from `bench/v6-open-gaps.md` §1. Bytes
differ from v5 by design (wire format).

| unit | v5.0.31 | `M4-ABCD` | Δ | p | bytes v5 → final | round 1 |
|---|---|---|---|---|---|---|
| small-patch/root-field | 0.195 µs | 0.192 µs | −1.8 % | .156 | 5 → 7 | **+45 %** |
| small-patch/one-entity | 0.274 µs | 0.240 µs | **−12.3 %** | < .001 | 16 → 15 | **+25 %** |
| small-patch/five-entities | 0.933 µs | 0.775 µs | **−17.0 %** | < .001 | 82 → 63 | −5 % |
| small-patch/root-field-50views | 14.51 µs | 4.206 µs | −71.0 % | < .001 | 250 → 350 | −55 % |
| small-patch/idle-50views | 0.137 µs | 0.139 µs | +1.1 % | .543 | 0 = 0 | +3 % |
| small-patch/dec-one-entity | 0.531 µs | 0.141 µs | −73.4 % | < .001 | 14 = 14 | −74 % |
| large-patch/enc-5k | 1.090 ms | 0.781 ms | −28.4 % | < .001 | 142 011 → 107 396 | −28 % |
| large-patch/enc-5k-typed | 0.976 ms | 0.664 ms | −32.0 % | < .001 | 119 622 → 85 007 | −32 % |
| large-patch/enc-5k-nested | 1.347 ms | 1.121 ms | −16.8 % | < .001 | 162 011 → 142 389 | −17 % |
| large-patch/enc-5k-quantized | 1.257 ms | 0.913 ms | −27.3 % | < .001 | 79 409 → 45 497 | −27 % |
| large-patch/dec-5k | 3.548 ms | 0.517 ms | **−85.4 %** | < .001 | 141 892 → 107 277 | −86 % |
| large-patch/dec-5k-typed | 3.513 ms | 0.488 ms | **−86.1 %** | < .001 | 119 622 → 85 007 | −86 % |
| entities-aoi/n500-c10 | 0.174 ms | 0.101 ms | −41.7 % | < .001 | 8 746 → 6 734 | −39 % |
| entities-aoi/n2000-c50 | 1.979 ms | 0.987 ms | **−50.1 %** | < .001 | 175 164 → 130 126 | −47 % |
| entities-aoi/n2000-c50-nested | 4.092 ms | 3.328 ms | −18.7 % | < .001 | 206 250 → 177 993 | −9 % |
| entities-aoi/n2000-c50-typed | 1.858 ms | 0.902 ms | **−51.5 %** | < .001 | 148 542 → 103 502 | −48 % |
| entities-aoi/n2000-c50-numkeys | 1.974 ms | 0.986 ms | **−50.0 %** | < .001 | 175 142 → 130 068 | −48 % |
| entities-aoi-large/n10000-c200 | 49.41 ms | 18.91 ms | **−61.7 %** | < .001 | 3 556 063 → 2 620 123 | −59 % |
| entities-aoi-large/n10000-c200-move20 | 7.886 ms | 3.146 ms | **−60.1 %** | < .001 | 717 872 → 529 373 | −57 % |
| entities-aoi-decode/n2000-c1 | 23.9 µs | 12.5 µs | −47.8 % | < .001 | 1 693 → 1 265 | −47 % |
| entities-aoi-decode/n2000-c1-callbacks | 36.2 µs | 26.8 µs | −26.0 % | < .001 | 1 693 → 1 265 | −26 % |
| entities-aoi-decode/n10000-c1 | 128.9 µs | 64.6 µs | −49.8 % | < .001 | 9 215 → 6 791 | −50 % |
| lobby-chat/enc | 8.06 µs | 7.01 µs | −12.9 % | < .001 | 227 → 181 | −6 % |
| lobby-chat/dec | 7.50 µs | 5.86 µs | −21.8 % | < .001 | 227 → 181 | −19 % |
| lobby-chat/callbacks | 11.77 µs | 8.82 µs | −25.0 % | < .001 | 227 → 181 | −13 % |
| inventory-rpg/enc | 46.0 µs | 36.4 µs | −21.0 % | < .001 | 3 536 → 2 514 | −20 % |
| inventory-rpg/dec | 60.3 µs | 35.4 µs | −41.3 % | < .001 | 3 536 → 2 514 | −41 % |
| inventory-rpg/callbacks | 81.7 µs | 56.2 µs | −31.3 % | < .001 | 3 536 → 2 514 | −32 % |
| turn-based/enc | 0.918 µs | 0.866 µs | **−5.7 %** | .001 | 12 = 12 | **+10 %** |
| turn-based/broadcast-100 | 60.7 µs | 19.1 µs | −68.6 % | < .001 | 1 212 → 1 199 | −69 % |
| turn-based/broadcast-1000 | 1 508 µs | 282.8 µs | −81.2 % | < .001 | 12 074 → 11 949 | −82 % |
| mmo-shards/enc-c100 | 0.787 ms | 0.108 ms | **−86.3 %** | < .001 | 831 361 → 600 297 | −86 % |
| mmo-shards/enc-c500 | 3.301 ms | 0.189 ms | **−94.3 %** | < .001 | 4 148 166 → 2 992 801 | −93 % |
| mmo-shards/e2e-c20 | 2.454 ms | 1.166 ms | −52.5 % | < .001 | 166 240 → 120 039 | −53 % |
| big-state/encode-10k | 8.146 ms | 3.438 ms | −57.8 % | < .001 | 654 490 → 510 757 | −52 % |
| big-state/encode-20k | 16.26 ms | 6.935 ms | −57.4 % | < .001 | 1 288 834 → 1 028 718 | −51 % |
| big-state/decode-10k | 36.40 ms | 18.28 ms | −49.8 % | < .001 | 654 490 → 510 757 | −60 % |
| big-state/decode-20k | 99.31 ms | 41.28 ms | −58.4 % | < .001 | 1 288 834 → 1 028 718 | −59 % |
| big-state/decode-10k-callbacks | 51.14 ms | 31.86 ms | −37.7 % | < .001 | 654 490 → 510 757 | −39 % |
| big-state/handshake | 0.479 ms | 0.259 ms | −45.8 % | < .001 | 685 → 512 | −44 % |

No real-world row is slower than v5.0.31: the two that are not faster
(`root-field` −1.8 %, `idle-50views` +1.1 %) are at p > 0.15. The three
round-1 regressions (`root-field` +45 %, `one-entity` +25 %,
`turn-based/enc` +10 %) are closed by A1; the string work (D) shows up as
`lobby-chat/enc` −6 → −13 %, `callbacks` −13 → −25 % and `big-state/encode`
−52 → −58 %; `entities-aoi/n2000-c50-nested` −9 → −19 % comes from A1's
scratch-array fix on the extra `Vec2` trees. `big-state/decode-10k` reads
−50 % against −60 % in round 1 because the v5 side moved (46.9 → 36.4 ms;
its `heapUsed`-driven GC is bimodal), not the v6 side (18.6 → 18.3 ms).
GC time per sample is lower on v6 on every encoder row and on the small
decoders; it is higher on the `big-state/decode-*` snapshots (10k: 312 →
662 ms per sample — the decoder builds 10k `UntrackedChangeTree` + entity
pairs in one go) — a fresh `Decoder` per snapshot is the shape, and the
wall-clock still halves.

#### Full matrix, `x10-noshrink` → `M4-ABCD`

N = 12 per side, one `--compare` per group (`bench/results/E-mx-<group>.json`);
every row with |Δ| ≥ 2 % at p < 0.05, wins and regressions both. Bytes are
identical on every row (no wire change in round 2).

| group | moved |
|---|---|
| encoder | `string-heavy` −24.3 %, `steady-tick/mut10` −9.9 %, `encode-all` −9.3 %, `map-encode-all` players-str / scores-str / scores-num −8.8 % / −15.8 % / −3.5 %, `matrix` full-1000 / full-2000 / patch10pct-1000 −4.5 % / −8.0 % / −4.4 %, `map-churn` (all four) −2.7 … −3.2 %, `map-replace/num-10pct` −2.6 %; no regression (`entity-churn` −1.8 % at p .014 and `memory-footprint` −0.1 % at p .039 are under the line; `array-churn` +6.4 % at p .51 and `construct` −3.3 % at p .71 are noise) |
| decoder | `array-read` indexOf-last −20.2 %, forEach / map / filter −5.8 % / −5.2 % / −5.8 %; **`bootstrap` +2.1 % at p .019** — re-run at N = 30 (`E-recheck-bootstrap-n30.json`): **+0.7 %, p .038** (3.209 → 3.232 ms, GC 10.3 → 10.1 ms), under the line; **`churn` +3.0 % at p .157** (40.7 → 42.0 µs; n.s. at N = 12, but +5.1 % at p .016 at N = 30 in the merge verification — the row stays open, `bench/v6-open-gaps.md` §2); `map-bootstrap/players-str-1000` +12.8 % at p .069 (1.67 → 1.89 ms, bimodal, n.s.); `tick` +1.0 % at p .84 |
| stateview | `tags` −47.5 %, `views` v1 / v50 −3.6 % / −6.6 %, `view-churn` −5.1 %, `bootstrap` −4.3 %, `array-reindex/shift-100` −2.3 %; `pop-1000` +2.2 % at p .078 (n.s.) |
| callbacks | `map-churn/num` −4.0 % (p .046); `add-remove-churn` −5.2 % at p .053, `density/dense` +3.1 % at p .157 (both n.s.); `strategies` −1.5 … +1.5 % |
| mutations | `array-iterate` indexOf-last −27.8 %, forEach / map / filter −8.2 % / −6.4 % / −5.2 %; `array-refs` push-shift-100 / -2000 −6.3 % / −2.5 %, splice-head-500 / unshift-pop-500 −4.0 % / −3.9 %; `map-ops` forEach-str −2.1 %, keys-num −3.3 %; `shift-push` +0.6 % (p .44), `index` +1.3 % (p .09) |
| e2e | `room-tick` +0.4 % (p .93) |

#### What is left

Against v5.0.31 the real-world matrix has no losing row; the rows still
slower than v5 are the ArraySchema paths that are the storage model, not the
overrides (`indexOf` +94 %, `shift` on 2000 refs +117 % / +102 %, `forEach` /
`filter` +13 … +28 % — `M4-ABCD` is within 1 % of agent C's `C3-unroll8` on
every one of them) and `encoder/memory-footprint`'s fixed per-process
intercept (+4.7 %, p .35, slope per entity −2.5 %). Against the round-2 start
the only row over the 2 % line is `decoder/churn` (+5.1 % at N = 30, +3.0 %
n.s. here), not attributable to either D component in isolation. The three
real-world units now carry gate budgets (`small-patch/root-field` 0.4 µs,
`large-patch/enc-5k` 1.6 ms, `entities-aoi/n2000-c50` 2.0 ms — ≈ 2 × the
`M4-ABCD` medians; `npm run bench:gate` passes on this tree). Still not
measured: the other-language decoders on the two header changes, runs over
`@view`-tagged fields / fields ≥ 32, and the per-class caches behind the
memory intercept. Details per gap: `bench/v6-open-gaps.md`.
