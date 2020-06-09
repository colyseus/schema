import { SWITCH_TO_STRUCTURE, TYPE_ID, OPERATION } from './spec';
import { Definition, FilterCallback, Client, PrimitiveType, Context, SchemaDefinition } from "./annotations";

import * as encode from "./encoding/encode";
import * as decode from "./encoding/decode";

import { ArraySchema } from "./types/ArraySchema";
import { MapSchema } from "./types/MapSchema";

import { ChangeTree } from "./changes/ChangeTree";
import { NonFunctionPropNames } from './types/HelperTypes';
import { EventEmitter } from './events/EventEmitter';
import { Ref } from './changes/Root';

export interface DataChange<T=any> {
    field: number | string;
    value: T;
    previousValue: T;
}

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
        let foundValue = `'${JSON.stringify(value)}'${(value && value.constructor && ` (${value.constructor.name})`)}`;
        throw new EncodeSchemaError(`a '${typeofTarget}' was expected, but ${foundValue} was provided in ${klass.constructor.name}#${field}`);
    }
}

function assertInstanceType(
    value: Schema,
    type: typeof Schema | typeof ArraySchema | typeof MapSchema,
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

function decodePrimitiveType (type: string, bytes: number[], it: decode.Iterator) {
    return decode[type as string](bytes, it);
}

/**
 * Schema encoder / decoder
 */
export abstract class Schema {
    static _typeid: number;
    static _context: Context;

    static _definition: SchemaDefinition;

    static onError(e) {
        console.error(e);
    }

    static is(type: any) {
        return type['_schema'] !== undefined;
    }

    protected $changes: ChangeTree;
    // protected $root: ChangeSet;

    protected $listeners: { [field: string]: EventEmitter<(a: any, b: any) => void> };

    public onChange?(changes: DataChange[]);
    public onRemove?();

    // allow inherited classes to have a constructor
    constructor(...args: any[]) {
        // fix enumerability of fields for end-user
        Object.defineProperties(this, {
            $changes: {
                value: new ChangeTree(this, this._indexes),
                enumerable: false,
                writable: true
            },
            $listeners: {
                value: {},
                enumerable: false,
                writable: true
            },
        });

        const descriptors = this._descriptors;
        if (descriptors) {
            Object.defineProperties(this, descriptors);
        }

        //
        // Assign initial values
        //
        if (args[0]) {
            this.assign(args[0]);
        }
    }

    public assign(
        props: { [prop in NonFunctionPropNames<this>]: this[prop] }
    ) {
        Object.assign(this, props);
        return this;
    }

    protected get _schema () { return (this.constructor as typeof Schema)._definition.schema; }
    protected get _descriptors () { return (this.constructor as typeof Schema)._definition.descriptors; }
    protected get _indexes () { return (this.constructor as typeof Schema)._definition.indexes; }
    protected get _fieldsByIndex() { return (this.constructor as typeof Schema)._definition.fieldsByIndex; }
    protected get _filters () { return (this.constructor as typeof Schema)._definition.filters; }
    protected get _childFilters () { return (this.constructor as typeof Schema)._definition.childFilters; }
    protected get _deprecated () { return (this.constructor as typeof Schema)._definition.deprecated; }

    public listen <K extends NonFunctionPropNames<this>>(attr: K, callback: (value: this[K], previousValue: this[K]) => void) {
        if (!this.$listeners[attr as string]) {
            this.$listeners[attr as string] = new EventEmitter();
        }
        this.$listeners[attr as string].register(callback);

        // return un-register callback.
        return () =>
            this.$listeners[attr as string].remove(callback);
    }

    decode(
        bytes: number[],
        it: decode.Iterator = { offset: 0 },
        ref?: Ref,
        changes: DataChange[] = [],
    ) {
        const $root = this.$changes.root;
        const totalBytes = bytes.length;

        console.log("REFS =>", Array.from($root.refs));

        while (it.offset < totalBytes) {
            let byte = bytes[it.offset++];

            if (byte === SWITCH_TO_STRUCTURE) {
                const refId = decode.number(bytes, it);

                if (!$root.refs.has(refId)) {
                    $root.refs.set(refId, this);
                    ref = this;

                } else {
                    ref = $root.refs.get(refId) as Schema;
                }

                continue;
            }

            const operation = byte;
            const fieldIndex = decode.number(bytes, it);

            const field = (ref['_fieldsByIndex'] && ref['_fieldsByIndex'][fieldIndex]) || fieldIndex;
            const _field = `_${field}`;

            let type = ref['$changes'].childType || ref['_schema'][field];
            let value: any;

            let dynamicIndex: number | string;
            let hasChange = false;

            if (
                ref['$changes'].childType &&
                operation === OPERATION.ADD
            ) {
                dynamicIndex = decode.string(bytes, it);
                ref['setIndex'](field, dynamicIndex as string);
            }

            if (field === undefined) {
                continue;

            } else if (operation === OPERATION.DELETE) {
                //
                // TODO: remove from $root.refs
                //

                value = null;
                hasChange = true;

            } else if (Schema.is(type)) {
                const refId = decode.number(bytes, it);

                if (operation === OPERATION.ADD) {
                    value = this.createTypeInstance(bytes, it, type as typeof Schema);
                    $root.refs.set(refId, value);

                } else {
                    value = $root.refs.get(refId);
                }

                // value.decode(bytes, it, value);

                hasChange = true;

            } else if (ArraySchema.is(type)) {
                type = type[0];

                const valueRef: ArraySchema = this[_field] || new ArraySchema();
                value = valueRef.clone(true);

                const newLength = decode.number(bytes, it);
                const numChanges = Math.min(decode.number(bytes, it), newLength);

                const hasRemoval = (value.length > newLength);
                hasChange = (numChanges > 0) || hasRemoval;

                // FIXME: this may not be reliable. possibly need to encode this variable during serialization
                let hasIndexChange = false;

                // ensure current array has the same length as encoded one
                if (hasRemoval) {
                    // decrease removed items from number of changes.
                    // no need to iterate through them, as they're going to be removed.

                    Array.prototype.splice.call(value, newLength).forEach((itemRemoved, i) => {
                        if (itemRemoved && itemRemoved.onRemove) {
                            try {
                                itemRemoved.onRemove();
                            } catch (e) {
                                Schema.onError(e);
                            }
                        }

                        if (valueRef.onRemove) {
                            try {
                                valueRef.onRemove(itemRemoved, newLength + i);
                            } catch (e) {
                                Schema.onError(e);
                            }
                        }
                    });
                }

                for (let i = 0; i < numChanges; i++) {
                    const newIndex = decode.number(bytes, it);

                    let indexChangedFrom: number; // index change check
                    if (decode.indexChangeCheck(bytes, it)) {
                        decode.uint8(bytes, it);
                        indexChangedFrom = decode.number(bytes, it);
                        hasIndexChange = true;
                    }

                    let isNew = (!hasIndexChange && value[newIndex] === undefined) || (hasIndexChange && indexChangedFrom === undefined);

                    if ((type as any).prototype instanceof Schema) {
                        let item: Schema;

                        if (isNew) {
                            item = this.createTypeInstance(bytes, it, type as typeof Schema);

                        } else if (indexChangedFrom !== undefined) {
                            item = valueRef[indexChangedFrom];

                        } else {
                            item = valueRef[newIndex]
                        }

                        if (!item) {
                            item = this.createTypeInstance(bytes, it, type as typeof Schema);
                            isNew = true;
                        }

                        item.decode(bytes, it);
                        value[newIndex] = item;

                    } else {
                        value[newIndex] = decodePrimitiveType(type as string, bytes, it);
                    }

                    if (isNew) {
                        if (valueRef.onAdd) {
                            try {
                                valueRef.onAdd(value[newIndex], newIndex);
                            } catch (e) {
                                Schema.onError(e);
                            }
                        }

                    } else if (valueRef.onChange) {
                        try {
                            valueRef.onChange(value[newIndex], newIndex);
                        } catch (e) {
                            Schema.onError(e);
                        }
                    }
                }


            } else if (MapSchema.is(type)) {
                const childType = (type as any).map;

                const valueRef: MapSchema = this[_field] || new MapSchema();
                value = valueRef.clone(true);

                const refId = decode.number(bytes, it);
                $root.refs.set(refId, value);

                (value.$changes as ChangeTree).childType = childType;

            } else {
                value = decodePrimitiveType(type as string, bytes, it);
                hasChange = true;
            }

            if (
                // hasChange &&
                (
                    this.onChange
                    // || ref.$listeners[field]
                )
            ) {
                changes.push({
                    field,
                    value,
                    previousValue: ref[_field]
                });
            }

            if (ref instanceof Schema) {
                ref[_field] = value;

            } else if (ref instanceof MapSchema) {
                const key = ref['$indexes'].get(field);
                ref.set(key, value);
            }

        }

        this._triggerChanges(changes);

        return changes;
    }

    encode(
        root: Schema = this,
        encodeAll = false,
        bytes: number[] = [],
        useFilters: boolean = false,
    ) {
        const $root = root.$changes.root;

        const changeTrees = (encodeAll)
            ? Array.from($root.allChanges)
            : Array.from($root.changes);

        console.log("ChangeTrees =>", changeTrees);

        for (let i = 0, l = changeTrees.length; i < l; i++) {
            const changeTree = changeTrees[i];
            const ref = changeTree.ref as Schema;
            // const indexes = change.indexes;

            // root `refId` is skipped.
            console.log("ENCODE, refId =>", changeTree.refId, {
                isSchema: ref instanceof Schema,
                isMap: ref instanceof MapSchema,
                isArray: ref instanceof ArraySchema,
            });

            encode.uint8(bytes, SWITCH_TO_STRUCTURE);
            encode.number(bytes, changeTree.refId);

            const changes = (encodeAll)
                ? Array.from(changeTree.allChanges)
                : Array.from(changeTree.changes.keys());

            for (let j = 0, cl = changes.length; j < cl; j++) {
                const fieldIndex = changes[j];
                const operation = changeTree.changes.get(fieldIndex);

                const field = (ref._fieldsByIndex && ref._fieldsByIndex[fieldIndex]) || fieldIndex;
                const _field = `_${field}`;

                const type = changeTree.childType || ref._schema[field];

                // const type = changeTree.getType(fieldIndex);
                const value = changeTree.getValue(fieldIndex);

                // cache begin index if `useFilters`
                const beginIndex = bytes.length;

                // encode field index + operation
                encode.uint8(bytes, operation.op);
                encode.number(bytes, fieldIndex);

                //
                // encode "alias" for dynamic fields (maps)
                //
                if (
                    changeTree.ref instanceof MapSchema &&
                    operation.op === OPERATION.ADD
                ) {
                    const dynamicIndex = changeTree.ref['$indexes'].get(fieldIndex);

                    console.log("ENCODE DYNAMIC INDEX:", { dynamicIndex });

                    encode.string(bytes, dynamicIndex);
                }

                if (operation.op === OPERATION.DELETE) {
                    // TODO: delete from $root.cache
                    continue;
                }

                if (Schema.is(type)) {
                    assertInstanceType(value, type as typeof Schema, ref, field);
                    this.tryEncodeTypeId(bytes, type as typeof Schema, value.constructor as typeof Schema);

                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    encode.number(bytes, value.$changes.refId);

                } else if (ArraySchema.is(type)) {
                    console.log("ENCODING ARRAY!");
                    const $changes: ChangeTree = value.$changes;

                    // total number of items in the array
                    encode.number(bytes, value.length);

                    const arrayChanges = Array.from(
                        (encodeAll)
                            ? Array.from($changes.allChanges)
                            : Array.from($changes.changes.keys())
                        )
                        .filter(index => ref[_field][index] !== undefined)
                        .sort((a: number, b: number) => a - b);

                    // ensure number of changes doesn't exceed array length
                    const numChanges = arrayChanges.length;

                    // number of changed items
                    encode.number(bytes, numChanges);

                    const isChildSchema = typeof(type[0]) !== "string";

                    // console.log({ arrayChanges, numChanges, isChildSchema, arrayLength: value.length });

                    // assert ArraySchema was provided
                    assertInstanceType(ref[_field], ArraySchema, ref, field);

                    // encode Array of type
                    for (let j = 0; j < numChanges; j++) {
                        const index = arrayChanges[j];
                        const item = ref[_field][index];

                        // console.log({ index, item });

                        if (isChildSchema) { // is array of Schema
                            encode.number(bytes, index);

                            if (!encodeAll) {
                                // const indexChange = $changes.getIndexChange(item);
                                // if (indexChange !== undefined) {
                                //     encode.uint8(bytes, INDEX_CHANGE);
                                //     encode.number(bytes, indexChange);
                                // }
                            }

                            assertInstanceType(item, type[0] as typeof Schema, ref, field);
                            this.tryEncodeTypeId(bytes, type[0] as typeof Schema, item.constructor as typeof Schema);

                            (item as Schema).encode(root, encodeAll, bytes, useFilters);

                        } else if (item !== undefined) { // is array of primitives
                            encode.number(bytes, index);
                            encodePrimitiveType(type[0], bytes, item, ref, field);
                        }
                    }

                    if (!encodeAll && !useFilters) {
                        $changes.discard();
                    }

                } else if (MapSchema.is(type)) {
                    //
                    // ensure a MapSchema has been provided
                    //
                    assertInstanceType(ref[_field], MapSchema, ref, field);

                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    encode.number(bytes, value.$changes.refId);

                } else {
                    encodePrimitiveType(type as PrimitiveType, bytes, value, ref, field)
                }

                if (useFilters) {
                    // cache begin / end index
                    changeTree.cache(fieldIndex as number, beginIndex, bytes.length)
                }
            }

            if (!encodeAll && !useFilters) {
                changeTree.discard();
            }
        }

        return bytes;
    }

    encodeAll (bytes?: number[]) {
        return this.encode(this, true, bytes);
    }

    applyFilters(encodedBytes: number[], client: Client, root = this) {
        let filteredBytes: number[] = [];

        const changeTrees = Array.from(this.$changes.root.changes);
        for (let i = 0, l = changeTrees.length; i < l; i++) {
            const changeTree = changeTrees[i];
            const ref = changeTree.ref as Schema;
            const filters = ref._filters;

            encode.uint8(filteredBytes, SWITCH_TO_STRUCTURE);
            encode.number(filteredBytes, ref.$changes.refId);

            changeTree.changes.forEach((change, fieldIndex) => {
                if (change.op === OPERATION.DELETE) {
                    encode.uint8(filteredBytes, change.op);
                    encode.number(filteredBytes, fieldIndex);
                    return;
                }

                const cache = ref.$changes.caches[fieldIndex];
                const value = ref.$changes.getValue(fieldIndex);

                if (
                    ref instanceof MapSchema ||
                    ref instanceof ArraySchema
                ) {
                    const parent = ref['$changes'].parent.ref as Schema;
                    const filter = changeTree.childrenFilter;

                    if (filter && !filter.call(parent, client, ref['$indexes'].get(fieldIndex), value, root)) {
                        console.log("SKIPPING", fieldIndex)
                        return;
                    }

                } else {
                    const filter = (filters && filters[fieldIndex]);

                    if (filter && !filter.call(this, client, value, root)) {
                        console.log("SKIPPING", fieldIndex)
                        return;
                    }
                }

                filteredBytes = filteredBytes.concat(encodedBytes.slice(cache.beginIndex, cache.endIndex));
            });
        }

        return filteredBytes;
    }

    clone () {
        const cloned = new ((this as any).constructor);
        const schema = this._schema;
        for (let field in schema) {
            if (
                typeof (this[field]) === "object" &&
                typeof (this[field].clone) === "function"
            ) {
                // deep clone
                cloned[field] = this[field].clone();

            } else {
                // primitive values
                cloned[field] = this[field];
            }
        }
        return cloned;
    }

    triggerAll() {
        const changes: DataChange[] = [];
        const schema = this._schema;

        for (let field in schema) {
            if (this[field] !== undefined) {
                changes.push({
                    field,
                    value: this[field],
                    previousValue: undefined
                });
            }
        }

        try {
            this._triggerChanges(changes);

        } catch (e) {
            Schema.onError(e);
        }
    }

    toJSON () {
        const schema = this._schema;
        const deprecated = this._deprecated;

        const obj = {}
        for (let field in schema) {
            if (!deprecated[field] && this[field] !== null && typeof (this[field]) !== "undefined") {
                obj[field] = (typeof (this[field].toJSON) === "function")
                    ? this[field].toJSON()
                    : this[`_${field}`];
            }
        }
        return obj;
    }

    discardAllChanges() {
        const schema = this._schema;
        const changes = Array.from(this.$changes.changes);
        const fieldsByIndex = this._fieldsByIndex;

        for (const index in changes) {
            const field = fieldsByIndex[index];
            const type = schema[field];
            const value = this[field];

            // skip unchagned fields
            if (value === undefined) { continue; }

            if ((type as any)._schema) {
                (value as Schema).discardAllChanges();

            } else if (ArraySchema.is(type)) {
                for (let i = 0, l = value.length; i < l; i++) {
                    const index = value[i];
                    const item = this[`_${field}`][index];

                    if (typeof(type[0]) !== "string" && item) { // is array of Schema
                        (item as Schema).discardAllChanges()
                    }
                }

                value.$changes.discard();

            } else if (MapSchema.is(type)) {
                const keys = value;
                const mapKeys = Object.keys(this[`_${field}`]);

                for (let i = 0; i < keys.length; i++) {
                    const key = mapKeys[keys[i]] || keys[i];
                    const item = this[`_${field}`][key];

                    if (item instanceof Schema && item) {
                        item.discardAllChanges();
                    }
                }

                value.$changes.discard();
            }
        }

        this.$changes.discard();
    }

    protected getByIndex(index: number) {
        return this[this._fieldsByIndex[index]];
    }

    private tryEncodeTypeId (bytes: number[], type: typeof Schema, targetType: typeof Schema) {
        if (type._typeid !== targetType._typeid) {
            encode.uint8(bytes, TYPE_ID);
            encode.uint8(bytes, targetType._typeid);
        }
    }

    private createTypeInstance (bytes: number[], it: decode.Iterator, type: typeof Schema): Schema {
        let instance: Schema;

        if (bytes[it.offset] === TYPE_ID) {
            it.offset++;
            const anotherType = (this.constructor as typeof Schema)._context.get(decode.uint8(bytes, it));
            instance = new (anotherType as any)();

        } else {
            instance = new (type as any)();
        }

        // assign root on $changes
        instance.$changes.root = this.$changes.root;

        return instance;
    }

    private _triggerChanges(changes: DataChange[]) {
        if (changes.length > 0) {
            for (let i = 0; i < changes.length; i++) {
                const change = changes[i];
                const listener = this.$listeners[change.field];
                if (listener) {
                    try {
                        listener.invoke(change.value, change.previousValue);
                    } catch (e) {
                        Schema.onError(e);
                    }
                }
            }

            if (this.onChange) {
                try {
                    this.onChange(changes);
                } catch (e) {
                    Schema.onError(e);
                }
            }
        }

    }
}
