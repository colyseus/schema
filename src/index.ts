export { Schema } from "./Schema";
export type { DataChange } from "./decoder/DecodeOperation";
export type { ToJSON } from "./types/HelperTypes";

import { MapSchema } from "./types/custom/MapSchema"
export { MapSchema };

import { ArraySchema } from "./types/custom/ArraySchema";
export { ArraySchema };

import { CollectionSchema } from "./types/custom/CollectionSchema";
export { CollectionSchema };

import { SetSchema } from "./types/custom/SetSchema";
export { SetSchema };

import { registerType, defineCustomTypes } from "./types/registry";
export { registerType, defineCustomTypes };

registerType("map", { constructor: MapSchema });
registerType("array", { constructor: ArraySchema });
registerType("set", { constructor: SetSchema });
registerType("collection", { constructor: CollectionSchema, });

// Utils
export { dumpChanges } from "./utils";

// Encoder / Decoder
export { $track, $encoder, $decoder, $filter, $getByIndex, $deleteByIndex, $changes, $childType } from "./types/symbols";
export { encode } from "./encoding/encode";
export { decode, type Iterator } from "./encoding/decode";

// Reflection
export {
    Reflection,
    ReflectionType,
    ReflectionField,
} from "./Reflection";

// Annotations, Metadata and TypeContext
export { Metadata } from "./Metadata";
export { type, deprecated, defineTypes, view, schema, entity, type SchemaWithExtends, type SchemaType } from "./annotations";
export { TypeContext } from "./types/TypeContext";

// Annotation types
export type { DefinitionType, PrimitiveType, Definition, } from "./annotations";

// Helper types for type inference
export type { InferValueType, InferSchemaInstanceType, AssignableProps } from "./types/HelperTypes";

export { getDecoderStateCallbacks, CallbackProxy, SchemaCallback, CollectionCallback, SchemaCallbackProxy } from "./decoder/strategy/StateCallbacks";
export { getRawChangesCallback } from "./decoder/strategy/RawChanges";

export { Encoder } from "./encoder/Encoder";
export { encodeSchemaOperation, encodeArray, encodeKeyValueOperation } from "./encoder/EncodeOperation";
export { ChangeTree, Ref, IRef, type ChangeSetName, type ChangeSet} from "./encoder/ChangeTree";
export { StateView } from "./encoder/StateView";

export { Decoder } from "./decoder/Decoder";
export { decodeSchemaOperation, decodeKeyValueOperation } from "./decoder/DecodeOperation";

export { OPERATION } from "./encoding/spec";