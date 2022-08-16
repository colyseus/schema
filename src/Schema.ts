import { SWITCH_TO_STRUCTURE, TYPE_ID, OPERATION } from './spec';
import { ClientWithSessionId, PrimitiveType, Context, SchemaDefinition, DefinitionType } from "./annotations";

import * as encode from "./encoding/encode";
import * as decode from "./encoding/decode";
import type { Iterator } from "./encoding/decode"; // dts-bundle-generator

import { ArraySchema } from "./types/ArraySchema";
import { MapSchema } from "./types/MapSchema";
import { CollectionSchema } from './types/CollectionSchema';
import { SetSchema } from './types/SetSchema';

import { ChangeTree, Root, Ref, ChangeOperation } from "./changes/ChangeTree";
import { NonFunctionPropNames } from './types/HelperTypes';
import { EventEmitter_ } from './events/EventEmitter';
import { ClientState } from './filters';
import { getType } from './types';

export interface DataChange<T=any> {
    op: OPERATION,
    field: string;
    dynamicIndex?: number | string;
    value: T;
    previousValue: T;
}

export interface SchemaDecoderCallbacks {
    onAdd?: (item: any, key: any) => void;
    onRemove?: (item: any, key: any) => void;
    onChange?: (item: any, key: any) => void;
    clone(decoding?: boolean): SchemaDecoderCallbacks;
    clear(decoding?: boolean);
    decode?(byte, it: Iterator);
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

function decodePrimitiveType (type: string, bytes: number[], it: Iterator) {
    return decode[type as string](bytes, it);
}

/**
 * Schema encoder / decoder
 */
export abstract class Schema {
    static _typeid: number;
    static _context: Context;

    static _definition: SchemaDefinition = SchemaDefinition.create();

    static onError(e) {
        console.error(e);
    }

    static is(type: DefinitionType) {
        return (
            type['_definition'] &&
            type['_definition'].schema !== undefined
        );
    }

    protected $changes: ChangeTree;
    // protected $root: ChangeSet;

    // TODO: refactor. this feature needs to be ported to other languages with potentially different API
    protected $listeners: { [field: string]: EventEmitter_<(a: any, b: any) => void> };

    public onChange?(changes: DataChange[]);
    public onRemove?();

    // allow inherited classes to have a constructor
    constructor(...args: any[]) {
        // fix enumerability of fields for end-user
        Object.defineProperties(this, {
            $changes: {
                value: new ChangeTree(this, undefined, new Root()),
                enumerable: false,
                writable: true
            },

            $listeners: {
                value: {},
                enumerable: false,
                writable: true
            },
        });

        const descriptors = this._definition.descriptors;
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
        props: { [prop in NonFunctionPropNames<this>]?: this[prop] }
    ) {
        Object.assign(this, props);
        return this;
    }

    protected get _definition () { return (this.constructor as typeof Schema)._definition; }

    public listen <K extends NonFunctionPropNames<this>>(attr: K, callback: (value: this[K], previousValue: this[K]) => void) {
        if (!this.$listeners[attr as string]) {
            this.$listeners[attr as string] = new EventEmitter_();
        }
        this.$listeners[attr as string].register(callback);

        // return un-register callback.
        return () =>
            this.$listeners[attr as string].remove(callback);
    }

