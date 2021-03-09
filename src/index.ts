export { Schema, DataChange } from "./Schema";

import { MapSchema, getMapProxy } from "./types/MapSchema"
export { MapSchema };

import { ArraySchema, getArrayProxy } from "./types/ArraySchema";
export { ArraySchema };

import { CollectionSchema } from "./types/CollectionSchema";
export { CollectionSchema };

import { SetSchema } from "./types/SetSchema";
export { SetSchema };

import { registerType } from "./types";
export { registerType };

registerType("map", { constructor: MapSchema, getProxy: getMapProxy });
registerType("array", { constructor: ArraySchema, getProxy: getArrayProxy });
registerType("set", { constructor: SetSchema });
registerType("collection", { constructor: CollectionSchema, });

// Utils
export { dumpChanges } from "./utils";

// Encoder / Decoder
export { Iterator } from "./encoding/decode";
import * as encode from "./encoding/encode";
import * as decode from "./encoding/decode";
export { encode, decode };

// Reflection
export {
    Reflection,
    ReflectionType,
    ReflectionField,
} from "./Reflection";

export {
    // Annotations
    type,
    deprecated,
    filter,
    filterChildren,
    defineTypes,
    hasFilter,

    // Internals
    SchemaDefinition,

    // Types
    Context,
    PrimitiveType,
    Definition,
    DefinitionType,
    FilterCallback,
} from "./annotations";

export { OPERATION } from "./spec";