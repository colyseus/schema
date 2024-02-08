import { TypeContext, DefinitionType, PrimitiveType } from "./annotations";
import { Schema } from "./Schema";
import { CollectionSchema } from "./types/CollectionSchema";
import { MapSchema } from "./types/MapSchema";
import { SetSchema } from "./types/SetSchema";
import { ArraySchema } from "./types/ArraySchema";

import * as encode from "./encoding/encode";
import { getType } from './types/typeRegistry';
import { SWITCH_TO_STRUCTURE, TYPE_ID, OPERATION } from './spec';
import { ChangeOperation, ChangeTree, Root } from "./changes/ChangeTree";

class EncodeSchemaError extends Error {}

function assertType(value: any, type: string, klass: Schema, field: string | number) {
    let typeofTarget: string;
    let allowNull: boolean = false;

    switch (type) {
        case "number":
        case "int8":
        case "uint8":
        case "int16":
        case "uint16":
        case "int32":
        case "uint32":
        case "int64":
        case "uint64":
        case "float32":
        case "float64":
            typeofTarget = "number";
            if (isNaN(value)) {
                console.log(`trying to encode "NaN" in ${klass.constructor.name}#${field}`);
            }
            break;
        case "string":
            typeofTarget = "string";
            allowNull = true;
            break;
        case "boolean":
            // boolean is always encoded as true/false based on truthiness
            return;
    }

    if (typeof (value) !== typeofTarget && (!allowNull || (allowNull && value !== null))) {
        let foundValue = `'${JSON.stringify(value)}'${(value && value.constructor && ` (${value.constructor.name})`) || ''}`;
        throw new EncodeSchemaError(`a '${typeofTarget}' was expected, but ${foundValue} was provided in ${klass.constructor.name}#${field}`);
    }
}

function assertInstanceType(
    value: Schema,
    type: typeof Schema
        | typeof ArraySchema
        | typeof MapSchema
        | typeof CollectionSchema
        | typeof SetSchema,
    klass: Schema,
    field: string | number,
) {
    if (!(value instanceof type)) {
        throw new EncodeSchemaError(`a '${type.name}' was expected, but '${(value as any).constructor.name}' was provided in ${klass.constructor.name}#${field}`);
    }
}

function encodePrimitiveType(
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

export class Encoder<T extends Schema> {
    context: TypeContext;
    changes = new Set<ChangeTree>();

    root: T;
    $root: Root;

    constructor(root: T) {
        this.setRoot(root);

        //
        // TODO: cache and restore "Context" based on root schema
        // (to avoid creating a new context for each new room)
        //
        this.context = new TypeContext(root.constructor as typeof Schema);

        console.log(">>>>>>>>>>>>>>>> Encoder types");
        this.context.schemas.forEach((id, schema) => {
            console.log("type:", id, schema[Symbol.metadata]['def'].schema);
        });
    }

    protected setRoot(root: T) {
        this.$root = new Root();
        this.root = root;
        root['$changes'].setRoot(this.$root);
    }

    encode(
        encodeAll = false,
        bytes: number[] = [],
        useFilters: boolean = false,
    ) {
        console.log("--------------------- ENCODE ----------------");
        const rootChangeTree = this.root['$changes'];
        // const refIdsVisited = new WeakSet<ChangeTree>();

        const changeTrees: ChangeTree[] = Array.from(this.$root['changes']);
        const numChangeTrees = changeTrees.length;
        // let numChangeTrees = 1;

        console.log("Encode order:", changeTrees.map((c) => c.ref['constructor'].name));

        for (let i = 0; i < numChangeTrees; i++) {
            const changeTree = changeTrees[i];
            const ref = changeTree.ref;
            const isSchema = (ref instanceof Schema);

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
                console.log("changeTree.refId", changeTree.refId, `(${changeTree.ref['constructor'].name})`);
            }

            const changes: ChangeOperation[] | number[] = (encodeAll)
                ? Array.from(changeTree.allChanges)
                : Array.from(changeTree.changes.values());

            for (let j = 0, cl = changes.length; j < cl; j++) {
                const operation: ChangeOperation = (encodeAll)
                    ? { op: OPERATION.ADD, index: changes[j] as number }
                    : changes[j] as ChangeOperation;

                const fieldIndex = operation.index;

                const field = (isSchema)
                    ? ref['_definition'].fieldsByIndex && ref['_definition'].fieldsByIndex[fieldIndex]
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
                const type = changeTree.getType(fieldIndex);

                // const type = changeTree.getType(fieldIndex);
                const value = changeTree.getValue(fieldIndex);

                // ensure refId for the value
                if (value && value['$changes']) {
                    value['$changes'].ensureRefId();
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
                    encode.number(bytes, value.$changes.refId);

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
                    encode.number(bytes, value.$changes.refId);
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

    private tryEncodeTypeId (bytes: number[], baseType: typeof Schema, targetType: typeof Schema) {
        const baseTypeId = this.context.getTypeId(baseType);
        const targetTypeId = this.context.getTypeId(targetType);

        // console.log({
        //     baseType: baseType.name,
        //     baseTypeId,
        //     targetType: targetType.name,
        //     targetTypeId,
        // });

        if (baseTypeId !== targetTypeId) {
            encode.uint8(bytes, TYPE_ID);
            encode.number(bytes, targetTypeId);
        }
    }

}