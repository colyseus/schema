import { Schema } from "../Schema";
import { Ref } from "./ChangeTree";
import { Metadata } from "../annotations";

export class ReferenceTracker {
    //
    // Relation of refId => Schema structure
    // For direct access of structures during decoding time.
    //
    public refs = new Map<number, Ref>();
    public refIds = new WeakMap<Ref, number>();

    public refCounts: { [refId: number]: number; } = {};
    public deletedRefs = new Set<number>();

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
            console.warn(`trying to remove reference ${refId} that doesn't exist`);
            return;
        }
        if (refCount === 0) {
            console.warn(`trying to remove reference ${refId} with 0 refCount`);
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
            if (ref instanceof Schema) {
                const metadata = ref.metadata;
                for (const field in metadata) {
                    if (typeof (Metadata.getType(metadata, field)) !== "string" &&
                        ref[field] &&
                        ref[field]['$changes']) { // FIXME: this will not work anymore.
                        this.removeRef(ref[field]['$changes'].refId);
                    }
                }

            } else {
                const metadata = ref['$changes'].parent.metadata;
                const type =  metadata.schema[metadata.fieldsByIndex[ref['$changes'].parentIndex]];

                if (typeof (Object.values(type)[0]) === "function") {
                    Array.from(ref.values())
                        .forEach((child) => this.removeRef(child['$changes'].refId));
                }
            }

            this.refs.delete(refId);
            delete this.refCounts[refId];
        });

        // clear deleted refs.
        this.deletedRefs.clear();
    }

}
