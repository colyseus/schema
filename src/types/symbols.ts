//
// Cross-bundle symbol sharing.
//
// When @colyseus/schema is loaded more than once into the same JS realm
// (e.g. main bundle + ./input subpath bundle), plain `Symbol("$x")` calls
// in each copy produce distinct values — breaking identity checks like
// `instance[$values]` when the reader and the writer come from different
// copies.
//
// `Symbol.for(key)` resolves to the engine's process-wide Symbol Registry,
// so every copy gets the same symbol regardless of which one created it.
//
// Fallback: runtimes that lack `Symbol.for` get a polyfill anchored on
// globalThis (also shared across module copies).
//
declare const self: any;
declare const window: any;

const _g: any = (function () {
    if (typeof globalThis !== "undefined") return globalThis;
    if (typeof global !== "undefined") return global;
    if (typeof self !== "undefined") return self;
    if (typeof window !== "undefined") return window;
    return {};
})();

if (typeof Symbol === "function" && typeof (Symbol as any).for !== "function") {
    const REGISTRY_KEY = "colyseus.symbolRegistry";
    const registry: { [k: string]: symbol } =
        _g[REGISTRY_KEY] || (_g[REGISTRY_KEY] = Object.create(null));
    (Symbol as any).for = function (key: string): symbol {
        return registry[key] || (registry[key] = Symbol(key));
    };
    (Symbol as any).keyFor = function (sym: symbol): string | undefined {
        for (const k in registry) if (registry[k] === sym) return k;
        return undefined;
    };
}

export const $refId: unique symbol = Symbol.for("$refId");
export const $track = "~track";
export const $encoder = "~encoder";
export const $decoder = "~decoder";

export const $filter = "~filter";

export const $getByIndex = "~getByIndex";
export const $deleteByIndex = "~deleteByIndex";
/**
 * Resync-sweep hook (see decoder/Resync.ts): prune every entry the rejoin
 * snapshot did not visit. Each collection owns its storage-specific
 * bookkeeping (journal pruning, compaction, item indexes); the generic
 * DELETE/ref/callback bookkeeping arrives via the `prune`/`keep` callbacks.
 */
export const $resyncPrune = "~resyncPrune";

/**
 * Used to hold ChangeTree instances whitin the structures.
 *
 * Real JS Symbol — see the `$values` comment for rationale.
 */
export const $changes: unique symbol = Symbol.for("$changes");

/**
 * Used to keep track of the type of the child elements of a collection
 * (MapSchema, ArraySchema, etc.). Real Symbol — same rationale as $values.
 */
export const $childType: unique symbol = Symbol.for("$childType");

/**
 * Self-reference an instance sets on `this` so its own methods can recover
 * the underlying object even when `this` is a Proxy wrapper. Used by
 * ArraySchema (whose public API is a Proxy) to grab the underlying instance
 * once at the top of hot methods and then access fields directly without
 * paying the Proxy.get cost on every read.
 */
export const $proxyTarget: unique symbol = Symbol.for("$proxyTarget");

/**
 * Optional "discard" method for custom types (ArraySchema)
 * (Discards changes for next serialization)
 */
export const $onEncodeEnd = '~onEncodeEnd';

/**
 * Optional "reset" method on every poolable Ref (Schema + collections).
 * Empties the instance's backing store and recycles its ChangeTree WITHOUT
 * emitting any wire op, and recurses into ref-type children — so the instance
 * can be returned to a SchemaPool and reused, avoiding the cost of `new`.
 * See encoder/Pool.ts and Schema.reset().
 */
export const $reset = "~reset";

/**
 * When decoding, this method is called after the instance is fully decoded
 */
export const $onDecodeEnd = "~onDecodeEnd";

/**
 * Per-instance dense array holding field values by index.
 * Replaces per-field _fieldName shadow properties.
 *
 * Real JS Symbol (not "~"-prefixed string) so plain assignment is safe —
 * symbols are non-enumerable to Object.keys / JSON.stringify / for-in,
 * which means we can drop Object.defineProperty(...{ enumerable: false })
 * and avoid the slow-path / dictionary-mode hazards that come with it.
 */
export const $values: unique symbol = Symbol.for("$values");

/**
 * Brand for FieldBuilder instances so schema() can detect them.
 */
export const $builder = "~builder";

/**
 * Metadata
 */
export const $descriptors = "~descriptors";

/**
 * Cached per-class encode descriptor: bundles encoder fn, filter fn,
 * metadata, isSchema flag and the per-field arrays into one object stashed
 * on the constructor. Replaces several separate per-tree property chases /
 * function calls in the encode loop with a single property load.
 */
export const $encodeDescriptor = "~__encodeDescriptor";
export const $encoders = "~encoders";
export const $numFields = "~__numFields";
export const $refTypeFieldIndexes = "~__refTypeFieldIndexes";
export const $viewFieldIndexes = "~__viewFieldIndexes";
export const $fieldIndexesByViewTag = "$__fieldIndexesByViewTag";
export const $unreliableFieldIndexes = "~__unreliableFieldIndexes";
export const $patchOnlyFieldIndexes = "~__patchOnlyFieldIndexes";
// @patchOnly ∪ @deprecated() — indexes the full-sync walk must not read (the
// deprecated accessor may throw). Maintained at decoration time.
export const $fullSyncSkipIndexes = "~__fullSyncSkipIndexes";
export const $fullStateOnlyFieldIndexes = "~__fullStateOnlyFieldIndexes";
export const $streamFieldIndexes = "~__streamFieldIndexes";
export const $streamPriorities = "~__streamPriorities";
