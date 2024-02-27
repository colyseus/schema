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