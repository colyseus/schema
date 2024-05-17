export const $track = Symbol("$track");
export const $encoder = Symbol("$encoder");
export const $decoder = Symbol("$decoder");

export const $filter = Symbol("$filter");

export const $getByIndex = Symbol("$getByIndex");
export const $deleteByIndex = Symbol("$deleteByIndex");

/**
 * Used to hold ChangeTree instances whitin the structures
 */
export const $changes = Symbol('$changes');

/**
 * Used to keep track of the type of the child elements of a collection
 * (MapSchema, ArraySchema, etc.)
 */
export const $childType = Symbol('$childType');

/**
 * Special ChangeTree property to identify new instances
 * (Once they're encoded, they're not new anymore)
 */
export const $isNew = Symbol("$isNew");

/**
 * Optional "discard" method for custom types (ArraySchema)
 * (Discards changes for next serialization)
 */
export const $onEncodeEnd = Symbol('$onEncodeEnd');

/**
 * When decoding, this method is called after the instance is fully decoded
 */
export const $onDecodeEnd = Symbol("$onDecodeEnd");