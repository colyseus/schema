import { Metadata } from "../Metadata";
import { $childType } from "../types/symbols";
import { Ref } from "../encoder/ChangeTree";
import { spliceOne } from "../types/utils";
import type { MapSchema } from "../types/custom/MapSchema";
import { OPERATION } from "../encoding/spec";

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

        if (this.deletedRefs.has(refId)) {
            this.deletedRefs.delete(refId);
        }
    }

    // for decoding
    removeRef(refId: number) {
        const refCount = this.refCounts[refId];

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

        if ((this.refCounts[refId] = refCount - 1) <= 0) {
            this.deletedRefs.add(refId);
        }
    }

    clearRefs() {
        this.refs.clear();
        this.deletedRefs.clear();
        this.callbacks = {};
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
                const metadata: Metadata = ref.constructor[Symbol.metadata];
                for (const index in metadata) {
                    const field = metadata[index as any as number].name;
                    const childRefId = typeof(ref[field]) === "object" && this.refIds.get(ref[field]);
                    if (childRefId && !this.deletedRefs.has(childRefId)) {
                        this.removeRef(childRefId);
                    }
                }

            } else {
                if (typeof (Object.values(ref[$childType])[0]) === "function") {
                    Array.from((ref as MapSchema).values())
                        .forEach((child) => {
                            const childRefId = this.refIds.get(child);
                            if (!this.deletedRefs.has(childRefId)) {
                                this.removeRef(childRefId);
                            }
                        });
                }
            }

            this.refs.delete(refId); // remove ref
            delete this.refCounts[refId]; // remove ref count
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
        const index = this.callbacks?.[refId]?.[field]?.indexOf(callback);
        if (index !== -1) {
            spliceOne(this.callbacks[refId][field], index);
        }
    }

}
