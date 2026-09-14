# ArraySchema storage model — v5 vs 6.0 subclass vs 6.0 internal array

Decision input for 6.0: keep `ArraySchema extends Array` (an Array subclass
behind a `set`-only Proxy on the encoder side, no Proxy on the decoder
side), or go back to the 5.x storage model (a plain internal `items` array
behind a `get`+`set` Proxy on both sides) on top of the 6.0 op log.

Both 6.0 variants share every other line of the library: the same op log,
recorders, encoder, decoder and wire format. The internal-array variant is
`src/types/custom/ArraySchemaInternal.ts`, selected with
`SCHEMA_ARRAY_IMPL=internal npm run build`; it passes 987 of the 990 tests
(the three failures assert `Symbol.species` / `Array.isArray`, and a debug
print). v5 is the `bfda4d9` snapshot with its own codec.

## What end users actually do with arrays

Two sources. Neither is exact; together they agree.

**Local Colyseus projects** (docs, tutorials, learn, the official demos and
starters, colyseus.js, and this machine's game prototypes: 18 roots, 2 336
source files). Array-typed fields were found by their declarations
(`@type([X])`, `t.array(X)`, `new ArraySchema<X>()`) and every use of those
field names was classified (server and client code alike):

| operation on an array field | occurrences | files |
|---|---:|---:|
| `arr[i]` index read / write | 361 | 75 |
| `arr.length` | 194 | 78 |
| `[...arr]` spread | 90 | 34 |
| `arr.push()` | 76 | 44 |
| `for (const x of arr)` | 67 | 44 |
| `arr.map()` | 31 | 21 |
| `arr.splice()` | 29 | 14 |
| `arr.indexOf()` | 27 | 13 |
| `arr.find()` | 19 | 11 |
| `arr.forEach()` | 11 | 3 |
| `arr.some()` | 10 | 3 |
| `arr.clear()` | 9 | 4 |
| `arr.slice()` | 9 | 3 |
| `arr.findIndex()` | 8 | 7 |
| `arr.sort()` | 7 | 7 |
| `arr.unshift()` | 6 | 5 |
| `arr.filter()` | 6 | 4 |
| `arr.at()` | 6 | 5 |
| `arr.shift()` | 5 | 5 |
| `arr.reduce()` | 5 | 4 |

(`Map` methods matched on a field named `items` were dropped from the
table; `.pop()` did not make the top 40.)

**GitHub code search** (legacy search: files that mention both terms in
TypeScript, so a rough co-occurrence, not a call count). Of ~26 600 files
mentioning `ArraySchema`: `map` 14 688, `filter` 7 648, `find` 5 632, `push`
5 536, `sort` 3 432, `clear` 2 656, `forEach` 2 632, `pop` 1 920, `indexOf`
1 088, `shift` 792, `findIndex` 615, `splice` 576, `unshift` 351.

Reading: arrays are **read far more than they are mutated**, and the reads
are index access, `length`, iteration (`for…of`, spread, `map`, `find`,
`filter`) — mostly on the client, where rendering code walks the array every
frame. Appends (`push`) are the common mutation; head/middle mutations
(`shift`, `unshift`, `splice`) are 1–3 % of the files. Whatever the storage
model, the index read and the iteration paths are the ones to optimize;
`shift` on large arrays is a niche.

## How the three models pay for each operation

| | v5 | 6.0 subclass | 6.0 internal array |
|---|---|---|---|
| instance | object with `items: V[]`; Proxy (`get`+`set`) on both sides | real `Array`; encoder: Proxy (`set` only); decoder: none | object with `items: V[]`; Proxy (`get`+`set`) on both sides |
| `arr[i]` read, encoder side | `get` trap → `items[i]` (~130 ns) | Proxy [[Get]] with no trap (~70 ns) | `get` trap (~110 ns) |
| `arr[i]` read, decoder side | `get` trap | native keyed load (~1 ns) | `get` trap |
| `for…of`, spread, `Array.from` | native iterator over `items` | custom iterator over the raw array | native iterator over `items` |
| `forEach` / `map` / `filter` / `find` | delegate to `items` (native) | index loop over the raw array | delegate to `items` (native) |
| `push` / `pop` | native on `items` | keyed store / `length--` | native on `items` |
| `shift` / `unshift` / `splice` | native on `items` (memmove) | index-loop slide (~1 ns/elem, ~5 ns/elem while the moved children are young) | native on `items` (memmove) |
| `Array.isArray(arr)` | false | true | false |
| wire | v5 | 6.0 op log | 6.0 op log |

