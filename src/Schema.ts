import { OPERATION } from './encoding/spec';
import { DEFAULT_VIEW_TAG, type DefinitionType } from "./annotations";

import { AssignableProps, NonFunctionPropNames, ToJSON } from './types/HelperTypes';

import { ChangeSet, ChangeSetName, ChangeTree, IRef, Ref } from './encoder/ChangeTree';
import { $changes, $decoder, $deleteByIndex, $descriptors, $encoder, $filter, $getByIndex, $track } from './types/symbols';
import { StateView } from './encoder/StateView';

import { encodeSchemaOperation } from './encoder/EncodeOperation';
import { decodeSchemaOperation } from './decoder/DecodeOperation';

import type { Decoder } from './decoder/Decoder';
import type { Metadata, MetadataField } from './Metadata';
import { getIndent } from './utils';

/**
 * Schema encoder / decoder
 */
export class Schema<C = any> implements IRef {
    static [Symbol.metadata]: Metadata;
    static [$encoder] = encodeSchemaOperation;
    static [$decoder] = decodeSchemaOperation;

    /**
     * Assign the property descriptors required to track changes on this instance.
     * @param instance
     */
    static initialize(instance: any) {
        Object.defineProperty(instance, $changes, {
            value: new ChangeTree(instance),
            enumerable: false,
            writable: true
        });

        Object.defineProperties(instance, instance.constructor[Symbol.metadata]?.[$descriptors] || {});
    }

    static is(type: DefinitionType) {
        return typeof((type as typeof Schema)[Symbol.metadata]) === "object";
    }

    /**
     * Track property changes
     */
    static [$track] (changeTree: ChangeTree, index: number, operation: OPERATION = OPERATION.ADD) {
        changeTree.change(index, operation);
    }

    /**
     * Determine if a property must be filtered.
     * - If returns false, the property is NOT going to be encoded.
     * - If returns true, the property is going to be encoded.
     *
     * Encoding with "filters" happens in two steps:
     * - First, the encoder iterates over all "not owned" properties and encodes them.
     * - Then, the encoder iterates over all "owned" properties per instance and encodes them.
     */
    static [$filter] (ref: Schema, index: number, view: StateView) {
        const metadata: Metadata = (ref.constructor as typeof Schema)[Symbol.metadata];
        const tag = metadata[index]?.tag;

        if (view === undefined) {
            // shared pass/encode: encode if doesn't have a tag
            return tag === undefined;

        } else if (tag === undefined) {
            // view pass: no tag
            return true;

        } else if (tag === DEFAULT_VIEW_TAG) {
            // view pass: default tag
            return view.isChangeTreeVisible(ref[$changes]);

        } else {
            // view pass: custom tag
            const tags = view.tags?.get(ref[$changes]);
            return tags && tags.has(tag);
        }
    }

    // allow inherited classes to have a constructor
    constructor(arg?: C) {
        //
        // inline
        // Schema.initialize(this);
        //
        Schema.initialize(this);

        //
        // Assign initial values
        //
        if (arg) {
            Object.assign(this, arg);
        }
    }

    public assign<T extends Partial<this>>(
        props: AssignableProps<T>,
    ): this {
        Object.assign(this, props);
        return this;
    }

    /**
     * (Server-side): Flag a property to be encoded for the next patch.
     * @param instance Schema instance
     * @param property string representing the property name, or number representing the index of the property.
     * @param operation OPERATION to perform (detected automatically)
     */
    public setDirty<K extends NonFunctionPropNames<this>>(property: K | number, operation?: OPERATION) {
        const metadata: Metadata = (this.constructor as typeof Schema)[Symbol.metadata];
        this[$changes].change(
            metadata[metadata[property as string]].index,
            operation
        );
    }

