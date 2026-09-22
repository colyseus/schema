# 09 — Design: cross-copy runtime interop

**Status:** design, awaiting owner review (2026-09-22) · base commit `16ff6be` ·
owner decision: cross-copy runtime interop **is** supported.

Everything under "Measured" was reproduced by importing `build/index.mjs` twice in
one Node process (`import(url)` and `import(url + "?copy=b")` — Node keys ESM
instances by full URL, and the rollup bundle is a single file, so the two graphs
are fully separate).

## Measured

- `encA/decB` and `encB/decB` throw exactly the reported `MapSchema#$items` error.
- `encB/decA` **without inheritance** already loses values: B's context is
  `State:0, Schema:1, Item:2` vs A's `State:0, Item:1`, so same-shape runs carry
  typeId 2 and decoder A logs `unknown typeId 2 in a run (skipped)`.
- `encB/decA` **with inheritance**: `Sub` is unknown to B's context (no typeId
  written), decoder builds `Item`, `field not defined at index 3`, cascading
  `refId not found`.
- Constructing one `B.Encoder` over A's state installs `Symbol.metadata` on A's
  `Schema` base; every A class defined afterwards shares that one metadata object
  (`Later2` reported fields `a, b`).

## 1. Inventory of class-identity dependencies

**E** encode path, **D** decode path, **C** cold (definition / handshake / debug).

| # | Site | Path | Cross-copy behaviour today |
|---|------|------|----------------------------|
| 1 | `assertInstanceType` (`src/encoding/assert.ts:66`) | E hot | Only ever called with **Schema** classes whose instances are created by their own copy → copy-safe. **No change.** |
| 2 | Collection auto-conversion `instanceof ArraySchema/MapSchema/Map` (`src/annotations.ts:510,516,520`) | E/D | **Root cause of the decoder throw**: a foreign `MapSchema` misses `instanceof`, isn't a `Map`, so `for…in` iterates its own fields and calls `map.set("$items", Map)`. |
| 3 | `MapSchema` ctor `instanceof Map \|\| MapSchema` (`MapSchema.ts:105-106`) | C | Same as #2 for `new A.MapSchema(bMap)`. |
| 4 | `ensureTracked`: `child instanceof ChangeTree` (`treeAttachment.ts:171`) | E hot | A foreign *tracked* tree is mistaken for Untracked and replaced (ops / parent chain lost). |
| 5 | `TypeContext.discoverTypes` stop at `parent !== Schema` (`TypeContext.ts:90`) | E/D | **Root cause A**: foreign `Schema` base added as a type → every typeId shifted. |
| 6 | `TypeContext.register` `!== Schema`; static `inheritedTypes` (`TypeContext.ts:16,19-29,82`) | E/D | **Root cause B**: registry per copy → subclasses unknown to the other copy. |
| 7 | `TypeContext.add` → `Metadata.initialize(schema)` (`TypeContext.ts:65-67`) | E/D | **Process-wide corruption**: installs metadata on the foreign `Schema` base → later classes share one field table. |
| 8 | `Metadata.initialize`: `parentClass !== Schema` (`Metadata.ts:530`) | C | Brand-based for defence. |
| 9 | `populateReflection`: `inheritFrom !== Schema` (`Reflection.ts:146`) | C | Emits a bogus `extendsId`. |
| 10 | Decoder collection factory `getType(kind).constructor.initializeForDecoder()` (`DecodeOperation.ts:174,220`) | D | Builds the decoder copy's class for a field declared by the other copy → feeds #2. |
| 11 | Type registry / encode / decode tables (`registry.ts`, `encoding/{encode,decode}.ts`) | E/D | Per copy; `defineCustomTypes` in one copy invisible to the other. |
| 12 | `complexTypeKlass.constructor === ArraySchema/MapSchema` (`annotations.ts:497-498`) | C | Same copy always — argues **against** sharing the registry globally. |
| 13 | `TreeStamp` global private slot (`ChangeTree.ts:79-139`) | E/D | Already shared. |
| 14 | `$changes`, `$refId`, … `Symbol.for` symbols; string slots incl. `COLLECTION_KIND` | E/D | Already shared. |
| 15 | Per-constructor caches `$encodeDescriptor`, `$decodeInfo` | E/D | Shared; safe only for **identical builds**. |
| 16 | `buildRefInfo`: `ctor.COLLECTION_KIND` (`DecodeOperation.ts:71`) | D | Already brand-based. |
| 17 | `TypeContext.cachedContexts` | C | Per copy; fine. |
| 18 | `Callbacks.get/getLegacy` `instanceof Decoder` (`Callbacks.ts:523,545`) | C | Foreign Decoder → TypeError. |
| 19 | `Schema.debugRefIds` `instanceof RefTable` (`Schema.ts:452`) | C debug | Misreports. |
| 20 | `e instanceof ChunkMismatch` (`Decoder.ts:137,164`) | D | Thrown/caught in one copy; safe. |
| 21 | Module-level scratch pools, `Encoder.BUFFER_SIZE` | — | Per copy; no re-entrancy. `BUFFER_SIZE` is per copy (document). |
| 22 | `Schema.is` / `isSchema` / `Metadata.isValidInstance` | E/D | Duck-typed; shared. |

## 2. Root cause of the wrong round trip (encoder B over instances of A)

Three independent defects in `TypeContext` (confidence high, all reproduced):

1. **TypeId shift** — #5: A's `Schema` base is added as type 1 in B's context; same-shape runs and polymorphic ref headers carry shifted ids.
2. **Missing subclasses** — #6: B's context never sees A's subclasses → no typeId written → decoder builds the base class → cascade.
3. **Metadata pollution** — #7: `Metadata.initialize(A.Schema)` → all later A classes share one field table (also explains the garbled `B.Reflection.encode(encA) → A.Reflection.decode`).

