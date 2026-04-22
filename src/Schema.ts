import { OPERATION } from './encoding/spec.js';
import { DEFAULT_VIEW_TAG, type DefinitionType } from "./annotations.js";

import { AssignableProps, NonFunctionPropNames, ToJSON } from './types/HelperTypes.js';

import { ChangeTree, installUntrackedChangeTree, IRef, Ref } from './encoder/ChangeTree.js';
import { $changes, $decoder, $deleteByIndex, $encoder, $filter, $getByIndex, $numFields, $refId, $track, $values } from './types/symbols.js';
import { StateView } from './encoder/StateView.js';

import { encodeSchemaOperation } from './encoder/EncodeOperation.js';
import { decodeSchemaOperation } from './decoder/DecodeOperation.js';

import type { Decoder } from './decoder/Decoder.js';
import type { Metadata, MetadataField } from './Metadata.js';
import { getIndent } from './utils.js';

/**
 * Schema encoder / decoder
 */
export class Schema<C = any> implements IRef {
    static [Symbol.metadata]: Metadata;
    static [$encoder] = encodeSchemaOperation;
    static [$decoder] = decodeSchemaOperation;

    [$refId]?: number;
    [$values]: any[];

    /**
     * Initialize change tracking on this instance.
     * Field accessor descriptors (getter/setter) live on the prototype,
     * installed once at class-definition time. Per-instance work is limited
     * to allocating a ChangeTree and a values array.
     */
    static initialize(instance: any) {
        // $changes MUST be non-enumerable: tests use assert.deepStrictEqual on
        // Schema instances (e.g. arrayOfPlayers.toArray()), which walks
        // enumerable own Symbol properties. ChangeTree has circular refs
        // (root → changeTrees → other ChangeTrees), so a visible $changes
        // would send deepStrictEqual into exponential recursion. Plain
        // assignment of a Symbol key would be enumerable: true — hence we
        // keep defineProperty here.
        Object.defineProperty(instance, $changes, {
            value: new ChangeTree(instance),
            enumerable: false,
            writable: true
        });
        instance[$values] = [];
    }

    /**
     * Decoder-side factory. Skips the user subclass ctor entirely —
     * decoder-built instances are passive mirrors of server state, so any
     * field initializer / ctor body work would be overwritten by the
     * decoded ADDs immediately after. Assignment order matches
     * {@link Schema.initialize} so V8 assigns the same hidden class
     * ($changes, then $values), keeping decode-path ICs monomorphic even
     * when tracked and untracked instances coexist.
     *
     * The `this:` constraint pins the return type to the concrete subclass
     * when called as `Player.initializeForDecoder()`, not the base Schema.
     */
    static initializeForDecoder<T extends Schema = Schema>(this: { prototype: T } & typeof Schema): T {
        const inst: any = Object.create(this.prototype);
        installUntrackedChangeTree(inst);
        inst[$values] = [];
        return inst;
    }

    /**
     * Check whether `type` describes a Schema *class* (a subclass
     * constructor carrying `Symbol.metadata`, as installed by `@type`).
     * Returns false for primitive type strings like `"number"`, descriptor
     * objects like `{ map: Player }`, and Schema *instances*.
     *
     * For the instance-level check — "is this value a Schema instance?" —
     * see {@link Schema.isSchema}.
     */
    static is(type: DefinitionType) {
        return typeof((type as typeof Schema)[Symbol.metadata]) === "object";
    }

    /**
     * Check if a value is an *instance* of Schema. Uses duck-typing on
     * `.assign` to work across multiple `@colyseus/schema` versions that
     * may be loaded in the same process (e.g. bundled server types vs.
     * client types in a p2p setup).
     *
     * For the class-level check — "is this type a Schema subclass?" —
     * see {@link Schema.is}.
     *
     * @param obj Value to check
     * @returns true if the value is a Schema instance
     */
    static isSchema(obj: any): obj is Schema {
        return typeof obj?.assign === "function";
    }

    /**
     * Track property changes. Exposed as an override point so downstream
     * tools (debuggers, transparent proxies, custom instrumentation) can
     * intercept per-field writes. Hot-path code in `annotations.ts` calls
     * `(this.constructor as typeof Schema)[$track](...)` rather than
     * `changeTree.change(...)` directly so any subclass override wins.
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
            return view.hasTagOnTree(ref[$changes], tag);
        }
    }

    // allow inherited classes to have a constructor
    constructor(arg?: C) {
        Schema.initialize(this);
        if (arg) {
            Schema.assignProps(this, arg);
        }
    }

    /**
     * Assign properties to the instance.
     * @param props Properties to assign to the instance
     * @returns
     */
    public assign<T extends Partial<this>>(props: AssignableProps<T>,): this {
        Schema.assignProps(this, props);
        return this;
    }