    clone (): this {
        // Create instance without calling custom constructor
        const cloned = Object.create((this as any).constructor.prototype);
        Schema.initialize(cloned);

        const metadata: Metadata = (this.constructor as typeof Schema)[Symbol.metadata];

        //
        // TODO: clone all properties, not only annotated ones
        //
        // for (const field in this) {
        for (const fieldIndex in metadata) {
            const field = metadata[fieldIndex as any as number].name as keyof this;

            if (
                typeof (this[field]) === "object" &&
                typeof ((this[field] as any)?.clone) === "function"
            ) {
                // deep clone
                cloned[field] = (this[field] as any).clone();

            } else {
                // primitive values
                cloned[field] = this[field];
            }
        }

        return cloned;
    }

    toJSON (this: any) {
        const obj: any = {};
        const metadata = this.constructor[Symbol.metadata];
        for (const index in metadata) {
            const field = metadata[index] as MetadataField;
            const fieldName = field.name;
            if (!field.deprecated && this[fieldName] !== null && typeof (this[fieldName]) !== "undefined") {
                obj[fieldName] = (typeof (this[fieldName]['toJSON']) === "function")
                    ? this[fieldName]['toJSON']()
                    : this[fieldName];
            }
        }
        return obj as ToJSON<typeof this>;
    }

    /**
     * Used in tests only
     * @internal
     */
    discardAllChanges() {
        this[$changes].discardAll();
    }

    [$getByIndex](index: number): any {
        const metadata: Metadata = (this.constructor as typeof Schema)[Symbol.metadata];
        return this[metadata[index].name as keyof this];
    }

    [$deleteByIndex](index: number): void {
        const metadata: Metadata = (this.constructor as typeof Schema)[Symbol.metadata];
        this[metadata[index].name as keyof this] = undefined;
    }

    /**
     * Inspect the `refId` of all Schema instances in the tree. Optionally display the contents of the instance.
     *
     * @param ref Schema instance
     * @param showContents display JSON contents of the instance
     * @returns
     */
    static debugRefIds<T extends Schema>(ref: T, showContents: boolean = false, level: number = 0, decoder?: Decoder, keyPrefix: string = "") {
        const contents = (showContents) ? ` - ${JSON.stringify(ref.toJSON())}` : "";
        const changeTree: ChangeTree = ref[$changes];

        const refId = (decoder) ? decoder.root.refIds.get(ref) : changeTree.refId;
        const root = (decoder) ? decoder.root : changeTree.root;

         // log reference count if > 1
        const refCount = (root?.refCount?.[refId] > 1)
            ? ` [×${root.refCount[refId]}]`
            : '';

        let output = `${getIndent(level)}${keyPrefix}${ref.constructor.name} (refId: ${refId})${refCount}${contents}\n`;

        changeTree.forEachChild((childChangeTree, indexOrKey) => {
            let key = indexOrKey;
            if (typeof indexOrKey === 'number' && (ref as any)['$indexes']) {
                // MapSchema
                key = (ref as any)['$indexes'].get(indexOrKey) ?? indexOrKey;
            }
            const keyPrefix = ((ref as any)['forEach'] !== undefined && key !== undefined) ? `["${key}"]: ` : "";
            output += this.debugRefIds(childChangeTree.ref, showContents, level + 1, decoder, keyPrefix);
        });

        return output;
    }

    static debugRefIdEncodingOrder<T extends Ref>(ref: T, changeSet: ChangeSetName = 'allChanges') {
        let encodeOrder: number[] = [];
        let current = ref[$changes].root[changeSet].next;
        while (current) {
            if (current.changeTree) {
                encodeOrder.push(current.changeTree.refId);
            }
            current = current.next;
        }
        return encodeOrder;
    }

    static debugRefIdsFromDecoder(decoder: Decoder) {
        return this.debugRefIds(decoder.state, false, 0, decoder);
    }

