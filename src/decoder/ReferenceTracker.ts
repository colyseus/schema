import { Metadata } from "../Metadata";
import { $changes } from "../types/symbols";
import { Ref } from "../encoder/ChangeTree";
import { spliceOne } from "../types/utils";
import type { MapSchema } from "../types/custom/MapSchema";

/**
 * Used for decoding only.
 */

export type SchemaCallbacks = { [field: string | number]: Function[] };

export class ReferenceTracker {
    //
    // Relation of refId => Schema structure
    // For direct access of structures during decoding time.
    //
    public refs = new Map<number, Ref>();
    public refIds = new WeakMap<Ref, number>();

    public refCounts: { [refId: number]: number; } = {};
    public deletedRefs = new Set<number>();

    public callbacks: { [refId: number]: SchemaCallbacks } = {};
    protected nextUniqueId: number = 0;

    getNextUniqueId() {
        return this.nextUniqueId++;
    }

    // for decoding
    addRef(refId: number, ref: Ref, incrementCount: boolean = true) {
        this.refs.set(refId, ref);
        this.refIds.set(ref, refId);

        if (incrementCount) {
            this.refCounts[refId] = (this.refCounts[refId] || 0) + 1;
        }
    }

    // for decoding
    removeRef(refId: number) {
        const refCount = this.refCounts[refId];
        if (refCount === undefined) {
            console.warn(`trying to remove refId '${refId}' that doesn't exist`);
            return;
        }
        if (refCount === 0) {
            console.warn(`trying to remove refId '${refId}' with 0 refCount`);
            return;
        }

        this.refCounts[refId] = refCount - 1;
        this.deletedRefs.add(refId);
    }

    clearRefs() {
        this.refs.clear();
        this.deletedRefs.clear();
        this.refCounts = {};
    }

    // for decoding
    garbageCollectDeletedRefs() {
        this.deletedRefs.forEach((refId) => {
            //
            // Skip active references.
            //
            if (this.refCounts[refId] > 0) { return; }

            const ref = this.refs.get(refId);

            //
            // Ensure child schema instances have their references removed as well.
            //
            if (Metadata.isValidInstance(ref)) {
                const metadata: Metadata = ref['constructor'][Symbol.metadata];
                for (const field in metadata) {
                    if (typeof (metadata[field].type) !== "string" &&
                        ref[field] &&
                        ref[field][$changes]) { // FIXME: this will not work anymore.
                        this.removeRef(ref[field][$changes].refId);
                    }
                }

            } else {
                const metadata: Metadata = ref[$changes].parent['constructor'][Symbol.metadata];
                const type =  metadata.schema[metadata.fieldsByIndex[ref[$changes].parentIndex]];

                if (typeof (Object.values(type)[0]) === "function") {
                    Array.from((ref as MapSchema).values())
                        .forEach((child) => this.removeRef(child[$changes].refId));
                }
            }

            this.refs.delete(refId); // remove ref
            delete this.refCounts[refId]; // remove ref count
            delete this.callbacks[refId]; // remove callbacks
        });

        // clear deleted refs.
        this.deletedRefs.clear();
    }

    addCallback(refId: number, field: string | number, callback: Function) {
        if (!this.callbacks[refId]) {
            this.callbacks[refId] = {};
        }
        if (!this.callbacks[refId][field]) {
            this.callbacks[refId][field] = [];
        }
        this.callbacks[refId][field].push(callback);
        return () => this.removeCallback(refId, field, callback);
    }

    removeCallback(refId: number, field: string | number, callback: Function) {
        const index = this.callbacks?.[refId]?.[field]?.indexOf(callback);
        if (index !== -1) {
            spliceOne(this.callbacks[refId][field], index);
        }
    }

}
