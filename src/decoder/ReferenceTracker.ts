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

    public refCount: { [refId: number]: number; } = {};
    public deletedRefs = new Set<number>();

    public callbacks: { [refId: number]: SchemaCallbacks } = {};
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
            this.refCount[refId] = (this.refCount[refId] || 0) + 1;
        }

        if (this.deletedRefs.has(refId)) {
            this.deletedRefs.delete(refId);
        }
    }

    // for decoding
    removeRef(refId: number) {
        const refCount = this.refCount[refId];

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

        if ((this.refCount[refId] = refCount - 1) <= 0) {
            this.deletedRefs.add(refId);
        }
    }

    clearRefs() {
        this.refs.clear();
        this.deletedRefs.clear();
        this.callbacks = {};
        this.refCount = {};
    }

    // for decoding
    garbageCollectDeletedRefs() {
        if (this.deletedRefs.size === 0) return; // the common patch: nothing released this decode
        this.deletedRefs.forEach((refId) => {
            //
            // Skip active references.
            //
            if (this.refCount[refId] > 0) { return; }

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
            delete this.refCount[refId]; // remove ref count
            delete this.callbacks[refId]; // remove callbacks
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
        if (!this.callbacks[refId]) {
            this.callbacks[refId] = {};
        }
        if (!this.callbacks[refId][fieldOrOperation]) {
            this.callbacks[refId][fieldOrOperation] = [];
        }
        this.callbacks[refId][fieldOrOperation].push(callback);
        return () => this.removeCallback(refId, fieldOrOperation, callback);
    }

    removeCallback(refId: number, field: string | number, callback: Function) {
        const index: number | undefined = this.callbacks?.[refId]?.[field]?.indexOf(callback);
        if (index !== undefined && index !== -1) {
            spliceOne(this.callbacks[refId][field], index);
        }
    }

}
