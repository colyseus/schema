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

import { StreamSchema } from "./types/custom/StreamSchema.js";
export { StreamSchema };

import { registerType, defineCustomTypes } from "./types/registry.js";
export { registerType, defineCustomTypes };

// Each collection registers itself (`registerType` at the bottom of its module).

// Utils
export { dumpChanges } from "./utils.js";

// Encoder / Decoder
export { $track, $filter, $getByIndex, $deleteByIndex, $changes, $childType, $refId, $recorder, $rev } from "./types/symbols.js";
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
    unreliable,
    patchOnly,
    fullStateOnly,
    view,
    schema,
    entity,
    type DefinitionType,
    type MapKeyType,
    type PrimitiveType,
    type Definition,
    type FieldsAndMethods,
    // Raw schema() return types
    type SchemaWithExtendsConstructor,
    type SchemaWithExtends,
    type SchemaType,
} from "./annotations.js";

// zod-style chainable builders
export { t, FieldBuilder, isBuilder, type BuilderDefinition, type ChildType } from "./types/builder.js";

export { TypeContext } from "./types/TypeContext.js";

// Helper types for type inference
export type { InferValueType, InferSchemaInstanceType, AssignableProps, BuilderInitProps, Data } from "./types/HelperTypes.js";

export { getDecoderStateCallbacks, type CallbackProxy, type SchemaCallback, type CollectionCallback, type SchemaCallbackProxy } from "./decoder/strategy/getDecoderStateCallbacks.js";
export { Callbacks, StateCallbackStrategy } from "./decoder/strategy/Callbacks.js";
export { getRawChangesCallback } from "./decoder/strategy/RawChanges.js";

export { Encoder } from "./encoder/Encoder.js";
export { Root } from "./encoder/Root.js";
export { createPool, type SchemaPool, type PoolOptions } from "./encoder/Pool.js";
export { ArrayLog } from "./encoder/ArrayLog.js";
export { KeyedRecorder } from "./encoder/KeyedRecorder.js";
export { ChangeTree, type Ref, type IRef } from "./encoder/ChangeTree.js";
export { StateView } from "./encoder/StateView.js";

export { Decoder } from "./decoder/Decoder.js";
export { RefTable } from "./RefTable.js";
export { OPERATION, ARRAY_OP, CollectionKind, PROTOCOL_VERSION } from "./encoding/spec.js";
export { uvarint, readUvarint, uvarintSize } from "./encoding/varint.js";

// Re-exported for `@colyseus/schema/input` — that subpath bundle is built
// as a thin wrapper that imports identity-bearing modules from here at
// runtime, so it needs `getEncodeDescriptor` available on the public surface.
export { getEncodeDescriptor, type EncodeDescriptor } from "./encoder/EncodeDescriptor.js";

// Symbols used by InputEncoder/InputDecoder via the runtime-externalized
// `@colyseus/schema` import in `build/input/index.mjs`.
export { $numFields, $values } from "./types/symbols.js";