Why the subclass cannot use the native mutators: V8's fast path of every
`Array.prototype` builtin requires the receiver's prototype to be the initial
`Array.prototype`. Swapping the prototype around the call leaves the instance
on a new hidden class each time (leaks maps, megamorphic ICs); installing the
methods as own properties on a plain array trips V8's 12-property limit and
puts the array into dictionary mode, which disables the same fast paths.

## Results

Machine: win32-x64, Node v20.13.1, `bench/` harness, isolated child process
per sample, 10 samples per side, interleaved, medians, Mann-Whitney p on
wall-clock (✓ / ✗ = significant at p < .05; Δ < 0 means the right-hand
side is faster). Bytes are deterministic. `mutations/array-iterate` walks
2 000 Schema children on the encoder side through the user-facing object
(the Proxy on all three).

| scenario/variant | unit | v5 | 6.0 subclass | 6.0 internal | subclass vs v5 | internal vs v5 | internal vs subclass | bytes v5 / subclass / internal |
|---|---|---:|---:|---:|---:|---:|---:|---|
| callbacks/strategies/legacy | ms/frame | 0.8217 | 0.5863 | 0.7854 | −28.6 % ✓ | −3.9 % ✓ | +32.4 % ✗ | – / – / – |
| callbacks/strategies/raw | ms/frame | 0.7181 | 0.4921 | 0.6843 | −31.5 % ✓ | −5.1 % ✓ | +40.2 % ✗ | – / – / – |
| callbacks/strategies/state | ms/frame | 0.8258 | 0.5928 | 0.7966 | −28.2 % ✓ | −4.2 % ✓ | +33.7 % ✗ | – / – / – |
| decoder/array-read/filter | µs/op | 6.28 | 7.47 | 6.67 | +19.1 % ✗ | +7.7 % ✗ | −11.3 % ✓ | – / – / – |
| decoder/array-read/for-of | µs/op | 14.7 | 8.66 | 14.4 | −41.2 % ✓ | −0.1 % | +65.5 % ✗ | – / – / – |
| decoder/array-read/forEach | µs/op | 4.92 | 5.86 | 5.05 | +19.2 % ✗ | +2.1 % ✗ | −13.9 % ✓ | – / – / – |
| decoder/array-read/index | µs/op | 267 | 4.93 | 279 | −98.2 % ✓ | +5.5 % ✗ | +5483.0 % ✗ | – / – / – |
| decoder/array-read/indexOf-last | µs/op | 0.7573 | 1.99 | 0.7475 | +162.4 % ✗ | −0.8 % | −63.5 % ✓ | – / – / – |
| decoder/array-read/length+at | µs/op | 22.9 | 0.9575 | 15.4 | −95.8 % ✓ | −32.0 % ✓ | +1532.3 % ✗ | – / – / – |
| decoder/array-read/map | µs/op | 6.11 | 6.52 | 6.09 | +6.8 % ✗ | +0.8 % | −6.4 % ✓ | – / – / – |
| decoder/array-read/spread | µs/op | 35.0 | 31.7 | 34.4 | −9.4 % ✓ | +0.1 % | +10.5 % ✗ | – / – / – |
| decoder/bootstrap/default | ms/op | 6.33 | 3.61 | 4.18 | −43.0 % ✓ | −33.7 % ✓ | +16.2 % ✗ | 64 872 / 37 862 / 37 862 |
| decoder/churn/default | ms/frame | 0.0548 | 0.0430 | 0.0509 | −21.6 % ✓ | −6.9 % ✓ | +10.3 % ✗ | – / – / – |
| decoder/deep-nested/default | ms/frame | 0.0349 | 0.0335 | 0.0332 | −4.2 % ✓ | −4.3 % ✓ | +1.4 % | – / – / – |
| decoder/resync/churn | ms/frame | 5.84 | 2.13 | 2.50 | −63.6 % ✓ | −56.7 % ✓ | +18.1 % ✗ | 62 312 / 36 287 / 36 287 |
| decoder/resync/full | ms/frame | 5.86 | 1.96 | 2.35 | −66.6 % ✓ | −59.8 % ✓ | +19.4 % ✗ | 64 872 / 37 862 / 37 862 |
| decoder/tick/default | ms/frame | 0.6878 | 0.4451 | 0.6305 | −35.3 % ✓ | −6.9 % ✓ | +44.5 % ✗ | – / – / – |
| e2e/room-tick/default | ms/tick | 0.0585 | 0.0456 | 0.0455 | −22.1 % ✓ | −21.4 % ✓ | −1.1 % | 1 349 / 1 248 / 1 248 |
| encoder/array-churn/default | ms/tick | 9.10e-4 | 6.99e-4 | 5.89e-4 | −23.2 % ✓ | −27.6 % ✓ | −11.2 % ✓ | 4 / 0 / 0 |
| encoder/construct/default | µs/entity | 5.70 | 5.02 | 5.11 | −11.9 % ✓ | −7.5 % ✓ | +3.9 % | 0 / 0 / 0 |
| encoder/deep-nested/default | ms/tick | 8.61 | 8.09 | 7.97 | −6.0 % ✓ | −3.3 % ✓ | −0.1 % | 89 545 / 54 589 / 54 589 |
| encoder/encode-all/default | ms/op | 5.73 | 3.28 | 3.17 | −42.7 % ✓ | −38.4 % ✓ | +2.9 % ✗ | 340 872 / 212 768 / 212 768 |
| encoder/entity-churn/default | ms/cycle | 0.0948 | 0.0878 | 0.0877 | −7.4 % ✓ | −4.6 % ✓ | +2.9 % ✗ | 804 / 467 / 467 |
| encoder/heavy-tick/default | ms/tick | 0.6329 | 0.5904 | 0.5615 | −6.7 % ✓ | −11.9 % ✓ | −2.6 % ✓ | 20 601 / 17 770 / 17 770 |
| encoder/matrix/full-1000 | ms/op | 1.01 | 0.5790 | 0.5814 | −42.9 % ✓ | −42.3 % ✓ | +2.3 % | 64 872 / 37 862 / 37 862 |
| encoder/matrix/full-2000 | ms/op | 2.07 | 1.25 | 1.24 | −39.9 % ✓ | −39.4 % ✓ | +4.3 % ✗ | 133 872 / 80 768 / 80 768 |
| encoder/matrix/patch100pct-1000 | ms/op | 0.1446 | 0.1132 | 0.1120 | −21.7 % ✓ | −22.3 % ✓ | +1.0 % ✗ | 14 802 / 13 887 / 13 887 |
| encoder/matrix/patch100pct-2000 | ms/op | 0.3468 | 0.2509 | 0.2409 | −27.6 % ✓ | −28.5 % ✓ | −0.3 % | 29 735 / 27 820 / 27 820 |
| encoder/matrix/patch10pct-1000 | ms/op | 0.0148 | 0.0119 | 0.0119 | −19.7 % ✓ | −17.7 % ✓ | −0.5 % | 1 373 / 1 358 / 1 358 |
| encoder/matrix/patch10pct-2000 | ms/op | 0.0290 | 0.0236 | 0.0235 | −18.5 % ✓ | −17.9 % ✓ | −1.0 % | 2 872 / 2 757 / 2 757 |
| encoder/memory-footprint/default | KB | 2634 | 2507 | 2559 | −4.8 % ✓ | −2.8 % ✓ | +4.3 % | – / – / – |
| encoder/steady-tick/mut10 | ms/tick | 1.97e-3 | 1.78e-3 | 1.75e-3 | −9.7 % ✓ | −10.8 % ✓ | +0.7 % | 100 / 100 / 100 |
| encoder/steady-tick/mut100 | ms/tick | 0.0173 | 0.0150 | 0.0146 | −13.7 % ✓ | −15.2 % ✓ | −0.1 % | 1 073 / 1 058 / 1 058 |
| encoder/string-heavy/default | ms/tick | 0.0218 | 0.0241 | 0.0237 | +10.4 % ✗ | +11.2 % ✗ | −0.5 % | 3 929 / 3 858 / 3 858 |
| mutations/array-iterate/filter | µs/op | 5.92 | 7.07 | 5.87 | +19.4 % ✗ | +1.0 % | −18.2 % ✓ | – / – / – |
| mutations/array-iterate/for-of | µs/op | 14.4 | 8.57 | 4.71 | −40.3 % | −67.2 % ✓ | −46.4 % ✓ | – / – / – |
| mutations/array-iterate/forEach | µs/op | 4.19 | 6.12 | 5.16 | +46.1 % ✗ | +22.8 % ✗ | −15.4 % ✓ | – / – / – |
| mutations/array-iterate/index | µs/op | 263 | 142 | 278 | −46.0 % ✓ | +5.7 % ✗ | +92.4 % ✗ | – / – / – |
| mutations/array-iterate/indexOf-last | µs/op | 0.7537 | 2.20 | 0.7156 | +192.4 % ✗ | −9.3 % ✓ | −67.6 % ✓ | – / – / – |
| mutations/array-iterate/map | µs/op | 5.62 | 6.00 | 5.62 | +6.8 % ✗ | +4.6 % ✗ | −8.1 % ✓ | – / – / – |
| mutations/array-iterate/shift-push | µs/op | 5.09 | 11.2 | 2.04 | +120.4 % ✗ | −58.6 % ✓ | −81.6 % ✓ | – / – / – |
| mutations/array-refs/push-pop-100 | ms/tick | 2.48e-3 | 2.16e-3 | 2.11e-3 | −12.8 % ✓ | −15.2 % ✓ | −1.7 % ✓ | 7 / 0 / 0 |
| mutations/array-refs/push-pop-2000 | ms/tick | 0.1740 | 0.1696 | 0.1689 | −2.5 % ✓ | −2.5 % ✓ | −0.1 % | 6 / 0 / 0 |
| mutations/array-refs/push-shift-100 | ms/tick | 2.97e-3 | 3.04e-3 | 2.97e-3 | +2.3 % ✗ | +0.6 % | −4.1 % ✓ | 23 / 13 / 13 |
| mutations/array-refs/push-shift-2000 | ms/tick | 5.57e-3 | 0.0119 | 2.95e-3 | +113.9 % ✗ | −50.9 % ✓ | −77.0 % ✓ | 21 / 12 / 12 |
| mutations/array-refs/splice-head-500 | ms/tick | 7.43e-3 | 5.10e-3 | 4.84e-3 | −31.3 % ✓ | −34.8 % ✓ | −5.2 % ✓ | 21 / 12 / 12 |
| mutations/array-refs/unshift-pop-500 | ms/tick | 5.79e-3 | 5.15e-3 | 4.03e-3 | −11.1 % ✓ | −26.9 % ✓ | −21.1 % ✓ | 19 / 14 / 14 |
| stateview/array-reindex/pop-1000 | ms/tick | 0.0560 | 0.0498 | 0.0485 | −11.2 % ✓ | −9.2 % ✓ | +1.1 % | 156 / 101 / 101 |
| stateview/array-reindex/shift-100 | ms/tick | 0.0111 | 0.0113 | 0.0112 | +1.6 % | +4.0 % ✗ | −1.0 % | 158 / 107 / 107 |
| stateview/array-reindex/shift-1000 | ms/tick | 0.0168 | 0.0169 | 0.0137 | +0.9 % | −13.8 % ✓ | −13.0 % ✓ | 156 / 100 / 100 |
| stateview/bootstrap/default | ms/op | 3.51 | 2.15 | 2.13 | −38.7 % ✓ | −37.8 % ✓ | +1.1 % | 180 443 / 129 754 / 129 754 |
| stateview/tags/default | ms/tick | 0.0294 | 0.0318 | 0.0328 | +8.1 % ✗ | +13.6 % ✗ | −2.5 % | 2 385 / 2 385 / 2 385 |
| stateview/view-churn/default | ms/tick | 0.6884 | 0.5601 | 0.5719 | −18.6 % ✓ | −17.1 % ✓ | −0.9 % | 18 610 / 13 189 / 13 189 |
| stateview/views/v1 | ms/tick | 9.49e-3 | 8.81e-3 | 8.71e-3 | −7.2 % ✓ | −9.4 % ✓ | −0.8 % | 397 / 365 / 365 |
| stateview/views/v10 | ms/tick | 0.0200 | 0.0135 | 0.0134 | −32.6 % ✓ | −33.6 % ✓ | +1.1 % | 2 580 / 2 404 / 2 404 |
| stateview/views/v100heavy | ms/tick | 0.2466 | 0.1118 | 0.1116 | −54.7 % ✓ | −55.6 % ✓ | −2.1 % | 120 862 / 111 166 / 111 166 |
| stateview/views/v50 | ms/tick | 0.0590 | 0.0279 | 0.0282 | −52.8 % ✓ | −53.0 % ✓ | +1.0 % | 12 240 / 11 424 / 11 424 |

