import { TypeContext, DefinitionType, PrimitiveType } from "./annotations";
import { $changes, Schema } from "./Schema";
import { MapSchema } from "./types/MapSchema";

import * as encode from "./encoding/encode";
import { EncodeSchemaError, assertInstanceType, assertType } from "./encoding/assert";
import { getType } from './types/typeRegistry';
import { SWITCH_TO_STRUCTURE, TYPE_ID, OPERATION } from './spec';
import { $encodeOperation, ChangeOperation, ChangeTracker, FieldChangeTracker, Root } from "./changes/ChangeTree";

export function encodePrimitiveType(
    type: PrimitiveType,
    bytes: number[],
    value: any,
    klass: Schema,
    field: string | number,
) {
    assertType(value, type as string, klass, field);

    const encodeFunc = encode[type as string];

    if (encodeFunc) {
        encodeFunc(bytes, value);

    } else {
        throw new EncodeSchemaError(`a '${type}' was expected, but ${value} was provided in ${klass.constructor.name}#${field}`);
    }
}

export class Encoder<T extends Schema = any> {
    context: TypeContext;
    changes = new Set<FieldChangeTracker>();

    root: T;
    $root: Root;

    constructor(root: T) {
        this.setRoot(root);

        //
        // TODO: cache and restore "Context" based on root schema
        // (to avoid creating a new context for each new room)
        //
        this.context = new TypeContext(root.constructor as typeof Schema);

        // console.log(">>>>>>>>>>>>>>>> Encoder types");
        // this.context.schemas.forEach((id, schema) => {
        //     console.log("type:", id, schema.name, Object.keys(schema[Symbol.metadata]));
        // });
    }

    protected setRoot(root: T) {
        this.$root = new Root();
        this.root = root;
        root[$changes].setRoot(this.$root);
    }

    encode(
        encodeAll = false,
        bytes: number[] = [],
        useFilters: boolean = false,
    ) {
        const rootChangeTree = this.root[$changes];
        // const refIdsVisited = new WeakSet<ChangeTree>();

        const changeTrees: ChangeTracker[] = Array.from(this.$root.changes);
        const numChangeTrees = changeTrees.length;
        // let numChangeTrees = 1;

        // console.log("--------------------- ENCODE ----------------");
        // console.log("Encode order:", changeTrees.map((c) => c.ref['constructor'].name));
        for (let i = 0; i < numChangeTrees; i++) {
            const changeTree = changeTrees[i];
            const ref = changeTree.ref;

            const isSchema = (ref instanceof Schema);
            const metadata = ref['constructor'][Symbol.metadata];

            // const encodeOperation = changeTree['constructor'][$encodeOperation];

            // Generate unique refId for the ChangeTree.
            changeTree.ensureRefId();

            // // mark this ChangeTree as visited.
            // refIdsVisited.add(changeTree);

            // root `refId` is skipped.
            if (
                changeTree !== rootChangeTree &&
                (changeTree.changed || encodeAll)
            ) {
                encode.uint8(bytes, SWITCH_TO_STRUCTURE);
                encode.number(bytes, changeTree.refId);
            }

            const changes: ChangeOperation[] | number[] = (encodeAll)
                ? Array.from(changeTree.allChanges)
                : Array.from(changeTree.changes.values());

            for (let j = 0, cl = changes.length; j < cl; j++) {
                const operation: ChangeOperation = (encodeAll)
                    ? { op: OPERATION.ADD, index: changes[j] as number }
                    : changes[j] as ChangeOperation;

                // encodeOperation(this, bytes, operation, changeTree);

                const fieldIndex = operation.index;

                const field = (isSchema)
                    ? metadata[fieldIndex]
                    : fieldIndex;

                // encode field index + operation
                if (operation.op !== OPERATION.TOUCH) {
                    if (isSchema) {
                        //
                        // Compress `fieldIndex` + `operation` into a single byte.
                        // This adds a limitaion of 64 fields per Schema structure
                        //
                        encode.uint8(bytes, (fieldIndex | operation.op));

                    } else {
                        encode.uint8(bytes, operation.op);

                        // custom operations
                        if (operation.op === OPERATION.CLEAR) {
                            continue;
                        }

                        // indexed operations
                        encode.number(bytes, fieldIndex);
                    }
                }

                //
                // encode "alias" for dynamic fields (maps)
                //
                if (
                    !isSchema &&
                    (operation.op & OPERATION.ADD) == OPERATION.ADD // ADD or DELETE_AND_ADD
                ) {
                    if (ref instanceof MapSchema) {
                        //
                        // MapSchema dynamic key
                        //
                        const dynamicIndex = changeTree.ref['$indexes'].get(fieldIndex);
                        encode.string(bytes, dynamicIndex);
                    }
                }

                if (operation.op === OPERATION.DELETE) {
                    //
                    // TODO: delete from filter cache data.
                    //
                    // if (useFilters) {
                    //     delete changeTree.caches[fieldIndex];
                    // }
                    continue;
                }

                // const type = changeTree.childType || ref._schema[field];
                const type = (isSchema)
                    ? metadata[metadata[fieldIndex]].type
                    : changeTree.getType(fieldIndex);

                // const type = changeTree.getType(fieldIndex);
                const value = (isSchema)
                    ? ref[metadata[fieldIndex]]
                    : changeTree.getValue(fieldIndex);

                // ensure refId for the value
                if (value && value[$changes]) {
                    value[$changes].ensureRefId();
                }

                if (operation.op === OPERATION.TOUCH) {
                    continue;
                }

                if (Schema.is(type)) {
                    assertInstanceType(value, type as typeof Schema, ref as Schema, field);

                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    encode.number(bytes, value[$changes].refId);

                    // Try to encode inherited TYPE_ID if it's an ADD operation.
                    if ((operation.op & OPERATION.ADD) === OPERATION.ADD) {
                        this.tryEncodeTypeId(bytes, type as typeof Schema, value.constructor as typeof Schema);
                    }

                } else if (typeof(type) === "string") {
                    //
                    // Primitive values
                    //
                    encodePrimitiveType(type as PrimitiveType, bytes, value, ref as Schema, field);

                } else {
                    //
                    // Custom type (MapSchema, ArraySchema, etc)
                    //
                    const definition = getType(Object.keys(type)[0]);

                    //
                    // ensure a ArraySchema has been provided
                    //
                    assertInstanceType(ref[field], definition.constructor, ref as Schema, field);

                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    encode.number(bytes, value[$changes].refId);
                }

                // if (useFilters) {
                //     // cache begin / end index
                //     changeTree.cache(fieldIndex as number, bytes.slice(beginIndex));
                // }
            }

            if (!encodeAll && !useFilters) {
                changeTree.discard();
            }
        }

        return bytes;
    }

    encodeAll (useFilters?: boolean) {
        return this.encode(true, [], useFilters);
    }

    tryEncodeTypeId (bytes: number[], baseType: typeof Schema, targetType: typeof Schema) {
        const baseTypeId = this.context.getTypeId(baseType);
        const targetTypeId = this.context.getTypeId(targetType);

        if (baseTypeId !== targetTypeId) {
            encode.uint8(bytes, TYPE_ID);
            encode.number(bytes, targetTypeId);
        }
    }

}