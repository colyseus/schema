import { refTreeOf, installUntrackedChangeTree, decodedRefIdOf, treeOfDecoded } from "../encoder/ChangeTree.js";
import { $childType, $onChange, $onRemove } from "../types/symbols.js";
import { descriptorOf, fieldOf } from "../encoder/EncodeDescriptor.js";
import type { IRef } from "../encoder/ChangeTree.js";
import { spliceOne } from "../types/utils.js";
import { RefTable, CallbacksTable } from "../RefTable.js";
import { OPERATION } from "../encoding/spec.js";
import { Schema } from "../Schema.js";

import type { MapSchema } from "../types/custom/MapSchema.js";
import type { RefInfo } from "./DecodeOperation.js";

class DecodingWarning extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DecodingWarning";
    }
}

/**
 * Used for decoding only.
 */

/**
 * A Schema instance's callbacks, one plain object: field name → listeners,
 * plus the instance's own `onChange` / `onRemove` lists and dispatch stamp
 * under "~" keys, which no field name can take.
 */
export type SchemaCallbacks = { [key: string]: any };

/**
 * A collection's callbacks: one fixed shape, so the dispatchers' per-change
 * slot reads stay monomorphic. The lists are not stored under their OPERATION
 * values: an integer key like ADD = 128 makes V8 size an object's elements
 * store past it, ~1.8 KB per table.
 */
export class CollectionCallbacks {
    /** OPERATION.ADD */
    onAdd: Function[] | undefined = undefined;
    /** OPERATION.DELETE */
    onRemove: Function[] | undefined = undefined;
    /** OPERATION.REPLACE */
    onChange: Function[] | undefined = undefined;
}

export type RefCallbacks = SchemaCallbacks | CollectionCallbacks;

/** `$callbacks`'s list for a field name or an OPERATION, created when missing. */
function listOf($callbacks: RefCallbacks, fieldOrOperation: string | number): Function[] {
    if ($callbacks instanceof CollectionCallbacks) {
        switch (fieldOrOperation) {
            case OPERATION.ADD: return $callbacks.onAdd ??= [];
            case OPERATION.DELETE: return $callbacks.onRemove ??= [];
            case OPERATION.REPLACE: return $callbacks.onChange ??= [];
        }
    } else {
        if (typeof fieldOrOperation === "string") return $callbacks[fieldOrOperation] ??= [];
        if (fieldOrOperation === OPERATION.DELETE) return $callbacks[$onRemove] ??= [];
        if (fieldOrOperation === OPERATION.REPLACE) return $callbacks[$onChange] ??= [];
    }
    throw new Error(`no '${OPERATION[fieldOrOperation as number] ?? fieldOrOperation}' callbacks on this ref`);
}


export class ReferenceTracker {
    //
    // Relation of refId => Schema structure
    // For direct access of structures during decoding time.
    // A `RefTable` has the read surface of the `Map<number, IRef>` it
    // replaces (get / has / size / keys / values / entries / forEach /
    // iteration, in ascending refId order).
    //
    public refs = new RefTable<IRef>();

    /** The decode loop's lookup (two array loads — see `RefTable`). */
    getRef(refId: number): IRef | undefined {
        return this.refs.get(refId);
    }

    /**
     * refId → reference count. A `RefTable` (refIds are handed out in order and
     * never recycled), not an integer-keyed plain object (see `RefTable`).
     * `undefined` = not tracked (never added, or collected); `0` = released,
     * pending GC.
     */
    public refCount = new RefTable<number>();
    public deletedRefs = new Set<number>();

    /**
     * refId → registered callbacks; a `RefTable` for the same reason as
     * `refCount` (a `CallbacksTable`: its own `get`, see there).
     */
    public callbacks: RefTable<RefCallbacks> = new CallbacksTable<RefCallbacks>();
    /** @internal Bumped once per dispatch; the `$dispatchedGen` stamp of a Schema table with an `onChange` list makes it fire once per batch. */
    dispatchGen: number = 0;
    protected nextUniqueId: number = 0;

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    // for decoding
    addRef(refId: number, ref: IRef, incrementCount: boolean = true) {
        this.refs.set(refId, ref);

        // The refId lives on the ref's (Untracked)ChangeTree; `ref[$refId]` is
        // a prototype accessor over it, so it stays out of `deepStrictEqual`.
        let tree = refTreeOf(ref);
        if (tree === undefined) {
            // A ref no factory of this library built: give it the same stub a
            // decoder-built instance carries — one home for the refId, and the
            // decode loop finds the tree it expects.
            installUntrackedChangeTree(ref);
            tree = refTreeOf(ref)!;
        }
        tree.refId = refId;

        if (incrementCount) {
            this.refCount.increment(refId);
        }

        if (this.deletedRefs.has(refId)) {
            this.deletedRefs.delete(refId);
        }
    }