    decode(
        bytes: number[],
        it: Iterator = { offset: 0 },
        ref: Ref = this,
        allChanges: Map<number, DataChange[]> = new Map<number, DataChange[]>(),
    ) {
        const $root = this.$changes.root;
        const totalBytes = bytes.length;

        let refId: number = 0;
        let changes: DataChange[] = [];

        $root.refs.set(refId, this);
        allChanges.set(refId, changes);

        while (it.offset < totalBytes) {
            let byte = bytes[it.offset++];

            if (byte == SWITCH_TO_STRUCTURE) {
                refId = decode.number(bytes, it);

                const nextRef = $root.refs.get(refId) as Schema;

                //
                // Trying to access a reference that haven't been decoded yet.
                //
                if (!nextRef) { throw new Error(`"refId" not found: ${refId}`); }

                ref = nextRef;

                // create empty list of changes for this refId.
                changes = [];
                allChanges.set(refId, changes);

                continue;
            }

            const changeTree: ChangeTree = ref['$changes'];
            const isSchema = (ref['_definition'] !== undefined);

            const operation = (isSchema)
                ? (byte >> 6) << 6 // "compressed" index + operation
                : byte; // "uncompressed" index + operation (array/map items)

            if (operation === OPERATION.CLEAR) {
                //
                // TODO: refactor me!
                // The `.clear()` method is calling `$root.removeRef(refId)` for
                // each item inside this collection
                //
                (ref as SchemaDecoderCallbacks).clear(true);
                continue;
            }

            const fieldIndex = (isSchema)
                ? byte % (operation || 255) // if "REPLACE" operation (0), use 255
                : decode.number(bytes, it);

            const fieldName = (isSchema)
                ? (ref['_definition'].fieldsByIndex[fieldIndex])
                : "";

            let type = changeTree.getType(fieldIndex);
            let value: any;
            let previousValue: any;

            let dynamicIndex: number | string;

            if (!isSchema) {
                previousValue = ref['getByIndex'](fieldIndex);

                if ((operation & OPERATION.ADD) === OPERATION.ADD) { // ADD or DELETE_AND_ADD
                    dynamicIndex = (ref instanceof MapSchema)
                        ? decode.string(bytes, it)
                        : fieldIndex;
                    ref['setIndex'](fieldIndex, dynamicIndex);

                } else {
                    // here
                    dynamicIndex = ref['getIndex'](fieldIndex);
                }

            } else {
                previousValue = ref[`_${fieldName}`];
            }

            //
            // Delete operations
            //
            if ((operation & OPERATION.DELETE) === OPERATION.DELETE)
            {
                if (operation !== OPERATION.DELETE_AND_ADD) {
                    ref['deleteByIndex'](fieldIndex);
                }

                // Flag `refId` for garbage collection.
                if (previousValue && previousValue['$changes']) {
                    $root.removeRef(previousValue['$changes'].refId);
                }

                value = null;
            }

            if (fieldName === undefined) {
                console.warn("@colyseus/schema: definition mismatch");

                //
                // keep skipping next bytes until reaches a known structure
                // by local decoder.
                //
                const nextIterator: Iterator = { offset: it.offset };
                while (it.offset < totalBytes) {
                    if (decode.switchStructureCheck(bytes, it)) {
                        nextIterator.offset = it.offset + 1;
                        if ($root.refs.has(decode.number(bytes, nextIterator))) {
                            break;
                        }
                    }

                    it.offset++;
                }

                continue;

            } else if (operation === OPERATION.DELETE) {
                //
                // FIXME: refactor me.
                // Don't do anything.
                //

            } else if (Schema.is(type)) {
                const refId = decode.number(bytes, it);
                value = $root.refs.get(refId);

                if (operation !== OPERATION.REPLACE) {
                    const childType = this.getSchemaType(bytes, it, type);

                    if (!value) {
                        value = this.createTypeInstance(childType);
                        value.$changes.refId = refId;

                        if (previousValue) {
                            value.onChange = previousValue.onChange;
                            value.onRemove = previousValue.onRemove;
                            value.$listeners = previousValue.$listeners;

                            if (
                                previousValue['$changes'].refId &&
                                refId !== previousValue['$changes'].refId
                            ) {
                                $root.removeRef(previousValue['$changes'].refId);
                            }
                        }
                    }

                    $root.addRef(refId, value, (value !== previousValue));
                }
            } else if (typeof(type) === "string") {
                //
                // primitive value (number, string, boolean, etc)
                //
                value = decodePrimitiveType(type as string, bytes, it);

            } else {
                const typeDef = getType(Object.keys(type)[0]);
                const refId = decode.number(bytes, it);

                const valueRef: SchemaDecoderCallbacks = ($root.refs.has(refId))
                    ? previousValue || $root.refs.get(refId)
                    : new typeDef.constructor();

                value = valueRef.clone(true);
                value.$changes.refId = refId;

                // preserve schema callbacks
                if (previousValue) {
                    value.onAdd = previousValue.onAdd;
                    value.onRemove = previousValue.onRemove;
                    value.onChange = previousValue.onChange;

                    if (
                        previousValue['$changes'].refId &&
                        refId !== previousValue['$changes'].refId
                    ) {
                        $root.removeRef(previousValue['$changes'].refId);

                        //
                        // Trigger onRemove if structure has been replaced.
                        //
                        const deletes: DataChange[] = [];
                        const entries: IterableIterator<[any, any]> = previousValue.entries();
                        let iter: IteratorResult<[any, any]>;
                        while ((iter = entries.next()) && !iter.done) {
                            const [key, value] = iter.value;
                            deletes.push({
                                op: OPERATION.DELETE,
                                field: key,
                                value: undefined,
                                previousValue: value,
                            });
                        }

                        allChanges.set(previousValue['$changes'].refId, deletes);
                    }
                }

                $root.addRef(refId, value, (valueRef !== previousValue));

                //
                // TODO: deprecate proxies on next version.
                // get proxy to target value.
                //
                if (typeDef.getProxy) {
                    value = typeDef.getProxy(value);
                }
            }

            let hasChange = (previousValue !== value);

            if (
                value !== null &&
                value !== undefined
            ) {
                if (value['$changes']) {
                    value['$changes'].setParent(
                        changeTree.ref,
                        changeTree.root,
                        fieldIndex,
                    );
                }

                if (ref instanceof Schema) {
                    ref[fieldName] = value;

                    //
                    // FIXME: use `_field` instead of `field`.
                    //
                    // `field` is going to use the setter of the PropertyDescriptor
                    // and create a proxy for array/map. This is only useful for
                    // backwards-compatibility with @colyseus/schema@0.5.x
                    //
                    // // ref[_field] = value;

                } else if (ref instanceof MapSchema) {
                    // const key = ref['$indexes'].get(field);
                    const key = dynamicIndex as string;

                    // ref.set(key, value);
                    ref['$items'].set(key, value);
                    ref['$changes'].allChanges.add(fieldIndex);

                } else if (ref instanceof ArraySchema) {
                    // const key = ref['$indexes'][field];
                    // console.log("SETTING FOR ArraySchema =>", { field, key, value });
                    // ref[key] = value;
                    ref.setAt(fieldIndex, value);

                } else if (ref instanceof CollectionSchema) {
                    const index = ref.add(value);
                    ref['setIndex'](fieldIndex, index);

                } else if (ref instanceof SetSchema) {
                    const index = ref.add(value);
                    if (index !== false) {
                        ref['setIndex'](fieldIndex, index);
                    }
                }
            }

            if (
                hasChange
                // &&
                // (
                //     this.onChange || ref.$listeners[field]
                // )
            ) {
                changes.push({
                    op: operation,
                    field: fieldName,
                    dynamicIndex,
                    value,
                    previousValue,
                });
            }
        }

        this._triggerChanges(allChanges);

        // drop references of unused schemas
        $root.garbageCollectDeletedRefs();

        return allChanges;
    }