    /**
     * Metadata-driven property assignment.
     * Reads tracked fields via property access (works with prototype accessors),
     * then copies any remaining own properties for non-tracked fields.
     */
    protected static assignProps(target: any, source: any) {
        const metadata: Metadata = target.constructor[Symbol.metadata];
        if (metadata && metadata[$numFields] !== undefined) {
            for (let i = 0; i <= metadata[$numFields]; i++) {
                const field = metadata[i];
                if (!field) { continue; }
                const value = source[field.name];
                if (value !== undefined) {
                    target[field.name] = value;
                }
            }
        }
        // Copy non-tracked own properties (e.g. `notSynched: true`).
        const keys = Object.keys(source);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (metadata && metadata[key] !== undefined) { continue; }
            target[key] = source[key];
        }
    }

    /**
     * Restore the instance from JSON data.
     * @param jsonData JSON data to restore the instance from
     * @returns
     */
    public restore(jsonData: ToJSON<this>): this {
        const metadata: Metadata = (this.constructor as typeof Schema)[Symbol.metadata];

        for (const fieldIndex in metadata) {
            const field = metadata[fieldIndex as any as number];
            const fieldName = field.name as keyof this;
            const fieldType = field.type;
            const value = (jsonData as any)[fieldName];

            if (value === undefined || value === null) {
                continue;
            }

            if (typeof fieldType === "string") {
                // Primitive type: assign directly
                this[fieldName] = value;

            } else if (Schema.is(fieldType)) {
                // Schema type: create instance and restore
                const instance = new (fieldType as typeof Schema)();
                instance.restore(value);
                this[fieldName] = instance as any;

            } else if (typeof fieldType === "object") {
                // Collection types: { map: ... }, { array: ... }, etc.
                const collectionType = Object.keys(fieldType)[0] as string;
                const childType = (fieldType as any)[collectionType];

                if (collectionType === "map") {
                    const mapSchema = this[fieldName] as any;
                    for (const key in value) {
                        if (Schema.is(childType)) {
                            const childInstance = new (childType as typeof Schema)();
                            childInstance.restore(value[key]);
                            mapSchema.set(key, childInstance);
                        } else {
                            mapSchema.set(key, value[key]);
                        }
                    }

                } else if (collectionType === "array") {
                    const arraySchema = this[fieldName] as any;
                    for (let i = 0; i < value.length; i++) {
                        if (Schema.is(childType)) {
                            const childInstance = new (childType as typeof Schema)();
                            childInstance.restore(value[i]);
                            arraySchema.push(childInstance);
                        } else {
                            arraySchema.push(value[i]);
                        }
                    }
                }
            }
        }

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

    // ────────────────────────────────────────────────────────────────────
    // Change-tracking control API
    //
    // By default, every mutation to a @type() property is automatically
    // recorded as a change. These methods let you opt out for bulk-load
    // scenarios or custom batching.
    //
    // @example
    //   // Bulk-load without emitting changes:
    //   player.untracked(() => {
    //     player.hp = 100;
    //     player.name = "alice";
    //   });
    //
    //   // Pause / resume pattern:
    //   player.pauseTracking();
    //   player.hp = 100;   // not tracked
    //   player.resumeTracking();
    //   player.hp = 50;    // tracked
    // ────────────────────────────────────────────────────────────────────

    /** Stop recording mutations until resumeTracking() is called. */
    public pauseTracking(): void {
        this[$changes].pause();
    }

    /** Re-enable automatic change tracking. */
    public resumeTracking(): void {
        this[$changes].resume();
    }

    /**
     * Run `fn` with change tracking paused, then resume.
     * Returns the function's return value. Safe to nest.
     */
    public untracked<T>(fn: () => T): T {
        return this[$changes].untracked(fn);
    }

    /** True while tracking is paused. */
    public get isTrackingPaused(): boolean {
        return this[$changes].paused;
    }

    clone (): this {
        // Create instance without calling custom constructor
        const cloned = Object.create(this.constructor.prototype);
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

    toJSON (this: any): ToJSON<this> {
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
        return obj;
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

        const refId = (ref as IRef)[$refId];
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

    /**
     * @param changeSet
     *  - "changes": iterate the current-tick dirty queue (per-tick encode order)
     *  - "allChanges" / "allFilteredChanges" (legacy): structurally walk the
     *    tree in DFS preorder (matches the order in which full-sync emits
     *    trees). The two legacy modes differ by which side of the filter
     *    split they include.
     */
    static debugRefIdEncodingOrder<T extends Ref>(
        ref: T,
        changeSet: "changes" | "allChanges" | "allFilteredChanges" = 'allChanges'
    ) {
        const encodeOrder: number[] = [];
        const rootChangeTree = ref[$changes];

        if (changeSet === "changes") {
            let current = rootChangeTree.root.changes?.next;
            while (current) {
                if (current.changeTree) {
                    encodeOrder.push(current.changeTree.ref[$refId]);
                }
                current = current.next;
            }
            return encodeOrder;
        }

        // Full-sync modes: DFS preorder from root, filtered by tree's
        // filter-status to match the unfiltered / filtered split.
        const wantFiltered = (changeSet === "allFilteredChanges");
        const visited = new Set<ChangeTree>();
        const walk = (changeTree: ChangeTree) => {
            if (visited.has(changeTree)) return;
            visited.add(changeTree);
            if (changeTree.isFiltered === wantFiltered) {
                encodeOrder.push(changeTree.ref[$refId]);
            }
            changeTree.forEachChild((child, _) => walk(child));
        };
        walk(rootChangeTree);
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
        const label = isEncodeAll ? "allChanges" : "changes";
        let output = `${instance.constructor.name} (${instance[$refId]}) -> .${label}:\n`;

        if (isEncodeAll) {
            changeTree.forEachLive((index) => {
                output += `- [${index}]: ADD (${JSON.stringify(changeTree.getValue(Number(index), true))})\n`;
            });
        } else {
            changeTree.forEach((index, op) => {
                if (index < 0 || !op) return;
                output += `- [${index}]: ${OPERATION[op]} (${JSON.stringify(changeTree.getValue(Number(index), false))})\n`;
            });
        }

        return output;
    }

}