    // for decoding
    removeRef(refId: number) {
        const refCount = this.refCount.get(refId);

        if (refCount === undefined) {
            try {
                throw new DecodingWarning("trying to remove refId that doesn't exist: " + refId);
            } catch (e) {
                console.warn(e);
            }
            return;
        }

        if (refCount === 0) {
            try {
                const ref = this.refs.get(refId);
                throw new DecodingWarning(`trying to remove refId '${refId}' with 0 refCount (${ref.constructor.name}: ${JSON.stringify(ref)})`);
            } catch (e) {
                console.warn(e);
            }
            return;
        }

        this.refCount.set(refId, refCount - 1);
        if (refCount <= 1) {
            this.deletedRefs.add(refId);
        }
    }

    clearRefs() {
        this.refs.clear();
        this.deletedRefs.clear();
        this.callbacks.clear();
        this.refCount.clear();
    }

    // for decoding
    garbageCollectDeletedRefs() {
        if (this.deletedRefs.size === 0) return; // the common patch: nothing released this decode
        this.deletedRefs.forEach((refId) => {
            //
            // Skip active references.
            //
            if (this.refCount.get(refId)! > 0) { return; } // undefined > 0 is false

            const ref = this.getRef(refId)!;

            //
            // Ensure child schema instances have their references removed as well.
            //
            const tree: any = treeOfDecoded(ref);
            const ri: RefInfo | undefined = tree.decodeInfo; // the root may have none yet
            const desc = (ri !== undefined) ? ri.info
                : ((ref.constructor as any)[Symbol.metadata] != null) ? descriptorOf(ref.constructor) : undefined;
            if (desc !== undefined) {
                const refIndexes = desc.refIndexes;
                const values = tree.values;
                for (let i = 0, len = refIndexes.length; i < len; i++) {
                    const childRefId = decodedRefIdOf(fieldOf(desc, ref, values, refIndexes[i]));
                    if (childRefId !== undefined && !this.deletedRefs.has(childRefId)) {
                        this.removeRef(childRefId);
                    }
                }

            } else {
                if (typeof ((ref as any)[$childType]) === "function") {
                    // removeRef only appends to deletedRefs (a Set: safe to grow during forEach),
                    // so the values can be walked directly instead of copied into an array first
                    for (const child of (ref as MapSchema).values()) {
                        const childRefId = decodedRefIdOf(child);
                        if (childRefId !== undefined && !this.deletedRefs.has(childRefId)) {
                            this.removeRef(childRefId);
                        }
                    }
                }
            }

            this.refs.delete(refId); // remove ref
            this.refCount.delete(refId); // remove ref count
            this.callbacks.delete(refId); // remove callbacks
        });

        // clear deleted refs.
        this.deletedRefs.clear();
    }

    addCallback(refId: number, fieldOrOperation: string | number, callback: Function) {
        if (refId === undefined) {
            const name = (typeof(fieldOrOperation) === "number")
                    ? OPERATION[fieldOrOperation]
                    : fieldOrOperation
            throw new Error(
                `Can't addCallback on '${name}' (refId is undefined)`
            );
        }
        let $callbacks = this.callbacks.get(refId);
        if ($callbacks === undefined) {
            const ref: any = this.refs.get(refId);
            $callbacks = (ref !== undefined && !Schema.isSchema(ref)) ? new CollectionCallbacks() : {}; // the dispatchers' test
            this.callbacks.set(refId, $callbacks);
        }
        listOf($callbacks, fieldOrOperation).push(callback);
        return () => this.removeCallback(refId, fieldOrOperation, callback);
    }

    removeCallback(refId: number, field: string | number, callback: Function) {
        const $callbacks = this.callbacks.get(refId);
        if ($callbacks === undefined) { return; }
        const list = listOf($callbacks, field);
        const index = list.indexOf(callback);
        if (index !== -1) {
            spliceOne(list, index);
        }
    }

}
