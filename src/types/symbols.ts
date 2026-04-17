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
export const $encoders = "~encoders";
export const $numFields = "~__numFields";
export const $refTypeFieldIndexes = "~__refTypeFieldIndexes";
export const $viewFieldIndexes = "~__viewFieldIndexes";
export const $fieldIndexesByViewTag = "$__fieldIndexesByViewTag";
export const $unreliableFieldIndexes = "~__unreliableFieldIndexes";
export const $transientFieldIndexes = "~__transientFieldIndexes";
export const $staticFieldIndexes = "~__staticFieldIndexes";