import { OPERATION } from './spec';
import { DefinitionType, Metadata } from "./annotations";

import type { Iterator } from "./encoding/decode"; // dts-bundle-generator

import { ChangeTree } from "./changes/ChangeTree";
import { NonFunctionPropNames, ToJSON } from './types/HelperTypes';
import { ReferenceTracker } from './changes/ReferenceTracker';
import { addCallback, spliceOne } from './types/utils';
import { ChangeSet } from './changes/ChangeSet';

export interface DataChange<T=any,F=string> {
    refId: number,
    op: OPERATION,
    field: F;
    dynamicIndex?: number | string;
    value: T;
    previousValue: T;
}

export interface SchemaDecoderCallbacks<TValue=any, TKey=any> {
    $callbacks: { [operation: number]: Array<(item: TValue, key: TKey) => void> };

    onAdd(callback: (item: any, key: any) => void, ignoreExisting?: boolean): () => void;
    onRemove(callback: (item: any, key: any) => void): () => void;
    onChange(callback: (item: any, key: any) => void): () => void;

    clone(decoding?: boolean): SchemaDecoderCallbacks;
    clear(changes?: DataChange[]);
    decode?(byte, it: Iterator);
}

/**
 * Schema encoder / decoder
 */
export abstract class Schema {

    static onError(e) {
        console.error(e);
    }

    static is(type: DefinitionType) {
        const metadata = type[Symbol.metadata];
        return metadata && Metadata.hasFields(metadata);
    }

    protected $changes: ChangeTree;

    // TODO: refactor. this feature needs to be ported to other languages with potentially different API
    // protected $listeners: { [field: string]: Array<(value: any, previousValue: any) => void> };
    protected $callbacks: { [op: number]: Array<Function> };

    public onChange(callback: () => void): () => void {
        return addCallback((this.$callbacks || (this.$callbacks = {})), OPERATION.REPLACE, callback);
    }
    public onRemove(callback: () => void): () => void {
        return addCallback((this.$callbacks || (this.$callbacks = {})), OPERATION.DELETE, callback);
    }

    // allow inherited classes to have a constructor
    constructor(...args: any[]) {
        //
        // Assign initial values
        //
        if (args[0]) {
            this.assign(args[0]);
        }
    }

    public assign(
        props: { [prop in NonFunctionPropNames<this>]?: this[prop] } | ToJSON<this>,
    ) {
        Object.assign(this, props);
        return this;
    }

    get metadata () {
        return Metadata.getFor(this.constructor);
    }

    /**
     * (Server-side): Flag a property to be encoded for the next patch.
     * @param instance Schema instance
     * @param property string representing the property name, or number representing the index of the property.
     * @param operation OPERATION to perform (detected automatically)
     */
    public setDirty<K extends NonFunctionPropNames<this>>(property: K | number, operation?: OPERATION) {
        this.$changes.change(property as any, operation);
    }

    /**
     * Client-side: listen for changes on property.
     * @param prop the property name
     * @param callback callback to be triggered on property change
     * @param immediate trigger immediatelly if property has been already set.
     */
    public listen<K extends NonFunctionPropNames<this>>(
        prop: K,
        callback: (value: this[K], previousValue: this[K]) => void,
        immediate: boolean = true,
    ) {
        if (!this.$callbacks) { this.$callbacks = {}; }
        if (!this.$callbacks[prop as string]) { this.$callbacks[prop as string] = []; }

        this.$callbacks[prop as string].push(callback);

        if (immediate && this[prop] !== undefined) {
            callback(this[prop], undefined);
        }

        // return un-register callback.
        return () => spliceOne(this.$callbacks[prop as string], this.$callbacks[prop as string].indexOf(callback));
    }

    /*
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
    */

    clone (): this {
        const cloned = new ((this as any).constructor);
        const schema = this.metadata.schema;
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

    toJSON () {
        const metadata = this.metadata;

        const obj: unknown = {};
        for (const fieldName in metadata) {
            const field = metadata[fieldName];
            if (!field.deprecated && this[fieldName] !== null && typeof (this[fieldName]) !== "undefined") {
                obj[fieldName] = (typeof (this[fieldName]['toJSON']) === "function")
                    ? this[fieldName]['toJSON']()
                    : this[fieldName];
            }
        }
        return obj as ToJSON<typeof this>;
    }

    discardAllChanges() {
        this.$changes.discardAll();
    }

    protected getByIndex(index: number) {
        return this[this.metadata.fieldsByIndex[index]];
    }

    protected deleteByIndex(index: number) {
        this[this.metadata.fieldsByIndex[index]] = undefined;
    }

}
