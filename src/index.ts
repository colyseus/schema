export { Schema } from "./Schema";
export type { DataChange } from "./decoder/DecodeOperation";

import { $track, $encoder, $decoder, $filter, $getByIndex, $deleteByIndex, $changes, $childType } from "./types/symbols";
export { $track, $encoder, $decoder, $filter, $getByIndex, $deleteByIndex, $changes, $childType };

import { MapSchema } from "./types/custom/MapSchema"
export { MapSchema };

import { ArraySchema } from "./types/custom/ArraySchema";
export { ArraySchema };

import { CollectionSchema } from "./types/custom/CollectionSchema";
export { CollectionSchema };

import { SetSchema } from "./types/custom/SetSchema";
export { SetSchema };

import { registerType } from "./types/registry";
export { registerType };

registerType("map", { constructor: MapSchema });
registerType("array", { constructor: ArraySchema });
registerType("set", { constructor: SetSchema });
registerType("collection", { constructor: CollectionSchema, });

// Utils
export { dumpChanges } from "./utils";

// Encoder / Decoder
export type { Iterator } from "./encoding/decode";
import * as encode from "./encoding/encode";
import * as decode from "./encoding/decode";
export { encode, decode };

// Reflection
export {
    Reflection,
    ReflectionType,
    ReflectionField,
} from "./Reflection";

export { Metadata } from "./Metadata";

export {
    // Annotations
    type,
    deprecated,
    defineTypes,
    view,

    // Internals
    TypeContext,
} from "./annotations";

// Annotation types
export type { DefinitionType, PrimitiveType, Definition, } from "./annotations";

export { getStateCallbacks, CallbackProxy } from "./decoder/strategy/StateCallbacks";
export { getRawChangesCallback } from "./decoder/strategy/RawChanges";

export { Encoder } from "./encoder/Encoder";
export { encodeSchemaOperation, encodeArray as encodeKeyValueOperation } from "./encoder/EncodeOperation";
export { ChangeTree, Ref } from "./encoder/ChangeTree";
export { StateView } from "./encoder/StateView";

export { Decoder } from "./decoder/Decoder";
export { decodeSchemaOperation, decodeKeyValueOperation } from "./decoder/DecodeOperation";

export { OPERATION } from "./encoding/spec";