    encode(
        encodeAll = false,
        bytes: number[] = [],
        useFilters: boolean = false,
    ) {
        const rootChangeTree = this.$changes;
        const refIdsVisited = new WeakSet<ChangeTree>();

        const changeTrees: ChangeTree[] = [rootChangeTree];
        let numChangeTrees = 1;

        for (let i = 0; i < numChangeTrees; i++) {
            const changeTree = changeTrees[i];
            const ref = changeTree.ref;
            const isSchema = (ref instanceof Schema);

            // Generate unique refId for the ChangeTree.
            changeTree.ensureRefId();

            // mark this ChangeTree as visited.
            refIdsVisited.add(changeTree);

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

                const fieldIndex = operation.index;

                const field = (isSchema)
                    ? ref['_definition'].fieldsByIndex && ref['_definition'].fieldsByIndex[fieldIndex]
                    : fieldIndex;

                // cache begin index if `useFilters`
                const beginIndex = bytes.length;

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

                // Enqueue ChangeTree to be visited
                if (
                    value &&
                    value['$changes'] &&
                    !refIdsVisited.has(value['$changes'])
                ) {
                    changeTrees.push(value['$changes']);
                    value['$changes'].ensureRefId();
                    numChangeTrees++;
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
                    assertInstanceType(ref[`_${field}`], definition.constructor, ref as Schema, field);

                    //
                    // Encode refId for this instance.
                    // The actual instance is going to be encoded on next `changeTree` iteration.
                    //
                    encode.number(bytes, value.$changes.refId);
                }

                if (useFilters) {
                    // cache begin / end index
                    changeTree.cache(fieldIndex as number, bytes.slice(beginIndex));
                }
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

    applyFilters(client: ClientWithSessionId, encodeAll: boolean = false) {
        const root = this;
        const refIdsDissallowed = new Set<number>();

        const $filterState = ClientState.get(client);

        const changeTrees = [this.$changes];
        let numChangeTrees = 1;

        let filteredBytes: number[] = [];

        for (let i = 0; i < numChangeTrees; i++) {
            const changeTree = changeTrees[i];

            if (refIdsDissallowed.has(changeTree.refId))  {
                // console.log("REFID IS NOT ALLOWED. SKIP.", { refId: changeTree.refId })
                continue;
            }

            const ref = changeTree.ref as Ref;
            const isSchema: boolean = ref instanceof Schema;

            encode.uint8(filteredBytes, SWITCH_TO_STRUCTURE);
            encode.number(filteredBytes, changeTree.refId);

            const clientHasRefId = $filterState.refIds.has(changeTree);
            const isEncodeAll = (encodeAll || !clientHasRefId);

            // console.log("REF:", ref.constructor.name);
            // console.log("Encode all?", isEncodeAll);

            //
            // include `changeTree` on list of known refIds by this client.
            //
            $filterState.addRefId(changeTree);

            const containerIndexes = $filterState.containerIndexes.get(changeTree)
            const changes = (isEncodeAll)
                ? Array.from(changeTree.allChanges)
                : Array.from(changeTree.changes.values());

            //
            // WORKAROUND: tries to re-evaluate previously not included @filter() attributes
            // - see "DELETE a field of Schema" test case.
            //
            if (
                !encodeAll &&
                isSchema &&
                (ref as Schema)._definition.indexesWithFilters
            ) {
                const indexesWithFilters = (ref as Schema)._definition.indexesWithFilters;
                indexesWithFilters.forEach(indexWithFilter => {
                    if (
                        !containerIndexes.has(indexWithFilter) &&
                        changeTree.allChanges.has(indexWithFilter)
                    ) {
                        if (isEncodeAll) {
                            changes.push(indexWithFilter as any);

                        } else {
                            changes.push({ op: OPERATION.ADD, index: indexWithFilter, } as any);
                        }
                    }
                });
            }

            for (let j = 0, cl = changes.length; j < cl; j++) {
                const change: ChangeOperation = (isEncodeAll)
                    ? { op: OPERATION.ADD, index: changes[j] as number }
                    : changes[j] as ChangeOperation;

                // custom operations
                if (change.op === OPERATION.CLEAR) {
                    encode.uint8(filteredBytes, change.op);
                    continue;
                }

                const fieldIndex = change.index;

                //
                // Deleting fields: encode the operation + field index
                //
                if (change.op === OPERATION.DELETE) {
                    //
                    // DELETE operations also need to go through filtering.
                    //
                    // TODO: cache the previous value so we can access the value (primitive or `refId`)
                    // (check against `$filterState.refIds`)
                    //

                    if (isSchema) {
                        encode.uint8(filteredBytes, change.op | fieldIndex);

                    } else {
                        encode.uint8(filteredBytes, change.op);
                        encode.number(filteredBytes, fieldIndex);

                    }
                    continue;
                }

                // indexed operation
                const value = changeTree.getValue(fieldIndex);
                const type = changeTree.getType(fieldIndex);

                if (isSchema) {
                    // Is a Schema!
                    const filter = (
                        (ref as Schema)._definition.filters &&
                        (ref as Schema)._definition.filters[fieldIndex]
                    );

                    if (filter && !filter.call(ref, client, value, root)) {
                        if (value && value['$changes']) {
                            refIdsDissallowed.add(value['$changes'].refId);;
                        }
                        continue;
                    }

                } else {
                    // Is a collection! (map, array, etc.)
                    const parent = changeTree.parent as Ref;
                    const filter = changeTree.getChildrenFilter();

                    if (filter && !filter.call(parent, client, ref['$indexes'].get(fieldIndex), value, root)) {
                        if (value && value['$changes']) {
                            refIdsDissallowed.add(value['$changes'].refId);
                        }
                        continue;
                    }
                }

                // visit child ChangeTree on further iteration.
                if (value['$changes']) {
                    changeTrees.push(value['$changes']);
                    numChangeTrees++;
                }

                //
                // Copy cached bytes
                //
                if (change.op !== OPERATION.TOUCH) {

                    //
                    // TODO: refactor me!
                    //

                    if (change.op === OPERATION.ADD || isSchema) {
                        //
                        // use cached bytes directly if is from Schema type.
                        //
                        filteredBytes.push.apply(filteredBytes, changeTree.caches[fieldIndex] ?? []);
                        containerIndexes.add(fieldIndex);

                    } else {
                        if (containerIndexes.has(fieldIndex)) {
                            //
                            // use cached bytes if already has the field
                            //
                            filteredBytes.push.apply(filteredBytes, changeTree.caches[fieldIndex] ?? []);

                        } else {
                            //
                            // force ADD operation if field is not known by this client.
                            //
                            containerIndexes.add(fieldIndex);

                            encode.uint8(filteredBytes, OPERATION.ADD);
                            encode.number(filteredBytes, fieldIndex);

                            if (ref instanceof MapSchema) {
                                //
                                // MapSchema dynamic key
                                //
                                const dynamicIndex = changeTree.ref['$indexes'].get(fieldIndex);
                                encode.string(filteredBytes, dynamicIndex);
                            }

                            if (value['$changes']) {
                                encode.number(filteredBytes, value['$changes'].refId);

                            } else {
                                // "encodePrimitiveType" without type checking.
                                // the type checking has been done on the first .encode() call.
                                encode[type as string](filteredBytes, value);
                            }
                        }
                    }

                } else if (value['$changes'] && !isSchema) {
                    //
                    // TODO:
                    // - track ADD/REPLACE/DELETE instances on `$filterState`
                    // - do NOT always encode dynamicIndex for MapSchema.
                    //   (If client already has that key, only the first index is necessary.)
                    //

                    encode.uint8(filteredBytes, OPERATION.ADD);
                    encode.number(filteredBytes, fieldIndex);

                    if (ref instanceof MapSchema) {
                        //
                        // MapSchema dynamic key
                        //
                        const dynamicIndex = changeTree.ref['$indexes'].get(fieldIndex);
                        encode.string(filteredBytes, dynamicIndex);
                    }

                    encode.number(filteredBytes, value['$changes'].refId);
                }

            };
        }

        return filteredBytes;
    }

    clone (): this {
        const cloned = new ((this as any).constructor);
        const schema = this._definition.schema;
        for (let field in schema) {
            if (
                typeof (this[field]) === "object" &&
                typeof (this[field]?.clone) === "function"
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
        // skip if haven't received any remote refs yet.
        if (this.$changes.root.refs.size === 0) { return; }

        const allChanges = new Map<number, DataChange[]>();
        Schema.prototype._triggerAllFillChanges.call(this, this, allChanges);

        try {
            Schema.prototype._triggerChanges.call(this, allChanges);

        } catch (e) {
            Schema.onError(e);
        }
    }

    toJSON () {
        const schema = this._definition.schema;
        const deprecated = this._definition.deprecated;

        const obj = {}
        for (let field in schema) {
            if (!deprecated[field] && this[field] !== null && typeof (this[field]) !== "undefined") {
                obj[field] = (typeof (this[field]['toJSON']) === "function")
                    ? this[field]['toJSON']()
                    : this[`_${field}`];
            }
        }
        return obj;
    }

    discardAllChanges() {
        this.$changes.discardAll();
    }

    protected getByIndex(index: number) {
        return this[this._definition.fieldsByIndex[index]];
    }

    protected deleteByIndex(index: number) {
        this[this._definition.fieldsByIndex[index]] = undefined;
    }

    private tryEncodeTypeId (bytes: number[], type: typeof Schema, targetType: typeof Schema) {
        if (type._typeid !== targetType._typeid) {
            encode.uint8(bytes, TYPE_ID);
            encode.number(bytes, targetType._typeid);
        }
    }

    private getSchemaType(bytes: number[], it: Iterator, defaultType: typeof Schema): typeof Schema {
        let type: typeof Schema;

        if (bytes[it.offset] === TYPE_ID) {
            it.offset++;
            type = (this.constructor as typeof Schema)._context.get(decode.number(bytes, it));
        }

        return type || defaultType;
    }

    private createTypeInstance (type: typeof Schema): Schema {
        let instance: Schema = new (type as any)();

        // assign root on $changes
        instance.$changes.root = this.$changes.root;

        return instance;
    }

    private _triggerAllFillChanges(ref: Ref, allChanges: Map<number, DataChange[]>) {
        if (allChanges.has(ref['$changes'].refId)) { return; }

        const changes: DataChange[] = [];
        allChanges.set(ref['$changes'].refId || 0, changes);

        if (ref instanceof Schema) {
            const schema = ref._definition.schema;

            for (let fieldName in schema) {
                const _field = `_${fieldName}`;
                const value = ref[_field];

                if (value !== undefined) {
                    changes.push({
                        op: OPERATION.ADD,
                        field: fieldName,
                        value,
                        previousValue: undefined
                    });

                    if (value['$changes'] !== undefined) {
                        Schema.prototype._triggerAllFillChanges.call(this, value, allChanges);
                    }

                }
            }

        } else {
            const entries: IterableIterator<[any, any]>  = ref.entries();
            let iter: IteratorResult<[any, any]>;

            while ((iter = entries.next()) && !iter.done) {
                const [key, value] = iter.value;

                changes.push({
                    op: OPERATION.ADD,
                    field: key,
                    dynamicIndex: key,
                    value: value,
                    previousValue: undefined,
                });

                if (value['$changes'] !== undefined) {
                    Schema.prototype._triggerAllFillChanges.call(this, value, allChanges);
                }
            }
        }
    }

    private _triggerChanges(allChanges: Map<number, DataChange[]>) {
        allChanges.forEach((changes, refId) => {
            if (changes.length > 0) {
                const ref = this.$changes.root.refs.get(refId);
                const isSchema = ref instanceof Schema;

                for (let i = 0; i < changes.length; i++) {
                    const change = changes[i];
                    const listener = ref['$listeners'] && ref['$listeners'][change.field];

                    if (!isSchema) {
                        if (change.op === OPERATION.ADD && change.previousValue === undefined) {
                            (ref as SchemaDecoderCallbacks).onAdd?.(change.value, change.dynamicIndex ?? change.field);

                        } else if (change.op === OPERATION.DELETE) {
                            //
                            // FIXME: `previousValue` should always be avaiiable.
                            // ADD + DELETE operations are still encoding DELETE operation.
                            //
                            if (change.previousValue !== undefined) {
                                (ref as SchemaDecoderCallbacks).onRemove?.(change.previousValue, change.dynamicIndex ?? change.field);
                            }

                        } else if (change.op === OPERATION.DELETE_AND_ADD) {
                            if (change.previousValue !== undefined) {
                                (ref as SchemaDecoderCallbacks).onRemove?.(change.previousValue, change.dynamicIndex);
                            }
                            (ref as SchemaDecoderCallbacks).onAdd?.(change.value, change.dynamicIndex);

                        } else if (
                            change.op === OPERATION.REPLACE ||
                            change.value !== change.previousValue
                        ) {
                            (ref as SchemaDecoderCallbacks).onChange?.(change.value, change.dynamicIndex);
                        }
                    }

                    //
                    // trigger onRemove on child structure.
                    //
                    if (
                        (change.op & OPERATION.DELETE) === OPERATION.DELETE &&
                        change.previousValue instanceof Schema &&
                        change.previousValue.onRemove
                    ) {
                        change.previousValue.onRemove();
                    }

                    if (listener) {
                        try {
                            listener.invoke(change.value, change.previousValue);
                        } catch (e) {
                            Schema.onError(e);
                        }
                    }
                }

                if (isSchema) {
                    if (ref.onChange) {
                        try {
                            (ref as Schema).onChange(changes);
                        } catch (e) {
                            Schema.onError(e);
                        }
                    }
                }

            }

        });
    }
}
