import { TypeContext } from "../types/TypeContext.js";
import { $childType, $decoder, $onDecodeEnd, $refId } from "../types/symbols.js";
import { Schema } from "../Schema.js";
import { decode } from "../encoding/decode.js";
import { OPERATION, SWITCH_TO_STRUCTURE, TYPE_ID } from '../encoding/spec.js';
import { type IRef, type Ref } from "../encoder/ChangeTree.js";
import type { Iterator } from "../encoding/decode.js";
import { ReferenceTracker } from "./ReferenceTracker.js";
import { DEFINITION_MISMATCH, type DataChange, type DecodeOperation } from "./DecodeOperation.js";
import { resyncSweep } from "./Resync.js";
import { Collection } from "../types/HelperTypes.js";

export class Decoder<T extends IRef = any> {
    context: TypeContext;

    state: T;
    root: ReferenceTracker;

    currentRefId: number = 0;

    triggerChanges?: (allChanges: DataChange[]) => void;

    /**
     * @internal Non-null only while a `decodeResync()` walk is in progress:
     * collection refId → entry identities the payload visited (map string
     * keys; array/set/collection/stream indexes). Written by the collection
     * DecodeOperation functions, read by the post-decode sweep.
     */
    resyncVisited: Map<number, Set<number | string>> | null = null;

    /**
     * @internal Set when a structure had to be skipped during a resync
     * decode — visited data is incomplete, so the sweep must not delete.
     */
    resyncDamaged: boolean = false;

    constructor(root: T, context?: TypeContext) {
        this.setState(root);

        this.context = context || new TypeContext(root.constructor as typeof Schema);

        // console.log(">>>>>>>>>>>>>>>> Decoder types");
        // this.context.schemas.forEach((id, schema) => {
        //     console.log("type:", id, schema.name, Object.keys(schema[Symbol.metadata]));
        // });
    }

    protected setState(root: T) {
        this.state = root;
        this.root = new ReferenceTracker();
        this.root.addRef(0, root);
    }

    decode(
        bytes: Uint8Array,
        it: Iterator = { offset: 0 },
        ref: IRef = this.state,
    ) {
        // Only allocate a collection array when there's a subscriber. Every
        // decode-op push site uses `allChanges?.push(...)` — optional
        // chaining short-circuits the object literal too, so a listener-
        // free decoder does zero per-field allocation.
        const allChanges: DataChange[] | null = (this.triggerChanges !== undefined)
            ? []
            : null;

        const $root = this.root;
        const totalBytes = bytes.byteLength;

        let decoder: DecodeOperation = ref['constructor'][$decoder];

        this.currentRefId = 0;

        while (it.offset < totalBytes) {
            //
            // Peek ahead, check if it's a switch to a different structure
            //
            if (bytes[it.offset] == SWITCH_TO_STRUCTURE) {
                it.offset++;

                (ref as any)[$onDecodeEnd]?.()

                const nextRefId = decode.number(bytes, it);
                const nextRef = $root.refs.get(nextRefId);

                //
                // Trying to access a reference that haven't been decoded yet.
                //
                if (!nextRef) {
                    // throw new Error(`"refId" not found: ${nextRefId}`);
                    console.error(`"refId" not found: ${nextRefId}`, { previousRef: ref, previousRefId: this.currentRefId });
                    console.warn("Please report this issue to the developers.");
                    this.skipCurrentStructure(bytes, it, totalBytes);

                } else {
                    ref = nextRef;
                    decoder = ref.constructor[$decoder];
                    this.currentRefId = nextRefId;
                }

                continue;
            }

            const result = decoder(this, bytes, it, ref, allChanges);

            if (result === DEFINITION_MISMATCH) {
                console.warn("@colyseus/schema: definition mismatch");
                this.skipCurrentStructure(bytes, it, totalBytes);
                continue;
            }
        }

        // Close out the last ref's decode session — mirrors the
        // SWITCH_TO_STRUCTURE block above, which fires it at every
        // intra-loop structure transition. ArraySchema uses this to
        // compact `items` after a tick's deletes. No other consumer
        // currently hooks it; the dual call sites stay as-is rather
        // than being extracted into a helper for a one-line body.
        (ref as any)[$onDecodeEnd]?.()

        // resync mode: prune everything the snapshot didn't visit. Runs
        // before triggerChanges (DELETE changes fire onRemove with the real
        // previousValue) and before GC (removeRef feeds deletedRefs).
        if (this.resyncVisited !== null) { resyncSweep(this, allChanges); }

        // trigger changes
        if (allChanges !== null) this.triggerChanges?.(allChanges);

        // drop references of unused schemas
        $root.garbageCollectDeletedRefs();

        return allChanges;
    }

    /**
     * Full-snapshot reconciliation ("resync") decode.
     *
     * Behaves exactly like {@link decode}, plus: every collection entry the
     * payload does NOT mention is removed through the regular DELETE path —
     * `onRemove` callbacks fire with the real previous value and released
     * refs are garbage-collected. Use it to apply a rejoin/reconnect full
     * state over an existing decoded tree: DELETEs that happened while the
     * client was off the wire are reconciled as if they had been received,
     * while surviving entries keep their instance identity and callbacks.
     *
     * ONLY valid for full-snapshot payloads (`encodeAll` / `encodeAllView`
     * output). Calling it on an incremental patch would prune everything
     * the patch doesn't touch.
     */
    decodeResync(bytes: Uint8Array, it: Iterator = { offset: 0 }) {
        this.resyncVisited = new Map();
        this.resyncDamaged = false;
        try {
            return this.decode(bytes, it);
        } finally {
            this.resyncVisited = null;
        }
    }

    skipCurrentStructure(bytes: Uint8Array, it: Iterator, totalBytes: number) {
        // A skipped range can swallow other structures' ops (their ADDs are
        // never applied), so resync visited data is no longer trustworthy.
        if (this.resyncVisited !== null) { this.resyncDamaged = true; }
        //
        // keep skipping next bytes until reaches a known structure
        // by local decoder.
        //
        const nextIterator: Iterator = { offset: it.offset };
        while (it.offset < totalBytes) {
            if (bytes[it.offset] === SWITCH_TO_STRUCTURE) {
                nextIterator.offset = it.offset + 1;
                if (this.root.refs.has(decode.number(bytes, nextIterator))) {
                    break;
                }
            }
            it.offset++;
        }
    }

    getInstanceType(bytes: Uint8Array, it: Iterator, defaultType: typeof Schema): typeof Schema {
        let type: typeof Schema;

        if (bytes[it.offset] === TYPE_ID) {
            it.offset++;
            const type_id = decode.number(bytes, it);
            type = this.context.get(type_id);
        }

        return type || defaultType;
    }

    createInstanceOfType(type: typeof Schema): Schema {
        return type.initializeForDecoder();
    }

    removeChildRefs(ref: Collection, allChanges: DataChange[] | null) {
        const needRemoveRef = typeof ((ref as any)[$childType]) !== "string";
        const refId = (ref as Ref)[$refId];

        ref.forEach((value: any, key: any) => {
            allChanges?.push({
                ref: ref as Ref,
                refId,
                op: OPERATION.DELETE,
                field: key,
                value: undefined,
                previousValue: value
            });

            if (needRemoveRef) {
                this.root.removeRef(value[$refId]);
            }
        });
    }

}