With the type-id table fixed, `encB/decA` bytes equal `encA`'s: the rest of the encode path already works by duck typing.

## 3. Mechanism per site

- **Schema-base brand** (#5–#9): `$schemaBase = Symbol.for("@colyseus/schema:SchemaBase")`, defined as an own static on `Schema` (next to `defineRefAccessors`, `Schema.ts:547`); `isSchemaBase(k) = k === Schema || hasOwnProperty.call(k, $schemaBase)`. Replace the four `!== Schema` checks; `TypeContext.add` never adds / initializes a base. Cold paths only.
- **Shared inheritance registry** (#6): `TypeContext.inheritedTypes = (globalThis[Symbol.for("@colyseus/schema:inheritedTypes")] ??= new Map())` (first-loader-wins, like the stamper). Do **not** share `registeredTypes` (#12).
- **Decoder builds the declaring copy's collection class** (#10): `getNormalizedType` (`Metadata.ts:85-110`) stamps the type object with a non-enumerable `Symbol.for("@colyseus/schema:collectionCtor")` → that copy's constructor; `resolveRef` / `consumeRefValue` use `(type[$collectionCtor] ?? getType(kind).constructor).initializeForDecoder()`. Decoded `state.items` is then `instanceof A.MapSchema` whichever copy decodes.
- **Brand fallback in setters** (#2, #3): keep `instanceof` first; on a miss, `value.constructor?.COLLECTION_KIND === Array|Map` → adopt as-is. Same in the `MapSchema` constructor. Plain Array/Map/object literals still convert.
- **`ensureTracked`** (#4): prototype getter `isTracked` (true on `ChangeTree`, false on `UntrackedChangeTree`; no instance field → tree shape unchanged): `if (child instanceof ChangeTree || child.isTracked === true) return child;`.
- **Cold sites** (#18, #19): duck checks (`typeof x.decode === "function" && x.root !== undefined`; `typeof counts.get === "function"`).
- **Custom types** (#11): out of scope first pass — document "call `defineCustomTypes` in every copy".

## 4. Hot-path cost

Only `makeCollectionSetter` and `ensureTracked` change on hot paths, and both keep the monomorphic `instanceof` hit and pay the brand read only on the miss branch (which already converts / allocates). Decoder `resolveRef`: one symbol load replacing a registry lookup per new collection — neutral or better.

Rows: `encoder/{construct,bulk-add,entity-churn,steady-tick,map-churn,array-churn,map-replace,deep-nested}`, `mutations/{tree-build,map-ops,array-refs}`, `decoder/{bootstrap,map-bootstrap,bulk-add,churn,map-churn,tick}`, `stateview/bootstrap`, `e2e/room-tick`, `node bench_encode.js` (time + 5 458 157 bytes).

## 5. Test plan — `test/CrossCopy.test.ts`

Load `A = await import(url)`, `B = await import(url + "?copy=b")` of `build/index.mjs`; assert `A.MapSchema !== B.MapSchema` first. Gate on the bundle existing; add `rollup -c` to `test:types` so CI has it. Classes defined with copy A: `Item{x,y,name}`, `Sub extends Item{z}`, `State{items: map(Item), list: array(Item), tags: set(string), nested: ref(Item), tick}` + a `@view` field.

1. Bytes parity `encA` vs `encB` (full + per tick); TypeContext tables equal.
2. Decoder B / classes A: `instanceof A.MapSchema`, `toJSON` equality, callbacks via both copies' `Callbacks.get(decB)`.
3. Encoder B / instances A: 2 000-tick loop (primitives, Map set/delete/replace, Array push/splice/set/reverse, Set add/delete, nested replace, polymorphic `Sub`); `toJSON` equal every 100 ticks; no `console.warn`.
4. Foreign collection assigned by the user (`stateA.items = new B.MapSchema()`); tracked tree kept.
5. Metadata isolation after `new B.Encoder(stateA)`.
6. Reflection both directions, then a patch stream into the reflected state.
7. StateView across copies.
8. Re-encode a decoded state across copies.

## 6. Risks, unsupported, ordered steps

Unsupported (documented): two **different builds** in one process (shared per-constructor caches + stamper) — add a one-time warning when `globalThis[Symbol.for("@colyseus/schema:version")]` differs; custom types registered in one copy only; Schema classes are never interchangeable across copies.

Risks: shared `inheritedTypes` retains classes for the process lifetime (already true per copy); the first-loaded copy owns shared structures (fine for identical builds); foreign tracked trees under another copy's Root — StateView bitmaps only exercised by test 7, land together.

Steps (one small commit each; snapshot builds before 5 and after 6):
1. Test harness + cases 1 and 5 (failing), gated on the bundle; `rollup` in `test:types`.
2. `$schemaBase` brand; replace the four identity checks; `TypeContext.add` never touches a base.
3. Shared `inheritedTypes`.
4. `$collectionCtor` tag; decoder uses it (cases 2, 6).
5. Brand fallback in `makeCollectionSetter` + `MapSchema` ctor (case 4) — bench encoder/mutations rows.
6. `isTracked` + `ensureTracked` fallback (cases 7, 8) — bench tree-build, bulk-add, entity-churn, stateview.
7. Cold duck checks; version-mismatch warning.
8. Docs: supported matrix in README; LEADS/09 → resolved.
9. Full sweep, bisect across per-step builds.

Critical files: `src/types/TypeContext.ts`, `src/annotations.ts`, `src/decoder/DecodeOperation.ts`, `src/Metadata.ts`, `src/encoder/changeTree/treeAttachment.ts`.
