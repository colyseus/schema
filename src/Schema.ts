import { OPERATION } from './encoding/spec';
import { DefinitionType } from "./annotations";

import { NonFunctionPropNames, ToJSON } from './types/HelperTypes';

import { ChangeTree, Ref } from './encoder/ChangeTree';
import { $changes, $deleteByIndex, $filter, $getByIndex, $isOwned, $track } from './types/symbols';
import { StateView } from './encoder/StateView';

/**
 * Schema encoder / decoder
 */
export abstract class Schema {

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
        const metadata = type[Symbol.metadata];
        return metadata && Object.prototype.hasOwnProperty.call(metadata, -1);
    }

    /**
     * Track property changes
     */
    static [$track] (changeTree: ChangeTree, index: number, operation: OPERATION = OPERATION.ADD) {
        changeTree.change(index, operation);
    }

    /**
     * Determine if a property must be filtered.
     * - If returns true, the property is NOT going to be encoded.
     * - If returns false, the property is going to be encoded.
     *
     * Encoding with "filters" happens in two steps:
     * - First, the encoder iterates over all "not owned" properties and encodes them.
     * - Then, the encoder iterates over all "owned" properties per instance and encodes them.
     */
    static [$filter] (ref: Schema, index: number, view: StateView) {
        const metadata = ref.constructor[Symbol.metadata];
        const field  = metadata[metadata[index]];

        if (view === undefined) {
            return field.owned !== undefined;

        } else {
            return field.owned && !view['owned'].has(ref[$changes]);
        }
    }

    static [$isOwned] (ref: Schema, index: number) {
        const metadata = ref.constructor[Symbol.metadata];
        const field  = metadata[metadata[index]];
        return field.owned !== undefined;
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


}
