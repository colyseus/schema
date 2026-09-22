import { Metadata } from "../Metadata.js";
import { refTreeOf, installUntrackedChangeTree, decodedRefIdOf } from "../encoder/ChangeTree.js";
import { $childType } from "../types/symbols.js";
import type { IRef } from "../encoder/ChangeTree.js";
import { spliceOne } from "../types/utils.js";
import { RefTable } from "../RefTable.js";
import { OPERATION } from "../encoding/spec.js";

import type { MapSchema } from "../types/custom/MapSchema.js";
import type { Schema } from "../Schema.js";

class DecodingWarning extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DecodingWarning";
    }
}

/**
 * Used for decoding only.
 */

export type SchemaCallbacks = { [field: string | number]: Function[] };


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
     * never recycled): as an integer-keyed plain object the store in `addRef`
     * and the `delete` in `garbageCollectDeletedRefs` were ~10–15 % of a
     * decoder churn loop. `undefined` = not tracked (never added, or
     * collected); `0` = released, pending GC.
     */
    public refCount = new RefTable<number>();
    public deletedRefs = new Set<number>();

    /** refId → registered callbacks; a `RefTable` for the same reason as `refCount`. */
    public callbacks = new RefTable<SchemaCallbacks>();
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
            const count = this.refCount.get(refId);
            this.refCount.set(refId, (count === undefined) ? 1 : count + 1);
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
            if ((ref.constructor as typeof Schema)[Symbol.metadata] !== undefined) {
                const metadata: Metadata = (ref.constructor as typeof Schema)[Symbol.metadata];
                for (const index in metadata) {
                    const field = metadata[index as any as number].name;
                    const child = ref[field as keyof IRef];
                    if (typeof(child) === "object" && child) {
                        const childRefId = decodedRefIdOf(child);
                        if (childRefId !== undefined && !this.deletedRefs.has(childRefId)) {
                            this.removeRef(childRefId);
                        }
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
            $callbacks = {};
            this.callbacks.set(refId, $callbacks);
        }
        let list = $callbacks[fieldOrOperation];
        if (list === undefined) {
            list = $callbacks[fieldOrOperation] = [];
        }
        list.push(callback);
        return () => this.removeCallback(refId, fieldOrOperation, callback);
    }

    removeCallback(refId: number, field: string | number, callback: Function) {
        const list = this.callbacks.get(refId)?.[field];
        if (list === undefined) { return; }
        const index = list.indexOf(callback);
        if (index !== -1) {
            spliceOne(list, index);
        }
    }

}
