# 04 — `ArraySchema` reads that are still slower than 5.x

**Status:** open, blocked on a storage-model decision the user has declined so
far · **Kind:** perf · **Risk:** high (API + the collections rewrite)

## Evidence (5.0.32 vs `R6-E`, `decoder/array-read`, 2 000 elements)

| op | 5.x | 6.0 | Δ |
| --- | --- | --- | --- |
| `index` (`arr[i]` loop) | 503 µs | 4.7 µs | −99 % |
| `length` + `at` | 26.4 µs | 0.94 µs | −96 % |
| `map` / `forEach` / `spread` / `filter` | | | −26 / −19 / −13 / −11 % |
| **`for…of`** | 5.5 µs | 6.5 µs | **+17.6 %** (was +84 %) |
| **`indexOf` (last element)** | 0.83 µs | 1.49 µs | **+80 %** |

Both remaining rows have the same root: 6.0's `ArraySchema` **is** an `Array`
subclass (so `arr[i]`, `length`, `Array.isArray` are native), while 5.x wrapped
a plain internal array and delegated to it.

- `indexOf`: 5.x ran the native `Array.prototype.indexOf` on a plain packed
  array (SIMD-ish fast path). On a subclass receiver the native builtin takes
  V8's generic path, 3–4× slower than the typed index loop used now
  (`indexOfKind`, unrolled ×8, `typeof`-dispatched to stay monomorphic).
- `for…of`: V8 inlines the native array iterator into an index loop only for
  plain arrays. On a subclass instance the native iterator measured 15.9 µs
  against 10.0 µs for the hand-written one; the hand-written one now reuses one
  result object (6.5 µs). A generator measured 27 µs.

## What would close it

Only the "internal plain array" storage model (the instance holds a plain
`items` array and forwards to it): native `indexOf` / iterator speed back, at
the price of what 6.0 gained — `arr[i]` / `length` through a Proxy `get` on
both sides (5.x: `index` 503 µs vs 4.7 µs). `bench/array-impl-comparison.md`
has the earlier comparison; `src/types/custom/ArraySchemaInternal.ts` is the
dormant alternative implementation (imported nowhere — see lead 11).

## Cheap things still untried

- `includes` / `lastIndexOf` share `indexOf`'s helper — nothing extra to win.
- `keys()` / `entries()` still allocate a fresh result per step (the user chose
  "reuse for `values()` only"); `entries()` also allocates the `[i, v]` pair.
- Document the guidance instead: hot client loops should use an index loop or
  `forEach` (both at or ahead of 5.x).
