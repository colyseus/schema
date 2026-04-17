export const $refId: unique symbol = Symbol("$refId");
export const $track = "~track";
export const $encoder = "~encoder";
export const $decoder = "~decoder";

export const $filter = "~filter";

export const $getByIndex = "~getByIndex";
export const $deleteByIndex = "~deleteByIndex";

/**
 * Used to hold ChangeTree instances whitin the structures.
 *
 * Real JS Symbol — see the `$values` comment for rationale.
 */
export const $changes: unique symbol = Symbol("$changes");

/**
 * Used to keep track of the type of the child elements of a collection
 * (MapSchema, ArraySchema, etc.). Real Symbol — same rationale as $values.
 */
export const $childType: unique symbol = Symbol("$childType");

/**
 * Self-reference an instance sets on `this` so its own methods can recover
 * the underlying object even when `this` is a Proxy wrapper. Used by
 * ArraySchema (whose public API is a Proxy) to grab the underlying instance
 * once at the top of hot methods and then access fields directly without
 * paying the Proxy.get cost on every read.
 */
export const $proxyTarget: unique symbol = Symbol("$proxyTarget");

/**
 * Optional "discard" method for custom types (ArraySchema)
 * (Discards changes for next serialization)
 */
export const $onEncodeEnd = '~onEncodeEnd';

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
export const $values: unique symbol = Symbol("$values");

/**
 * Brand for FieldBuilder instances so schema() can detect them.
 */
export const $builder = "~builder";

/**
 * Metadata
 */
export const $descriptors = "~descriptors";

/**
 * Per-class bitmask: bit i set iff field i carries a @view tag.
 * Lazily computed from $viewFieldIndexes on first encode pass.
 * Skips the per-field metadata[i].tag property chase in the hot encode loop.
 */
export const $filterBitmask = "~__filterBitmask";

/**
 * Cached per-class encode descriptor: bundles encoder fn, filter fn,
 * metadata, isSchema flag, and filterBitmask into one object stashed on
 * the constructor. Replaces 5 separate per-tree property chases /
 * function calls in the encode loop with a single property load.
 */
export const $encodeDescriptor = "~__encodeDescriptor";
export const $encoders = "~encoders";
export const $numFields = "~__numFields";

/**
 * Per-field SoA storage on metadata. Replaces the legacy per-field
 * object (`metadata[i] = { name, type, tag, ... }`) with parallel arrays
 * stashed via these symbol-like keys (non-enumerable so for-in iteration
 * over metadata still treats it as having no own enumerable props).
 *
 * Hot encoder readers index `metadata[$names][i]` etc. directly; the
 * descriptor's parallel-array fields point at these same arrays (no copy).
 */
export const $names = "~__names";
export const $types = "~__types";
export const $tags = "~__tags";
export const $deprecated = "~__deprecated";
export const $owned = "~__owned";
export const $stream = "~__stream";
export const $refTypeFieldIndexes = "~__refTypeFieldIndexes";
export const $viewFieldIndexes = "~__viewFieldIndexes";
export const $fieldIndexesByViewTag = "$__fieldIndexesByViewTag";
export const $unreliableFieldIndexes = "~__unreliableFieldIndexes";
export const $transientFieldIndexes = "~__transientFieldIndexes";
export const $staticFieldIndexes = "~__staticFieldIndexes";