    /**
     * Return a string representation of the changes on a Schema instance.
     * The list of changes is cleared after each encode.
     *
     * @param instance Schema instance
     * @param isEncodeAll Return "full encode" instead of current change set.
     * @returns
     */
    static debugChanges<T extends Ref>(instance: T, isEncodeAll: boolean = false) {
        const changeTree: ChangeTree = instance[$changes];

        const changeSet = (isEncodeAll) ? changeTree.allChanges : changeTree.changes;
        const changeSetName = (isEncodeAll) ? "allChanges" : "changes";

        let output = `${instance.constructor.name} (${changeTree.refId}) -> .${changeSetName}:\n`;

        function dumpChangeSet(changeSet: ChangeSet) {
            changeSet.operations
                .filter(op => op)
                .forEach((index) => {
                    const operation = changeTree.indexedOperations[index];
                    output += `- [${index}]: ${OPERATION[operation]} (${JSON.stringify(changeTree.getValue(Number(index), isEncodeAll))})\n`
                });
        }

        dumpChangeSet(changeSet);

        // display filtered changes
        if (
            !isEncodeAll &&
            changeTree.filteredChanges &&
            (changeTree.filteredChanges.operations).filter(op => op).length > 0
        ) {
            output += `${instance.constructor.name} (${changeTree.refId}) -> .filteredChanges:\n`;
            dumpChangeSet(changeTree.filteredChanges);
        }

        // display filtered changes
        if (
            isEncodeAll &&
            changeTree.allFilteredChanges &&
            (changeTree.allFilteredChanges.operations).filter(op => op).length > 0
        ) {
            output += `${instance.constructor.name} (${changeTree.refId}) -> .allFilteredChanges:\n`;
            dumpChangeSet(changeTree.allFilteredChanges);
        }

        return output;
    }

    static debugChangesDeep<T extends Schema>(ref: T, changeSetName: "changes" | "allChanges" | "allFilteredChanges" | "filteredChanges" = "changes") {
        let output = "";

        const rootChangeTree: ChangeTree = ref[$changes];
        const root = rootChangeTree.root;
        const changeTrees: Map<ChangeTree, ChangeTree[]> = new Map();

        const instanceRefIds = [];
        let totalOperations = 0;

        // TODO: FIXME: this method is not working as expected
        for (const [refId, changes] of Object.entries(root[changeSetName])) {
            const changeTree = root.changeTrees[refId as any as number];
            if (!changeTree) { continue; }

            let includeChangeTree = false;
            let parentChangeTrees: ChangeTree[] = [];
            let parentChangeTree = changeTree.parent?.[$changes];

            if (changeTree === rootChangeTree) {
                includeChangeTree = true;

            } else {
                while (parentChangeTree !== undefined) {
                    parentChangeTrees.push(parentChangeTree);
                    if (parentChangeTree.ref === ref) {
                        includeChangeTree = true;
                        break;
                    }
                    parentChangeTree = parentChangeTree.parent?.[$changes];
                }
            }

            if (includeChangeTree) {
                instanceRefIds.push(changeTree.refId);
                totalOperations += Object.keys(changes).length;
                changeTrees.set(changeTree, parentChangeTrees.reverse());
            }
        }

        output += "---\n"
        output += `root refId: ${rootChangeTree.refId}\n`;
        output += `Total instances: ${instanceRefIds.length} (refIds: ${instanceRefIds.join(", ")})\n`;
        output += `Total changes: ${totalOperations}\n`;
        output += "---\n"

        // based on root.changes, display a tree of changes that has the "ref" instance as parent
        const visitedParents = new WeakSet<ChangeTree>();
        for (const [changeTree, parentChangeTrees] of changeTrees.entries()) {
            parentChangeTrees.forEach((parentChangeTree, level) => {
                if (!visitedParents.has(parentChangeTree)) {
                    output += `${getIndent(level)}${parentChangeTree.ref.constructor.name} (refId: ${parentChangeTree.refId})\n`;
                    visitedParents.add(parentChangeTree);
                }
            });

            const changes = changeTree.indexedOperations;
            const level = parentChangeTrees.length;
            const indent = getIndent(level);

            const parentIndex = (level > 0) ? `(${changeTree.parentIndex}) ` : "";
            output += `${indent}${parentIndex}${changeTree.ref.constructor.name} (refId: ${changeTree.refId}) - changes: ${Object.keys(changes).length}\n`;

            for (const index in changes) {
                const operation = changes[index];
                output += `${getIndent(level + 1)}${OPERATION[operation]}: ${index}\n`;
            }
        }

        return `${output}`;
    }


}