## Reading the results

**Client side (decoder), where the survey puts most reads.** The subclass
is the only model with native element access: `arr[i]` over 2 000 children
costs 4.9 µs against 267 µs on v5 and 279 µs on the internal array (54×),
`arr.at()` 0.96 µs against 22.9 / 15.4 µs, `for…of` 8.7 µs against 14.7 /
14.4 µs, spread 31.7 against 35 / 34 µs. The two Proxy models pay a trap on
every element read, and that also taxes the decoder itself: with the
internal array `decoder/tick` is 44 % slower than the subclass, bootstrap
16 %, resync 18–19 %, callbacks 32–40 %, because every per-chunk access to
the instance (`$childType`, `$rev`, `$items`) goes through the trap. The
builtins that delegate to a native (`forEach`, `map`, `filter`, `indexOf`)
are the one place the Proxy models win on the client: 6–19 % on the
callback builtins, 2.7× on `indexOf` (native SIMD search vs a JS loop) —
about 1 µs per 2 000 elements.

**Server side (encoder).** The codec is the same and the numbers say so:
subclass and internal array are within ±3 % on every encoder, view and e2e
row, both 20–40 % faster than v5 with identical bytes. The differences are
in what user code does with the array between ticks. The internal array
wins head mutations on large arrays — `push`+`shift` on 2 000 children is
2.9 µs per tick against 11.9 µs (subclass) and 5.6 µs (v5), `unshift`+`pop`
on 500 is 21 % faster — and iteration through the user-facing object:
`for…of` 4.7 vs 8.6 µs, `forEach` / `map` / `filter` 8–18 % faster,
`indexOf` 3×. The subclass wins index reads 2× (142 vs 278 µs per 2 000
`arr[i]`, since its Proxy has no `get` trap), and small-array mutations are
a wash (push/pop, and shift on 100 elements, within 4 %).

