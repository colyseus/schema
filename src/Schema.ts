import { END_OF_STRUCTURE, NIL, INDEX_CHANGE, TYPE_ID } from './spec';
import { Definition, FilterCallback, Client, PrimitiveType, Context } from "./annotations";

import * as encode from "./encoding/encode";
import * as decode from "./encoding/decode";

import { ArraySchema } from "./types/ArraySchema";
import { MapSchema } from "./types/MapSchema";

import { ChangeTree } from "./ChangeTree";

export interface DataChange<T=any> {
    field: string;
    value: T;
    previousValue: T;
}

class EncodeSchemaError extends Error {}

function assertType(value: any, type: string, klass: Schema, field: string) {
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

function assertInstanceType(value: Schema, type: typeof Schema | typeof ArraySchema | typeof MapSchema, klass: Schema, field: string) {
    if (!(value instanceof type)) {
        throw new EncodeSchemaError(`a '${type.name}' was expected, but '${(value as any).constructor.name}' was provided in ${klass.constructor.name}#${field}`);
    }
}

function encodePrimitiveType (type: PrimitiveType, bytes: number[], value: any, klass: Schema, field: string) {
    const encodeFunc = encode[type as string];

    if (value === undefined) {
        bytes.push(NIL);

    } else {
        assertType(value, type as string, klass, field);
    }

    if (encodeFunc) {
        encodeFunc(bytes, value);
        return true;

    } else {
        return false;
    }
}

function decodePrimitiveType (type: string, bytes: number[], it: decode.Iterator) {
    const decodeFunc = decode[type as string];

    if (decodeFunc) {
        return decodeFunc(bytes, it);

    } else {
        return null;
    }
}

/**
 * Schema encoder / decoder
 */
export abstract class Schema {
    static _typeid: number;
    static _context: Context;

    static _schema: Definition;
    static _indexes: {[field: string]: number};
    static _filters: {[field: string]: FilterCallback};
    static _descriptors: PropertyDescriptorMap & ThisType<any>;

    static onError(e) {
        console.error(e);
    }

    protected $changes: ChangeTree;

    public onChange?(changes: DataChange[]);
    public onRemove?();

    // allow inherited classes to have a constructor
    constructor(...args: any[]) {
        // fix enumerability of fields for end-user
        Object.defineProperties(this, {
            $changes: { value: new ChangeTree(), enumerable: false, writable: true },
        });

        const descriptors = this._descriptors;
        if (descriptors) {
            Object.defineProperties(this, descriptors);
        }
    }

    get _schema () { return (this.constructor as typeof Schema)._schema; }
    get _descriptors () { return (this.constructor as typeof Schema)._descriptors; }
    get _indexes () { return (this.constructor as typeof Schema)._indexes; }
    get _filters () { return (this.constructor as typeof Schema)._filters; }

    get $changed () { return this.$changes.changed; }

    decode(bytes, it: decode.Iterator = { offset: 0 }) {
        const changes: DataChange[] = [];

        const schema = this._schema;
        const indexes = this._indexes;

        const fieldsByIndex = {}
        Object.keys(indexes).forEach((key) => {
            const value = indexes[key];
            fieldsByIndex[value] = key
        })

        const totalBytes = bytes.length;

        // skip TYPE_ID of existing instances
        if (bytes[it.offset] === TYPE_ID) {
            it.offset += 2;
        }

        while (it.offset < totalBytes) {
            const index = bytes[it.offset++];

            if (index === END_OF_STRUCTURE) {
                // reached end of strucutre. skip.
                break;
            }

            const field = fieldsByIndex[index];

            let type = schema[field];
            let value: any;

            let change: any; // for triggering onChange
            let hasChange = false;

            if ((type as any)._schema) {
                if (decode.nilCheck(bytes, it)) {
                    it.offset++;
                    value = null;

                } else {
                    value = this[`_${field}`] || this.createTypeInstance(bytes, it, type as typeof Schema);
                    value.decode(bytes, it);
                }

                hasChange = true;

            } else if (Array.isArray(type)) {
                type = type[0];
                change = [];

                const valueRef: ArraySchema = this[`_${field}`] || new ArraySchema();
                value = valueRef.clone();

                const newLength = decode.number(bytes, it);
                const numChanges = Math.min(decode.number(bytes, it), newLength);
                hasChange = (numChanges > 0);

                // FIXME: this may not be reliable. possibly need to encode this variable during
                // serializagion
                let hasIndexChange = false;

                // ensure current array has the same length as encoded one
                if (value.length > newLength) {
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

                    // // Simplified method?
                    // let isNew = (
                    //     (value[newIndex] !== valueRef[newIndex]) ||
                    //     (value[newIndex] === undefined && valueRef[newIndex] === undefined)
                    // ) && indexChangedFrom === undefined;

                    let isNew = (!hasIndexChange && !value[newIndex]) || (hasIndexChange && indexChangedFrom === undefined);

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

                        if (decode.nilCheck(bytes, it)) {
                            it.offset++;

                            if (valueRef.onRemove) {
                                try {
                                    valueRef.onRemove(item, newIndex);
                                } catch (e) {
                                    Schema.onError(e);
                                }
                            }

                            continue;
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

                    change.push(value[newIndex]);
                }


            } else if ((type as any).map) {
                type = (type as any).map;

                const valueRef: MapSchema = this[`_${field}`] || new MapSchema();
                value = valueRef.clone();

                const length = decode.number(bytes, it);
                hasChange = (length > 0);

                // FIXME: this may not be reliable. possibly need to encode this variable during
                // serializagion
                let hasIndexChange = false;

                const previousKeys = Object.keys(valueRef);

                for (let i = 0; i < length; i++) {
                    // `encodeAll` may indicate a higher number of indexes it actually encodes
                    // TODO: do not encode a higher number than actual encoded entries
                    if (
                        bytes[it.offset] === undefined ||
                        bytes[it.offset] === END_OF_STRUCTURE
                    ) {
                        break;
                    }

                    // index change check
                    let previousKey: string;
                    if (decode.indexChangeCheck(bytes, it)) {
                        decode.uint8(bytes, it);
                        previousKey = previousKeys[decode.number(bytes, it)];
                        hasIndexChange = true;
                    }

                    const hasMapIndex = decode.numberCheck(bytes, it);
                    const isSchemaType = typeof(type) !== "string";

                    const newKey = (hasMapIndex)
                        ? previousKeys[decode.number(bytes, it)]
                        : decode.string(bytes, it);

                    let item;
                    let isNew = (!hasIndexChange && !valueRef[newKey]) || (hasIndexChange && previousKey === undefined && hasMapIndex);

                    if (isNew && isSchemaType) {
                        item = this.createTypeInstance(bytes, it, type as typeof Schema);

                    } else if (previousKey !== undefined) {
                        item = valueRef[previousKey];

                    } else {
                        item = valueRef[newKey]
                    }

                    if (decode.nilCheck(bytes, it)) {
                        it.offset++;

                        if (item && item.onRemove) {
                            try {
                                item.onRemove();
                            } catch (e) {
                                Schema.onError(e);
                            }

                        }

                        if (valueRef.onRemove) {
                            try {
                                valueRef.onRemove(item, newKey);
                            } catch (e) {
                                Schema.onError(e);
                            }
                        }

                        delete value[newKey];
                        continue;

                    } else if (!isSchemaType) {
                        value[newKey] = decodePrimitiveType(type as string, bytes, it);

                    } else {
                        item.decode(bytes, it);
                        value[newKey] = item;
                    }

                    if (isNew) {
                        if (valueRef.onAdd) {
                            try {
                                valueRef.onAdd(item, newKey);
                            } catch (e) {
                                Schema.onError(e);
                            }
                        }

                    } else if (valueRef.onChange) {
                        try {
                            valueRef.onChange(item, newKey);
                        } catch (e) {
                            Schema.onError(e);
                        }
                    }

                }

            } else {
                value = decodePrimitiveType(type as string, bytes, it);
                hasChange = true;
            }

            if (hasChange && this.onChange) {
                changes.push({
                    field,
                    value: change || value,
                    previousValue: this[`_${field}`]
                });
            }

            this[`_${field}`] = value;
        }

        if (this.onChange && changes.length > 0) {
            try {
                this.onChange(changes);
            } catch (e) {
                Schema.onError(e);
            }
        }

        return this;
    }

    encode(root: Schema = this, encodeAll = false, client?: Client) {
        let encodedBytes = [];

        const endStructure = () => {
            if (this !== root) {
                encodedBytes.push(END_OF_STRUCTURE);
            }
        }

        // skip if nothing has changed
        if (!this.$changes.changed && !encodeAll) {
            endStructure();
            return encodedBytes;
        }

        const schema = this._schema;
        const indexes = this._indexes;
        const filters = this._filters;
        const changes = (encodeAll || client)
            ? this.$changes.allChanges
            : this.$changes.changes;

        for (let i = 0, l = changes.length; i < l; i++) {
            const field = changes[i] as string;

            const type = schema[field];
            const filter = (filters && filters[field]);
            // const value = (filter && this.$allChanges[field]) || changes[field];
            const value = this[`_${field}`];
            const fieldIndex = indexes[field];

            // skip unchagned fields
            if (value === undefined) {
                continue;
            }

            let bytes: number[] = [];

            if ((type as any)._schema) {
                if (client && filter) {
                    // skip if not allowed by custom filter
                    if (!filter.call(this, client, value, root)) {
                        continue;
                    }
                }

                encode.number(bytes, fieldIndex);

                // encode child object
                if (value) {
                    assertInstanceType(value, type as typeof Schema, this, field);

                    this.tryEncodeTypeId(bytes, type as typeof Schema, value.constructor as typeof Schema);

                    bytes = bytes.concat((value as Schema).encode(root, encodeAll, client));

                } else {
                    // value has been removed
                    encode.uint8(bytes, NIL);
                }

            } else if (Array.isArray(type)) {
                encode.number(bytes, fieldIndex);

                // total of items in the array
                encode.number(bytes, value.length);

                const arrayChanges = (
                    (encodeAll || client)
                        ? value.$changes.allChanges
                        : value.$changes.changes
                    )
                    .filter(index => this[`_${field}`][index] !== undefined)
                    .sort((a, b) => a - b);

                // ensure number of changes doesn't exceed array length
                const numChanges = arrayChanges.length;

                // number of changed items
                encode.number(bytes, numChanges);

                const isChildSchema = typeof(type[0]) !== "string";

                // assert ArraySchema was provided
                assertInstanceType(this[`_${field}`], ArraySchema, this, field);

                // encode Array of type
                for (let j = 0; j < numChanges; j++) {
                    const index = arrayChanges[j];
                    const item = this[`_${field}`][index];

                    if (client && filter) {
                        // skip if not allowed by custom filter
                        if (!filter.call(this, client, item, root)) {
                            continue;
                        }
                    }

                    if (isChildSchema) { // is array of Schema
                        encode.number(bytes, index);

                        if (!encodeAll)  {
                            const indexChange = value.$changes.getIndexChange(item);
                            if (indexChange !== undefined) {
                                encode.uint8(bytes, INDEX_CHANGE);
                                encode.number(bytes, indexChange);
                            }
                        }

                        assertInstanceType(item, type[0] as typeof Schema, this, field);
                        this.tryEncodeTypeId(bytes, type[0] as typeof Schema, item.constructor as typeof Schema);
                        bytes = bytes.concat(item.encode(root, encodeAll, client));

                    } else {
                        encode.number(bytes, index);

                        if (!encodePrimitiveType(type[0], bytes, item, this, field)) {
                            console.log("cannot encode", schema[field]);
                            continue;
                        }
                    }
                }

                if (!encodeAll) {
                    value.$changes.discard();
                }

            } else if ((type as any).map) {

                // encode Map of type
                encode.number(bytes, fieldIndex);

                // TODO: during `encodeAll`, removed entries are not going to be encoded
                const keys = (encodeAll || client)
                    ? value.$changes.allChanges
                    : value.$changes.changes;

                encode.number(bytes, keys.length)

                const previousKeys = Object.keys(this[`_${field}`]);
                const isChildSchema = typeof((type as any).map) !== "string";

                // assert MapSchema was provided
                assertInstanceType(this[`_${field}`], MapSchema, this, field);

                for (let i = 0; i < keys.length; i++) {
                    const key = (typeof(keys[i]) === "number" && previousKeys[keys[i]]) || keys[i];
                    const item = this[`_${field}`][key];

                    let mapItemIndex: number = undefined;

                    if (client && filter) {
                        // skip if not allowed by custom filter
                        if (!filter.call(this, client, item, root)) {
                            continue;
                        }
                    }

                    if (encodeAll) {
                        if (item === undefined) {
                            // previously deleted items are skipped during `encodeAll`
                            continue;
                        }

                    } else {
                        // encode index change
                        const indexChange = value.$changes.getIndexChange(item);
                        if (item && indexChange !== undefined) {
                            encode.uint8(bytes, INDEX_CHANGE);
                            encode.number(bytes, this[`_${field}`]._indexes.get(indexChange));
                        }

                        mapItemIndex = this[`_${field}`]._indexes.get(key);
                    }

                    if (mapItemIndex !== undefined) {
                        encode.number(bytes, mapItemIndex);

                    } else {
                        // TODO: remove item
                        encode.string(bytes, key);
                    }

                    if (item && isChildSchema) {
                        assertInstanceType(item, (type as any).map, this, field);
                        this.tryEncodeTypeId(bytes, (type as any).map, item.constructor as typeof Schema);
                        bytes = bytes.concat(item.encode(root, encodeAll, client));

                    } else if (item !== undefined) {
                        encodePrimitiveType((type as any).map, bytes, item, this, field);

                    } else {
                        encode.uint8(bytes, NIL);
                    }

                }

                if (!encodeAll) {
                    value.$changes.discard();

                    // TODO: track array/map indexes per client?
                    if (!client) {
                        this[`_${field}`]._updateIndexes();
                    }
                }

            } else {
                if (client && filter) {
                    // skip if not allowed by custom filter
                    if (!filter.call(this, client, value, root)) {
                        continue;
                    }
                }

                encode.number(bytes, fieldIndex);

                if (!encodePrimitiveType(type as PrimitiveType, bytes, value, this, field)) {
                    console.log("cannot encode", schema[field]);
                    continue;
                }
            }

            encodedBytes = [...encodedBytes, ...bytes];
        }

        // flag end of Schema object structure
        endStructure();

        if (!encodeAll && !client) {
            this.$changes.discard();
        }

        return encodedBytes;
    }

    encodeFiltered(client: Client) {
        return this.encode(this, false, client);
    }

    encodeAll () {
        return this.encode(this, true);
    }

    encodeAllFiltered (client: Client) {
        return this.encode(this, true, client);
    }

    clone () {
        const cloned = new ((this as any).constructor);
        const schema = this._schema;
        for (let field in schema) {
            cloned[field] = this[field];
        }
        return cloned;
    }

    triggerAll() {
        if (!this.onChange) {
            return;
        }

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
            this.onChange(changes);
        } catch (e) {
            Schema.onError(e);
        }
    }

    toJSON () {
        const schema = this._schema;
        const obj = {}
        for (let field in schema) {
            obj[field] = this[`_${field}`];
        }
        return obj;
    }

    private tryEncodeTypeId (bytes: number[], type: typeof Schema, targetType: typeof Schema) {
        if (type._typeid !== targetType._typeid) {
            encode.uint8(bytes, TYPE_ID);
            encode.uint8(bytes, targetType._typeid);
        }
    }

    private createTypeInstance (bytes: number[], it: decode.Iterator, type: typeof Schema): Schema {
        if (bytes[it.offset] === TYPE_ID) {
            it.offset++;
            const anotherType = (this.constructor as typeof Schema)._context.get(decode.uint8(bytes, it));
            return new (anotherType as any)();

        } else {
            return new (type as any)();
        }
    }
}
