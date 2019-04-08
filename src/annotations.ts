import { END_OF_STRUCTURE, NIL, INDEX_CHANGE } from './spec';

import * as encode from "./encoding/encode";
import * as decode from "./encoding/decode";

import { ChangeTree } from './ChangeTree';

import { ArraySchema } from './types/ArraySchema';
import { MapSchema } from './types/MapSchema';

/**
 * Data types
 */
export type PrimitiveType =
    "string" |
    "number" |
    "boolean" |
    "int8" |
    "uint8" |
    "int16" |
    "uint16" |
    "int32" |
    "uint32" |
    "int64" |
    "uint64" |
    "float32" |
    "float64" |
    typeof Schema;

export type DefinitionType = ( PrimitiveType | PrimitiveType[] | { map: PrimitiveType });
export type Definition = { [field: string]: DefinitionType };
export type FilterCallback = (this: Schema, client: Client, instance: Schema, root?: Schema) => boolean;

const definedSchemas = new Map<typeof Schema, boolean>();

// Colyseus integration
export type Client = { sessionId: string } & any;

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
    if (value.constructor !== type) {
        throw new EncodeSchemaError(`a '${type.name}' was expected, but '${(value as any).constructor.name}' was provided in ${klass.constructor.name}#${field}`);
    }
}

