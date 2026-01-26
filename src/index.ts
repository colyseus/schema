export { Schema } from "./Schema.js";
export type { DataChange } from "./decoder/DecodeOperation.js";
export type { ToJSON } from "./types/HelperTypes.js";

import { MapSchema } from "./types/custom/MapSchema.js"
export { MapSchema };

import { ArraySchema } from "./types/custom/ArraySchema.js";
export { ArraySchema };

import { CollectionSchema } from "./types/custom/CollectionSchema.js";
export { CollectionSchema };

import { SetSchema } from "./types/custom/SetSchema.js";
export { SetSchema };

import { registerType, defineCustomTypes } from "./types/registry.js";
export { registerType, defineCustomTypes };

registerType("map", { constructor: MapSchema });
registerType("array", { constructor: ArraySchema });
registerType("set", { constructor: SetSchema });
registerType("collection", { constructor: CollectionSchema, });

// Utils
export { dumpChanges } from "./utils.js";

// Encoder / Decoder
export { $track, $encoder, $decoder, $filter, $getByIndex, $deleteByIndex, $changes, $childType, $refId } from "./types/symbols.js";
export { encode } from "./encoding/encode.js";
export { decode, type Iterator } from "./encoding/decode.js";

// Reflection
export {
    Reflection,
    ReflectionType,
    ReflectionField,
} from "./Reflection.js";

// Annotations, Metadata and TypeContext
export { Metadata } from "./Metadata.js";

// Schema definition types
export {
    type,
    deprecated,
    defineTypes,
    view,
    schema,
    entity,
    type DefinitionType,
    type PrimitiveType,
    type Definition,
    // Raw schema() return types
    type SchemaWithExtendsConstructor,
    type SchemaWithExtends,
    type SchemaType,
} from "./annotations.js";

export { TypeContext } from "./types/TypeContext.js";

// Helper types for type inference
export type { InferValueType, InferSchemaInstanceType, AssignableProps } from "./types/HelperTypes.js";

export { getDecoderStateCallbacks, type CallbackProxy, type SchemaCallback, type CollectionCallback, type SchemaCallbackProxy } from "./decoder/strategy/getDecoderStateCallbacks.js";
export { Callbacks, StateCallbackStrategy } from "./decoder/strategy/Callbacks.js";
export { getRawChangesCallback } from "./decoder/strategy/RawChanges.js";

export { Encoder } from "./encoder/Encoder.js";
export { encodeSchemaOperation, encodeArray, encodeKeyValueOperation } from "./encoder/EncodeOperation.js";
export { ChangeTree, type Ref, type IRef, type ChangeSetName, type ChangeSet} from "./encoder/ChangeTree.js";
export { StateView } from "./encoder/StateView.js";

export { Decoder } from "./decoder/Decoder.js";
export { decodeSchemaOperation, decodeKeyValueOperation } from "./decoder/DecodeOperation.js";

export { OPERATION } from "./encoding/spec.js";