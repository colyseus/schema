import { OPERATION } from './encoding/spec';
import { DEFAULT_VIEW_TAG, DefinitionType } from "./annotations";

import { NonFunctionPropNames, ToJSON } from './types/HelperTypes';

import { ChangeTree, Ref } from './encoder/ChangeTree';
import { $changes, $decoder, $deleteByIndex, $encoder, $filter, $getByIndex, $track } from './types/symbols';
import { StateView } from './encoder/StateView';

import { encodeSchemaOperation } from './encoder/EncodeOperation';
import { decodeSchemaOperation } from './decoder/DecodeOperation';
import type { Metadata } from './Metadata';
import { getIndent } from './utils';

/**
 * Schema encoder / decoder
 */
export abstract class Schema {

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

        const metadata = instance.constructor[Symbol.metadata];

        // Define property descriptors
        for (const field in metadata) {
            if (metadata[field].descriptor) {
                // for encoder
                Object.defineProperty(instance, `_${field}`, {
                    value: undefined,
                    writable: true,
                    enumerable: false,
                    configurable: true,
                });
                Object.defineProperty(instance, field, metadata[field].descriptor);

            } else {
                // for decoder
                Object.defineProperty(instance, field,  {
                    value: undefined,
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });
            }

            // Object.defineProperty(instance, field, {
            //     ...instance.constructor[Symbol.metadata][field].descriptor
            // });
            // if (args[0]?.hasOwnProperty(field)) {
            //     instance[field] = args[0][field];
            // }
        }
    }

    static is(type: DefinitionType) {
        return typeof(type[Symbol.metadata]) === "object";
        // const metadata = type[Symbol.metadata];
        // return metadata && Object.prototype.hasOwnProperty.call(metadata, -1);
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
        const metadata: Metadata = ref.constructor[Symbol.metadata];
        const tag = metadata[metadata[index]].tag;

        if (view === undefined) {
            // shared pass/encode: encode if doesn't have a tag
            return tag === undefined;

        } else if (tag === undefined) {
            // view pass: no tag
            return true;

        } else if (tag === DEFAULT_VIEW_TAG) {
            // view pass: default tag
            return view.items.has(ref[$changes]);

        } else {
            // view pass: custom tag
            const tags = view.tags?.get(ref[$changes]);
            return tags && tags.has(tag);
        }
    }

    // allow inherited classes to have a constructor
    constructor(...args: any[]) {
        Schema.initialize(this);

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

    /**
     * (Server-side): Flag a property to be encoded for the next patch.
     * @param instance Schema instance
     * @param property string representing the property name, or number representing the index of the property.
     * @param operation OPERATION to perform (detected automatically)
     */
    public setDirty<K extends NonFunctionPropNames<this>>(property: K | number, operation?: OPERATION) {
        this[$changes].change(
            this.constructor[Symbol.metadata][property as string].index,
            operation
        );
    }

    clone (): this {
        const cloned = new ((this as any).constructor);
        const metadata = this.constructor[Symbol.metadata];

        //
        // TODO: clone all properties, not only annotated ones
        //
        // for (const field in this) {
        for (const field in metadata) {
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
        const metadata = this.constructor[Symbol.metadata];

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
        this[$changes].discardAll();
    }

    protected [$getByIndex](index: number) {
        return this[this.constructor[Symbol.metadata][index]];
    }

    protected [$deleteByIndex](index: number) {
        this[this.constructor[Symbol.metadata][index]] = undefined;
    }

    static debugRefIds(instance: Ref, level: number = 0) {
        const ref = instance;
        const changeTree = ref[$changes];

        let output = "";
        output += `${getIndent(level)}${ref.constructor.name} (${ref[$changes].refId})\n`;

        changeTree.forEachChild((childChangeTree) =>
            output += this.debugRefIds(childChangeTree.ref, level + 1));

        return output;
    }

    static debugCurrentChanges(ref: Ref) {
        let output = "";

        const rootChangeTree = ref[$changes];
        const changeTrees: Map<ChangeTree, ChangeTree[]> = new Map();

        let totalInstances = 0;
        let totalOperations = 0;

        for (const [changeTree, changes] of (rootChangeTree.root.changes.entries())) {
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
                totalInstances += 1;
                totalOperations += changes.size;
                changeTrees.set(changeTree, parentChangeTrees.reverse());
            }
        }

        output += "---\n"
        output += `root refId: ${rootChangeTree.refId}\n`;
        output += `Total instances: ${totalInstances}\n`;
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

            const changes = changeTree.changes;
            const level = parentChangeTrees.length;
            const indent = getIndent(level);

            const parentIndex = (level > 0) ? `(${changeTree.parentIndex}) ` : "";
            output += `${indent}${parentIndex}${changeTree.ref.constructor.name} (refId: ${changeTree.refId}) - changes: ${changes.size}\n`;

            for (const [index, operation] of changes) {
                output += `${getIndent(level + 1)}${OPERATION[operation]}: ${index}\n`;
            }

        }

        return `${output}`;
    }


}

