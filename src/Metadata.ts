import { DefinitionType, getPropertyDescriptor } from "./annotations.js";
import { Schema } from "./Schema.js";
import { getType, registeredTypes, TypeDefinition } from "./types/registry.js";
import { $decoder, $descriptors, $encoder, $encoders, $fieldIndexesByViewTag, $numFields, $refTypeFieldIndexes, $staticFieldIndexes, $streamFieldIndexes, $streamPriorities, $track, $transientFieldIndexes, $unreliableFieldIndexes, $viewFieldIndexes } from "./types/symbols.js";
import { ARRAY_STREAM_NOT_SUPPORTED } from "./encoder/streaming.js";
import { encode } from "./encoding/encode.js";
import { TypeContext } from "./types/TypeContext.js";
import { isBitfieldType } from "./types/custom/BitfieldValue.js";

export type MetadataField = {
    type: DefinitionType,
    name: string,
    index: number,
    tag?: number,
    unreliable?: boolean,
    transient?: boolean,
    deprecated?: boolean,
    owned?: boolean,
    static?: boolean,
    stream?: boolean,
    optional?: boolean,
};

export type Metadata =
    { [$numFields]: number; } & // number of fields
    { [$viewFieldIndexes]: number[]; } & // all field indexes with "view" tag
    { [$fieldIndexesByViewTag]: {[tag: number]: number[]}; } & // field indexes by "view" tag
    { [$refTypeFieldIndexes]: number[]; } & // all field indexes containing Ref types (Schema, ArraySchema, MapSchema, etc)
    { [$unreliableFieldIndexes]: number[]; } & // all field indexes tagged with @unreliable
    { [$transientFieldIndexes]: number[]; } & // all field indexes tagged with @transient (not persisted to snapshots)
    { [$staticFieldIndexes]: number[]; } & // all field indexes tagged with @static (not tracked after assignment)
    { [$streamFieldIndexes]: number[]; } & // all field indexes holding a t.stream(...) collection
    { [$streamPriorities]: { [field: number]: (view: any, element: any) => number }; } & // per-stream-field priority callback declared at schema definition time
    { [$encoders]: Array<(bytes: Uint8Array, value: any, it: any) => void>; } & // pre-computed encoder fn per primitive field
    { [field: number]: MetadataField; } & // index => field name
    { [field: string]: number; } & // field name => field metadata
    { [$descriptors]: { [field: string]: PropertyDescriptor } }  // property descriptors

/**
 * Given a normalized field type (`"number"`, `{ map: Foo }`, `Player`,
 * etc.), split into the collection-type descriptor (`{ constructor:
 * MapSchema, ... }`) if applicable and the inner child type. Shared by
 * `@type()` decoration and `Metadata.setFields` — both need to build a
 * property accessor that knows whether the slot holds a collection.
 */
export function resolveFieldType(type: any): { complexTypeKlass: TypeDefinition | false, childType: any } {
    const complexTypeKlass = typeof (Object.keys(type)[0]) === "string" && getType(Object.keys(type)[0]);
    return {
        complexTypeKlass,
        childType: complexTypeKlass ? Object.values(type)[0] : type,
    };
}

export function getNormalizedType(type: any): DefinitionType  {
    if (Array.isArray(type)) {
        return { array: getNormalizedType(type[0]) };

    } else if (typeof (type['type']) !== "undefined") {
        return type['type'];

    } else if (isTSEnum(type)) {
        // Detect TS Enum type (either string or number)
        return Object.keys(type).every(key => typeof type[key] === "string")
            ? "string"
            : "number";

    } else if (typeof type === "object" && type !== null) {
        // Handle collection types
        const collectionType = Object.keys(type).find(k => registeredTypes[k] !== undefined);
        if (collectionType) {
            type[collectionType] = getNormalizedType(type[collectionType]);
            return type;
        }
    }
    return type;
}