function encodePrimitiveType (type: PrimitiveType, bytes: number[], value: any) {
    const encodeFunc = encode[type as string];
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

export interface DataChange<T=any> {
    field: string;
    value: T;
    previousValue: T;
}

/**
 * Schema encoder / decoder
 */
export abstract class Schema {
    static _schema: Definition;
    static _indexes: {[field: string]: number};
    static _filters: {[field: string]: FilterCallback};
    static _descriptors: PropertyDescriptorMap & ThisType<any>;

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
                    value = this[`_${field}`] || new (type as any)();
                    value.decode(bytes, it);
                }

                hasChange = true;

            } else if (Array.isArray(type)) {
                type = type[0];
                change = [];

                const valueRef: ArraySchema = this[`_${field}`] || new ArraySchema();
                value = valueRef.clone();

                const newLength = decode.number(bytes, it);
                const numChanges = decode.number(bytes, it);

                hasChange = (numChanges > 0);

                // FIXME: this may not be reliable. possibly need to encode this variable during
                // serializagion
                let hasIndexChange = false;

                // ensure current array has the same length as encoded one
                if (value.length > newLength) {
                    value.splice(newLength).forEach((itemRemoved, i) => {
                        if (itemRemoved.onRemove) {
                            itemRemoved.onRemove();
                        }

                        if (valueRef.onRemove) {
                            valueRef.onRemove(itemRemoved, newLength + i);
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

                    let isNew = (!hasIndexChange && !value[newIndex]) || (hasIndexChange && indexChangedFrom === undefined);

                    if ((type as any).prototype instanceof Schema) {
                        let item: Schema;

                        if (isNew) {
                            item = new (type as any)();

                        } else if (indexChangedFrom !== undefined) {
                            item = valueRef[indexChangedFrom];

                        } else {
                            item = valueRef[newIndex]
                        }

                        if (!item) {
                            item = new (type as any)();
                            isNew = true;
                        }

                        if (decode.nilCheck(bytes, it)) {
                            it.offset++;

                            if (valueRef.onRemove) {
                                valueRef.onRemove(item, newIndex);
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
                            valueRef.onAdd(value[newIndex], newIndex);
                        }

                    } else if (valueRef.onChange) {
                        valueRef.onChange(value[newIndex], newIndex);
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
                        item = new (type as any)();

                    } else if (previousKey !== undefined) {
                        item = valueRef[previousKey];

                    } else {
                        item = valueRef[newKey]
                    }

                    if (decode.nilCheck(bytes, it)) {
                        it.offset++;

                        if (item && item.onRemove) {
                            item.onRemove();
                        }

                        if (valueRef.onRemove) {
                            valueRef.onRemove(item, newKey);
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
                            valueRef.onAdd(item, newKey);
                        }

                    } else if (valueRef.onChange) {
                        valueRef.onChange(item, newKey);
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
            this.onChange(changes);
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
                    bytes = bytes.concat((value as Schema).encode(root, encodeAll, client));

                } else {
                    // value has been removed
                    encode.uint8(bytes, NIL);
                }

            } else if (Array.isArray(type)) {
                encode.number(bytes, fieldIndex);

                // total of items in the array
                encode.number(bytes, value.length);

                const arrayChanges = (encodeAll || client)
                    ? value.$changes.allChanges
                    : value.$changes.changes;

                // number of changed items
                encode.number(bytes, arrayChanges.length);

                const isChildSchema = typeof(type[0]) !== "string";

                // assert ArraySchema was provided
                assertInstanceType(this[`_${field}`], ArraySchema, this, field);

                // encode Array of type
                for (let j = 0; j < arrayChanges.length; j++) {
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

                        if (item === undefined) {
                            encode.uint8(bytes, NIL);
                            continue;
                        }

                        const indexChange = value.$changes.getIndexChange(item);
                        if (indexChange !== undefined) {
                            encode.uint8(bytes, INDEX_CHANGE);
                            encode.number(bytes, indexChange);
                        }

                        assertInstanceType(item, type[0] as typeof Schema, this, field);
                        bytes = bytes.concat(item.encode(root, encodeAll, client));

                    } else {
                        encode.number(bytes, index);

                        assertType(item, type[0] as string, this, field);
                        if (!encodePrimitiveType(type[0], bytes, item)) {
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

                    let mapItemIndex = this[`_${field}`]._indexes.get(key);

                    if (client && filter) {
                        // skip if not allowed by custom filter
                        if (!filter.call(this, client, item, root)) {
                            continue;
                        }
                    }

                    if (encodeAll) {
                        if (item !== undefined) {
                            mapItemIndex = undefined;

                        } else {
                            // previously deleted items are skipped during `encodeAll`
                            continue;
                        }
                    }

                    // encode index change
                    const indexChange = value.$changes.getIndexChange(item);
                    if (item && indexChange !== undefined) {
                        encode.uint8(bytes, INDEX_CHANGE);
                        encode.number(bytes, this[`_${field}`]._indexes.get(indexChange));
                    }

                    if (mapItemIndex !== undefined) {
                        encode.number(bytes, mapItemIndex);

                    } else {
                        // TODO: remove item
                        encode.string(bytes, key);
                    }

                    if (item && isChildSchema) {
                        assertInstanceType(item, (type as any).map, this, field);
                        bytes = bytes.concat(item.encode(root, encodeAll, client));

                    } else if (item !== undefined) {
                        assertType(item, (type as any).map, this, field);
                        encodePrimitiveType((type as any).map, bytes, item);

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

                assertType(value, type as string, this, field);
                if (!encodePrimitiveType(type as PrimitiveType, bytes, value)) {
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

        this.onChange(changes);
    }

    toJSON () {
        const schema = this._schema;
        const obj = {}
        for (let field in schema) {
            obj[field] = this[`_${field}`];
        }
        return obj;
    }
}

/**
 * Reflection
 */
export class ReflectionField extends Schema {
    @type("string")
    name: string;

    @type("string")
    type: string;

    @type("uint8")
    referencedType: number;
}

export class ReflectionType extends Schema {
    @type("uint8")
    id: number;

    @type([ ReflectionField ])
    fields: ArraySchema<ReflectionField> = new ArraySchema<ReflectionField>();
}

export class Reflection extends Schema {
    @type([ ReflectionType ])
    types: ArraySchema<ReflectionType> = new ArraySchema<ReflectionType>();

    static encode (instance: Schema) {
        const reflection = new Reflection();
        const schema = instance._schema

        let lastTypeId: number = 0;

        const rootType = new ReflectionType();
        rootType.id = lastTypeId++;

        const typeIds: {[id: string]: number} = {};

        const buildType = (currentType: ReflectionType, schema: any) => {
            for (let fieldName in schema) {
                const field = new ReflectionField();
                field.name = fieldName;

                let fieldType: string;

                if (typeof (schema[fieldName]) === "string") {
                    fieldType = schema[fieldName];

                } else {
                    const isSchema = typeof (schema[fieldName]) === "function";
                    const isArray = Array.isArray(schema[fieldName]);
                    const isMap = !isArray && (schema[fieldName] as any).map;

                    let childTypeSchema: any;
                    if (isSchema) {
                        fieldType = "ref";
                        childTypeSchema = schema[fieldName];

                    } else if (isArray) {
                        fieldType = "array";

                        if (typeof(schema[fieldName][0]) === "string") {
                            fieldType += ":" + schema[fieldName][0]; // array:string

                        } else {
                            childTypeSchema = schema[fieldName][0];
                        }

                    } else if (isMap) {
                        fieldType = "map";

                        if (typeof(schema[fieldName].map) === "string") {
                            fieldType += ":" + schema[fieldName].map; // array:string

                        } else {
                            childTypeSchema = schema[fieldName].map;
                        }
                    }

                    if (childTypeSchema) {
                        const childSchemaName = childTypeSchema.name;

                        if (typeIds[childSchemaName] === undefined) {
                            const childType = new ReflectionType();
                            childType.id = lastTypeId++;
                            typeIds[childSchemaName] = childType.id;
                            buildType(childType, childTypeSchema._schema);
                        }

                        field.referencedType = typeIds[childSchemaName];

                    } else {
                        field.referencedType = 255;
                    }
                }

                field.type = fieldType;
                currentType.fields.push(field);
            }

            reflection.types.push(currentType);
        }

        buildType(rootType, schema);

        return reflection.encodeAll();
    }

    static decode (bytes: number[]): Schema {
        const reflection = new Reflection();
        reflection.decode(bytes);

        let schemaTypes = reflection.types.reduce((types, reflectionType) => {
            types[reflectionType.id] = class _ extends Schema {};
            return types;
        }, {});

        reflection.types.forEach((reflectionType, i) => {
            reflectionType.fields.forEach(field => {
                const schemaType = schemaTypes[reflectionType.id];

                if (field.referencedType !== undefined) {
                    let refType = schemaTypes[field.referencedType];

                    // map or array of primitive type (255)
                    if (!refType) {
                        refType = field.type.split(":")[1];
                    }

                    if (field.type.indexOf("array") === 0) {
                        type([ refType ])(schemaType.prototype, field.name);

                    } else if (field.type.indexOf("map") === 0) {
                        type({ map: refType })(schemaType.prototype, field.name);

                    } else if (field.type === "ref") {
                        type(refType)(schemaType.prototype, field.name);

                    }

                } else {
                    type(field.type as PrimitiveType)(schemaType.prototype, field.name);
                }
            });
        })

        const rootType: any = schemaTypes[0];
        const rootInstance = new rootType();

        /**
         * auto-initialize referenced types on root type
         * to allow registering listeners immediatelly on client-side
         */
        for (let fieldName in rootType._schema) {
            const fieldType = rootType._schema[fieldName];

            if (typeof(fieldType) !== "string") {
                const isSchema = typeof (fieldType) === "function";
                const isArray = Array.isArray(fieldType);
                const isMap = !isArray && (fieldType as any).map;

                rootInstance[fieldName] = (isArray)
                    ? new ArraySchema()
                    : (isMap)
                        ? new MapSchema()
                        : (isSchema)
                            ? new (fieldType as any)()
                            : undefined;
            }
        }

        return rootInstance;
    }
}

/**
 * `@type()` decorator for proxies
 */

export function type (type: DefinitionType): PropertyDecorator {
    return function (target: any, field: string) {
        const constructor = target.constructor as typeof Schema;

        /*
         * static schema
         */
        if (!definedSchemas.get(constructor)) {
            definedSchemas.set(constructor, true);

            // support inheritance
            constructor._schema = Object.assign({}, constructor._schema || {});
            constructor._indexes = Object.assign({}, constructor._indexes || {});
            constructor._descriptors = Object.assign({}, constructor._descriptors || {});
        }
        constructor._indexes[field] = Object.keys(constructor._schema).length;
        constructor._schema[field] = type;

        /** 
         * TODO: `isSchema` / `isArray` / `isMap` is repeated on many places! 
         * need to refactor all of them. 
         */
        const isArray = Array.isArray(type);
        const isMap = !isArray && (type as any).map;

        const fieldCached = `_${field}`;

        constructor._descriptors[fieldCached] = {
            enumerable: false,
            configurable: false,
            writable: true,
        };

        constructor._descriptors[field] = {
            get: function () {
                return this[fieldCached];
            },

            set: function (this: Schema, value: any) {
                /**
                 * Create Proxy for array or map items
                 */
                if (isArray || isMap) {
                    value = new Proxy(value, {
                        get: (obj, prop) => obj[prop],
                        set: (obj, prop, setValue) => {
                            if (prop !== "length" && prop !== "$changes") {
                                // ensure new value has a parent
                                const key = (isArray) ? Number(prop) : String(prop);

                                const previousIndex = obj.$changes.getIndex(setValue);
                                if (previousIndex !== undefined) {
                                    obj.$changes.mapIndexChange(setValue, previousIndex);
                                }

                                obj.$changes.mapIndex(setValue, key);

                                if (setValue instanceof Schema) {
                                    // new items are flagged with all changes
                                    if (!setValue.$changes.parent) {
                                        setValue.$changes = new ChangeTree(key, obj.$changes);
                                        setValue.$changes.changeAll(setValue);
                                    }

                                } else {
                                    obj[prop] = setValue;
                                }

                                // apply change on ArraySchema / MapSchema
                                obj.$changes.change(key);

                            } else if (setValue !== obj[prop]) {
                                // console.log("SET NEW LENGTH:", setValue);
                                // console.log("PREVIOUS LENGTH: ", obj[prop]);
                            }

                            obj[prop] = setValue;

                            return true;
                        },

                        deleteProperty: (obj, prop) => {
                            const deletedValue = obj[prop];

                            // TODO: 
                            // remove deleteIndex of property being deleted as well.

                            // obj.$changes.deleteIndex(deletedValue);
                            // obj.$changes.deleteIndexChange(deletedValue);

                            delete obj[prop];

                            const key = (isArray) ? Number(prop) : String(prop);
                            obj.$changes.change(key, true);

                            return true;
                        },
                    });
                }

                // skip if value is the same as cached.
                if (value === this[fieldCached]) {
                    return;
                }

                this[fieldCached] = value;

                if (Array.isArray(constructor._schema[field])) {
                    // directly assigning an array of items as value.
                    this.$changes.change(field);
                    value.$changes = new ChangeTree(field, this.$changes);

                    for (let i = 0; i < value.length; i++) {
                        if (value[i] instanceof Schema) {
                            value[i].$changes = new ChangeTree(i, value.$changes);
                            value[i].$changes.changeAll(value[i]);
                        }
                        value.$changes.mapIndex(value[i], i);
                        value.$changes.change(i);
                    }

                } else if ((constructor._schema[field] as any).map) {
                    // directly assigning a map
                    value.$changes = new ChangeTree(field, this.$changes);
                    this.$changes.change(field);

                    for (let key in value) {
                        if (value[key] instanceof Schema) {
                            value[key].$changes = new ChangeTree(key, value.$changes);
                            value[key].$changes.changeAll(value[key]);
                        }
                        value.$changes.mapIndex(value[key], key);
                        value.$changes.change(key);
                    }

                } else if (typeof(constructor._schema[field]) === "function") {
                    // directly assigning a `Schema` object
                    // value may be set to null
                    this.$changes.change(field);

                    if (value) {
                        value.$changes = new ChangeTree(field, this.$changes);
                        value.$changes.changeAll(value);
                    }

                } else {
                    // directly assigning a primitive type
                    this.$changes.change(field);
                }
            },

            enumerable: true,
            configurable: true
        };
    }
}

/**
 * `@filter()` decorator for defining data filters per client
 */
export function filter(cb: FilterCallback): PropertyDecorator  {
    return function (target: any, field: string) {
        const constructor = target.constructor as typeof Schema;

        /*
        * static filters
        */
        if (!constructor._filters) {
            constructor._filters = {};
        }

        constructor._filters[field] = cb;
    }
}