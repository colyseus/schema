import { TypeContext } from "../types/TypeContext.js";
import { $childType } from "../types/symbols.js";
import { Schema } from "../Schema.js";
import { CollectionKind, OPERATION } from "../encoding/spec.js";
import { type IRef, type Ref, decodedRefIdOf } from "../encoder/ChangeTree.js";
import type { Iterator } from "../encoding/decode.js";
import { readUvarint } from "../encoding/varint.js";
import { ReferenceTracker } from "./ReferenceTracker.js";
import { ChunkMismatch, decodeArrayOps, decodeKeyValueOps, decodeSchemaOps, decodeRun, refInfoOf, REF_SCHEMA, REF_ARRAY, REF_MAP, type DataChange } from "./DecodeOperation.js";
import { resyncSweep } from "./Resync.js";
import { Collection } from "../types/HelperTypes.js";

/**
 * Wire-format decoder: length-prefixed chunks (exact skip of unknown refIds)
 * with inline bodies. `decode()` accepts a single buffer or the
 * `[shared, view]` pair returned by `Encoder.encodeView` — decoded as ONE
 * session (callbacks + GC once).
 */
export class Decoder<T extends IRef = any> {
    context: TypeContext;

    state: T;
    root: ReferenceTracker;

    currentRefId: number = 0;

    triggerChanges?: (allChanges: DataChange[]) => void;

    /**
     * @internal Non-null only while a `decodeResync()` walk is in progress:
     * collection refId → entry identities the payload visited (map string
     * keys; array/set/collection/stream indexes; `-1 - refId` for array
     * elements delivered by identity). Written by the collection decode
     * functions, read by the post-decode sweep.
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
    }

    protected setState(root: T) {
        this.state = root;
        this.root = new ReferenceTracker();
        this.root.addRef(0, root);
    }

    decode(bytes: Uint8Array | Uint8Array[], it: Iterator = { offset: 0 }): DataChange[] | null {
        // Only allocate a collection array when there's a subscriber. Every
        // decode-op push site uses `allChanges?.push(...)` — optional
        // chaining short-circuits the object literal too, so a listener-
        // free decoder does zero per-field allocation.
        const allChanges: DataChange[] | null = (this.triggerChanges !== undefined) ? [] : null;

        if (Array.isArray(bytes)) {
            for (let i = 0; i < bytes.length; i++) {
                this.decodeChunks(bytes[i], { offset: 0 }, allChanges);
            }
        } else {
            this.decodeChunks(bytes, it, allChanges);
        }

        // resync mode: prune everything the snapshot didn't visit. Runs
        // before triggerChanges (DELETE changes fire onRemove with the real
        // previousValue) and before GC (removeRef feeds deletedRefs).
        if (this.resyncVisited !== null) resyncSweep(this, allChanges);
        if (allChanges !== null) this.triggerChanges?.(allChanges);
        this.root.garbageCollectDeletedRefs();
        return allChanges;
    }

    /**
     * Full-snapshot reconciliation ("resync") decode.
     *
     * Behaves exactly like {@link decode}, plus: every collection entry the
     * payload does NOT mention is removed through the regular DELETE path —
     * `onRemove` callbacks fire with the real previous value and released
     * refs are garbage-collected. Use it to apply a rejoin/reconnect full
     * state over an existing decoded tree.
     *
     * ONLY valid for full-snapshot payloads (`encodeAll` / `encodeAllView`
     * output). Calling it on an incremental patch would prune everything
     * the patch doesn't touch.
     */
    decodeResync(bytes: Uint8Array | Uint8Array[], it: Iterator = { offset: 0 }): DataChange[] | null {
        this.resyncVisited = new Map();
        this.resyncDamaged = false;
        try {
            return this.decode(bytes, it);
        } finally {
            this.resyncVisited = null;
        }
    }

    private decodeChunks(bytes: Uint8Array, it: Iterator, allChanges: DataChange[] | null): void {
        const total = bytes.byteLength;
        const $root = this.root;

        // chunk header: `refId*2+1` (absolute, first chunk of a slice) or
        // `zigzag(refId - prevRefId)*2` (delta from the previous chunk)
        let prevRefId = -1;
        while (it.offset < total) {
            // (bit ops: refIds stay far below 2^29, so both header forms and the
            // length prefix fit 31 bits; see `refIdOf`)
            const h = readUvarint(bytes, it);
            let refId: number;
            if ((h & 1) === 1) {
                refId = h >>> 1;
            } else {
                const z = h >>> 1;
                refId = prevRefId + (((z & 1) === 1) ? -((z + 1) >>> 1) : (z >>> 1));
            }
            prevRefId = refId;
            // length prefix `byteLen*2 + flag`: flag 1 = same-shape run
            const l = readUvarint(bytes, it);
            const isRun = (l & 1) === 1;
            const len = l >>> 1;
            const end = it.offset + len;

            if (end > total) {
                this.damaged(`truncated chunk for refId ${refId} (${len} bytes declared, ${total - it.offset} available)`);
                it.offset = total;
                break;
            }

            if (isRun) {
                try {
                    prevRefId = decodeRun(this, bytes, it, end, refId, allChanges);
                } catch (e) {
                    if (!(e instanceof ChunkMismatch)) throw e;
                    this.damaged("definition mismatch");
                    it.offset = end;
                }
                if (it.offset !== end) {
                    this.damaged(`run desync at refId ${refId} (${it.offset - end} bytes)`);
                    it.offset = end;
                }
                continue;
            }

            const ref = $root.getRef(refId);
            if (ref === undefined) {
                console.error(`"refId" not found: ${refId}`, { previousRefId: this.currentRefId });
                this.resyncDamaged = true;
                it.offset = end; // exact skip
                continue;
            }

            this.currentRefId = refId;
            try {
                const ri = refInfoOf(ref);
                const kind = ri.kind;
                if (kind === REF_SCHEMA) decodeSchemaOps(this, bytes, it, end, ref, refId, allChanges, ri);
                else if (kind === REF_ARRAY) decodeArrayOps(this, bytes, it, end, ref, refId, allChanges, ri);
                else decodeKeyValueOps(this, bytes, it, end, ref, refId, allChanges, kind === REF_MAP, ri);
            } catch (e) {
                if (!(e instanceof ChunkMismatch)) throw e;
                this.damaged("definition mismatch");
                it.offset = end;
            }

            if (it.offset !== end) {
                this.damaged(`chunk desync on refId ${refId} (${it.offset - end} bytes)`);
                it.offset = end;
            }
        }
    }

    /** Warn and, when resyncing, veto the sweep (`resyncDamaged` is only read under `resyncVisited !== null`). */
    private damaged(message: string): void {
        console.warn(`@colyseus/schema: ${message}`);
        this.resyncDamaged = true;
    }

    createInstanceOfType(type: typeof Schema): Schema {
        return type.initializeForDecoder();
    }

    removeChildRefs(ref: Collection, allChanges: DataChange[] | null) {
        const needRemoveRef = typeof ((ref as any)[$childType]) !== "string";
        const refId = decodedRefIdOf(ref);

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
                this.root.removeRef(decodedRefIdOf(value));
            }
        });
    }

}