function isTSEnum(_enum: any) {
    if (typeof _enum === 'function' && _enum[Symbol.metadata]) {
        return false;
    }

    const keys = Object.keys(_enum);
    const numericFields = keys.filter(k => /\d+/.test(k));

    // Check for number enum (has numeric keys and reverse mapping)
    if (numericFields.length > 0 && numericFields.length === (keys.length / 2) && _enum[_enum[numericFields[0]]] == numericFields[0]) {
        return true;
    }

    // Check for string enum (all values are strings and keys match values)
    if (keys.length > 0 && keys.every(key => typeof _enum[key] === 'string' && _enum[key] === key)) {
        return true;
    }

    return false;
}

export const Metadata = {

    addField(metadata: any, index: number, name: string, type: DefinitionType, descriptor?: PropertyDescriptor) {
        if (index > 64) {
            throw new Error(`Can't define field '${name}'.\nSchema instances may only have up to 64 fields.`);
        }

        // `t.uint(n)` only makes sense as a sub-field inside `t.bitfield(...)`.
        if (
            typeof type === "object" &&
            type !== null &&
            !Array.isArray(type) &&
            typeof (type as any).uint === "number" &&
            (type as any).bitfield === undefined
        ) {
            throw new Error(
                `Field '${name}' uses t.uint(${(type as any).uint}) at the top level — ` +
                `t.uint() is only valid as a sub-field inside t.bitfield({ ... }).`,
            );
        }

        metadata[index] = Object.assign(
            metadata[index] || {}, // avoid overwriting previous field metadata (@owned / @deprecated)
            {
                type: getNormalizedType(type),
                index,
                name,
            }
        );

        // create "descriptors" map
        Object.defineProperty(metadata, $descriptors, {
            value: metadata[$descriptors] || {},
            enumerable: false,
            configurable: true,
        });

        if (descriptor) {
            // Accessor descriptor for the public field name.
            // Installed on the prototype at class-definition time.
            metadata[$descriptors][name] = descriptor;
        } else {
            // For decoder: simple writable slot, also on prototype.
            metadata[$descriptors][name] = {
                value: undefined,
                writable: true,
                enumerable: true,
                configurable: true,
            };
        }

        // map -1 as last field index
        Object.defineProperty(metadata, $numFields, {
            value: index,
            enumerable: false,
            configurable: true
        });

        // map field name => index (non enumerable)
        Object.defineProperty(metadata, name, {
            value: index,
            enumerable: false,
            configurable: true,
        });

        // if child Ref/complex type, add to -4. Bitfield fields are leaf
        // values (no $changes, no refId) — exclude so the tree-attachment
        // recursion (forEachChildWithCtx) doesn't try to walk into them.
        const fieldTypeForRef = metadata[index].type;
        if (typeof fieldTypeForRef !== "string" && !isBitfieldType(fieldTypeForRef)) {
            if (metadata[$refTypeFieldIndexes] === undefined) {
                Object.defineProperty(metadata, $refTypeFieldIndexes, {
                    value: [],
                    enumerable: false,
                    configurable: true,
                });
            }
            metadata[$refTypeFieldIndexes].push(index);
        }

        // `{ stream: ... }` collections are always view-scoped (priority-
        // batched emit). Auto-flag here so both `@type({stream: ...})` and
        // the `t.stream(...)` builder route into the same filter / encoder
        // dispatch without the caller needing an extra setStream() call.
        const t = metadata[index].type;
        if (t && typeof t === "object" && (t as any)["stream"] !== undefined) {
            // Reject the combined shorthand `@type({ array: X, stream:
            // true })` at decoration time — same diagnostic as the
            // builder chainable throws for `t.array(X).stream()`.
            if ((t as any).array !== undefined) {
                throw new Error(ARRAY_STREAM_NOT_SUPPORTED);
            }
            metadata[index].stream = true;
            if (!metadata[$streamFieldIndexes]) {
                Object.defineProperty(metadata, $streamFieldIndexes, {
                    value: [],
                    enumerable: false,
                    configurable: true,
                    writable: true,
                });
            }
            if (!metadata[$streamFieldIndexes].includes(index)) {
                metadata[$streamFieldIndexes].push(index);
            }
            // Pick up the declaration-scope priority callback if present in
            // the `@type({ stream: X, priority: fn })` shorthand.
            const priorityFn = (type as any)?.priority;
            if (typeof priorityFn === "function") {
                Metadata.setStreamPriority(metadata as any, name, priorityFn);
            }
        }
    },

    setTag(metadata: Metadata, fieldName: string, tag: number) {
        const index = metadata[fieldName];
        const field = metadata[index];

        // add 'tag' to the field
        field.tag = tag;

        if (!metadata[$viewFieldIndexes]) {
            // -2: all field indexes with "view" tag
            Object.defineProperty(metadata, $viewFieldIndexes, {
                value: [],
                enumerable: false,
                configurable: true
            });

            // -3: field indexes by "view" tag
            Object.defineProperty(metadata, $fieldIndexesByViewTag, {
                value: {},
                enumerable: false,
                configurable: true
            });
        }

        metadata[$viewFieldIndexes].push(index);

        if (!metadata[$fieldIndexesByViewTag][tag]) {
            metadata[$fieldIndexesByViewTag][tag] = [];
        }

        metadata[$fieldIndexesByViewTag][tag].push(index);
    },

    setUnreliable(metadata: Metadata, fieldName: string) {
        const index = metadata[fieldName];
        const fieldType = metadata[index].type;
        // `@unreliable` is only valid on primitive fields. Ref-type fields
        // (Schema sub-classes, MapSchema, ArraySchema, SetSchema,
        // CollectionSchema) carry refIds whose ADD/DELETE must arrive
        // on the reliable channel — otherwise a dropped unreliable packet
        // would leave the decoder unable to interpret subsequent packets
        // referencing the orphan refId. Primitive types are encoded as
        // strings ("number", "string", "int32", ...); anything else is a
        // ref. Reject at decoration time so the bug surfaces in dev, not
        // under packet loss in prod.
        if (typeof fieldType !== "string") {
            throw new Error(
                `@unreliable cannot be applied to ref-type field "${fieldName}". ` +
                `For ref-type fields, mark each primitive sub-field with @unreliable instead. ` +
                `See README "Limitations and best practices".`
            );
        }
        metadata[index].unreliable = true;

        if (!metadata[$unreliableFieldIndexes]) {
            Object.defineProperty(metadata, $unreliableFieldIndexes, {
                value: [],
                enumerable: false,
                configurable: true,
                writable: true,
            });
        }
        metadata[$unreliableFieldIndexes].push(index);
    },

    setTransient(metadata: Metadata, fieldName: string) {
        const index = metadata[fieldName];
        metadata[index].transient = true;

        if (!metadata[$transientFieldIndexes]) {
            Object.defineProperty(metadata, $transientFieldIndexes, {
                value: [],
                enumerable: false,
                configurable: true,
                writable: true,
            });
        }
        metadata[$transientFieldIndexes].push(index);
    },

    setStatic(metadata: Metadata, fieldName: string) {
        const index = metadata[fieldName];
        metadata[index].static = true;

        if (!metadata[$staticFieldIndexes]) {
            Object.defineProperty(metadata, $staticFieldIndexes, {
                value: [],
                enumerable: false,
                configurable: true,
                writable: true,
            });
        }
        metadata[$staticFieldIndexes].push(index);
    },

    setStream(metadata: Metadata, fieldName: string) {
        const index = metadata[fieldName];
        metadata[index].stream = true;

        if (!metadata[$streamFieldIndexes]) {
            Object.defineProperty(metadata, $streamFieldIndexes, {
                value: [],
                enumerable: false,
                configurable: true,
                writable: true,
            });
        }
        metadata[$streamFieldIndexes].push(index);
    },

    /**
     * Attach a declaration-scope priority callback to a stream field.
     * Called at schema definition time (via `t.stream(X).priority(fn)` or
     * `@type({ stream: X, priority: fn })`), looked up at stream-attach
     * time to seed the instance's `_stream.priority` slot. The callback
     * signature is `(view: StateView, element: V) => number` — only fires
     * during `encodeView`, broadcast mode emits FIFO regardless.
     */
    setStreamPriority(
        metadata: Metadata,
        fieldName: string,
        fn: (view: any, element: any) => number,
    ) {
        const index = metadata[fieldName];
        if (!metadata[$streamPriorities]) {
            Object.defineProperty(metadata, $streamPriorities, {
                value: {},
                enumerable: false,
                configurable: true,
                writable: true,
            });
        }
        metadata[$streamPriorities][index] = fn;
    },

    getStreamPriority(metadata: Metadata | undefined, index: number) {
        return metadata?.[$streamPriorities]?.[index];
    },

    setFields<T extends { new (...args: any[]): InstanceType<T> } = any>(target: T, fields: { [field in keyof InstanceType<T>]?: DefinitionType }) {
        // for inheritance support
        const constructor = target.prototype.constructor;
        TypeContext.register(constructor);

        const parentClass = Object.getPrototypeOf(constructor);
        const parentMetadata = parentClass && parentClass[Symbol.metadata];
        const metadata = Metadata.initialize(constructor);

        // Use Schema's methods if not defined in the class
        if (!constructor[$track]) { constructor[$track] = Schema[$track]; }
        if (!constructor[$encoder]) { constructor[$encoder] = Schema[$encoder]; }
        if (!constructor[$decoder]) { constructor[$decoder] = Schema[$decoder]; }
        if (!constructor.prototype.toJSON) { constructor.prototype.toJSON = Schema.prototype.toJSON; }

        //
        // detect index for this field, considering inheritance
        //
        let fieldIndex = metadata[$numFields] // current structure already has fields defined
            ?? (parentMetadata && parentMetadata[$numFields]) // parent structure has fields defined
            ?? -1; // no fields defined

        fieldIndex++;

        // Pre-computed encoder function table: metadata[$encoders][fieldIndex] = encode.uint8 etc.
        if (!metadata[$encoders]) {
            Object.defineProperty(metadata, $encoders, {
                value: parentMetadata?.[$encoders] ? [...parentMetadata[$encoders]] : [],
                enumerable: false,
                configurable: true,
                writable: true,
            });
        }

        for (const field in fields) {
            const type = getNormalizedType(fields[field]);

            const { complexTypeKlass, childType } = resolveFieldType(type);

            Metadata.addField(
                metadata,
                fieldIndex,
                field,
                type,
                getPropertyDescriptor(field, fieldIndex, childType, complexTypeKlass)
            );

            // Install accessor descriptor on the prototype (once per class field).
            if (metadata[$descriptors][field]) {
                Object.defineProperty(target.prototype, field, metadata[$descriptors][field]);
            }

            // Pre-compute encoder function for primitive / bitfield types.
            if (typeof type === "string") {
                metadata[$encoders][fieldIndex] = (encode as any)[type];
            } else if (isBitfieldType(type)) {
                metadata[$encoders][fieldIndex] = type.bitfield.encode;
            }

            fieldIndex++;
        }

        return target;
    },

    isDeprecated(metadata: any, field: string) {
        return metadata[field].deprecated === true;
    },

    initialize(constructor: any) {
        const parentClass = Object.getPrototypeOf(constructor);
        const parentMetadata: Metadata = parentClass[Symbol.metadata];

        let metadata: Metadata = constructor[Symbol.metadata] ?? Object.create(null);

        // make sure inherited classes have their own metadata object.
        if (parentClass !== Schema && metadata === parentMetadata) {
            metadata = Object.create(null);

            if (parentMetadata) {
                //
                // assign parent metadata to current
                //
                Object.setPrototypeOf(metadata, parentMetadata);

                // $numFields
                Object.defineProperty(metadata, $numFields, {
                    value: parentMetadata[$numFields],
                    enumerable: false,
                    configurable: true,
                    writable: true,
                });

                // $viewFieldIndexes / $fieldIndexesByViewTag
                if (parentMetadata[$viewFieldIndexes] !== undefined) {
                    Object.defineProperty(metadata, $viewFieldIndexes, {
                        value: [...parentMetadata[$viewFieldIndexes]],
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                    Object.defineProperty(metadata, $fieldIndexesByViewTag, {
                        value: { ...parentMetadata[$fieldIndexesByViewTag] },
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                }

                // $refTypeFieldIndexes
                if (parentMetadata[$refTypeFieldIndexes] !== undefined) {
                    Object.defineProperty(metadata, $refTypeFieldIndexes, {
                        value: [...parentMetadata[$refTypeFieldIndexes]],
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                }

                // $unreliableFieldIndexes
                if (parentMetadata[$unreliableFieldIndexes] !== undefined) {
                    Object.defineProperty(metadata, $unreliableFieldIndexes, {
                        value: [...parentMetadata[$unreliableFieldIndexes]],
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                }

                // $transientFieldIndexes
                if (parentMetadata[$transientFieldIndexes] !== undefined) {
                    Object.defineProperty(metadata, $transientFieldIndexes, {
                        value: [...parentMetadata[$transientFieldIndexes]],
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                }

                // $staticFieldIndexes
                if (parentMetadata[$staticFieldIndexes] !== undefined) {
                    Object.defineProperty(metadata, $staticFieldIndexes, {
                        value: [...parentMetadata[$staticFieldIndexes]],
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                }

                // $streamFieldIndexes
                if (parentMetadata[$streamFieldIndexes] !== undefined) {
                    Object.defineProperty(metadata, $streamFieldIndexes, {
                        value: [...parentMetadata[$streamFieldIndexes]],
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                }

                // $descriptors
                Object.defineProperty(metadata, $descriptors, {
                    value: { ...parentMetadata[$descriptors] },
                    enumerable: false,
                    configurable: true,
                    writable: true,
                });

                // $encoders
                if (parentMetadata[$encoders] !== undefined) {
                    Object.defineProperty(metadata, $encoders, {
                        value: [...parentMetadata[$encoders]],
                        enumerable: false,
                        configurable: true,
                        writable: true,
                    });
                }
            }
        }

        Object.defineProperty(constructor, Symbol.metadata, {
            value: metadata,
            writable: false,
            configurable: true
        });

        return metadata;
    },

    isValidInstance(klass: any) {
        return (
            klass.constructor[Symbol.metadata] &&
            Object.prototype.hasOwnProperty.call(klass.constructor[Symbol.metadata], $numFields) as boolean
        );
    },

    getFields(klass: any) {
        const metadata: Metadata = klass[Symbol.metadata];
        const fields: any = {};
        for (let i = 0; i <= metadata[$numFields]; i++) {
            fields[metadata[i].name] = metadata[i].type;
        }
        return fields;
    },

    hasViewTagAtIndex(metadata: Metadata, index: number) {
        return metadata?.[$viewFieldIndexes]?.includes(index);
    },

    hasUnreliableAtIndex(metadata: Metadata, index: number) {
        return metadata?.[$unreliableFieldIndexes]?.includes(index);
    },

    hasTransientAtIndex(metadata: Metadata, index: number) {
        return metadata?.[$transientFieldIndexes]?.includes(index);
    },

    hasStaticAtIndex(metadata: Metadata, index: number) {
        return metadata?.[$staticFieldIndexes]?.includes(index);
    },

    hasStreamAtIndex(metadata: Metadata, index: number) {
        return metadata?.[$streamFieldIndexes]?.includes(index);
    }
}