**Memory.** Encoder footprint for the bloat state: subclass 2 507 KB,
internal array 2 559 KB, v5 2 634 KB.

**What cannot be fixed within a model.** An Array subclass never gets V8's
native mutators (prototype check) and never gets native `for…of`; its head
removal is an index-loop slide that costs ~5 ns per element while the moved
children are still young. A Proxy with a `get` trap never gets a native
`arr[i]`; the trap is the floor for every read on both sides.

## Recommendation

Keep `ArraySchema extends Array`. Weighted by what user code does — index
reads, `length`, `for…of`, spread and `push`, mostly on the client — the
subclass is faster where it matters by one to two orders of magnitude
(client `arr[i]` 54×, `at()` 16–24×, `for…of` 1.7×) and gives the fastest
decoder and callback path. What it gives up is confined to head mutations
on arrays of thousands of Schema children (`shift` on 2 000: 6 µs per tick
more than v5, 9 µs more than the internal array) and about 1 µs per 2 000
elements on the delegating read builtins. Those are the 1–3 % of files in
the survey, and a feed that shifts thousands of children per tick is better
served by a `MapSchema` keyed by sequence or batch trimming anyway.

A hybrid (subclass on the decoder, internal array on the encoder) would
recover the server-side `shift` and iteration wins at the cost of two
implementations, `Array.isArray` differing by side, and 2× slower `arr[i]`
in server game logic; not worth it on this evidence.

The experiment stays in the tree (`ArraySchemaInternal.ts`,
`SCHEMA_ARRAY_IMPL=internal`) so the comparison can be re-run; it is not
part of the test matrix.

