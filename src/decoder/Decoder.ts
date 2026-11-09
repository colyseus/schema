import { TypeContext } from "../types/TypeContext.js";
import { $childType, $listenedOnly } from "../types/symbols.js";
import { Schema } from "../Schema.js";
import { KIND_ARRAY, KIND_MAP, KIND_SCHEMA, OPERATION } from "../encoding/spec.js";
import { type IRef, type Ref, decodedRefIdOf, treeOfDecoded } from "../encoder/ChangeTree.js";
import type { Iterator } from "../encoding/decode.js";
import { readUvarint } from "../encoding/varint.js";
import { ReferenceTracker } from "./ReferenceTracker.js";
import { ChunkMismatch, decodeArrayOps, decodeKeyValueOps, decodeSchemaOps, decodeRun, refInfoOf, type DataChange, type RefInfo } from "./DecodeOperation.js";
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

    /**
     * Receives each decode's changes. A consumer marked `$listenedOnly` (the
     * callbacks strategies' dispatchers) gets only the changes of refs that
     * have callbacks or were built during that decode — see `changesFor`.
     * Any other function, including a wrapper around a marked one, gets
     * every change.
     */
    triggerChanges?: (changes: DataChange[]) => void;

    /** @internal The changes `decode()` collects (`null`: no `triggerChanges` consumer). */
    batch: DataChange[] | null = null;

    /** @internal `batch` skips unlistened refs (`triggerChanges` is marked `$listenedOnly`). */
    gated: boolean = false;

    /** @internal Bumped per `decode()`; stamped on the trees of the refs it builds (`decodeGen`). */
    decodeGen: number = 0;

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
        // No consumer, no batch: every push site is `changes?.push(...)`, and
        // optional chaining skips the object literal too.
        const consumer: any = this.triggerChanges;
        const batch: DataChange[] | null = (consumer !== undefined) ? [] : null;
        this.batch = batch;
        this.gated = batch !== null && consumer[$listenedOnly] === true;
        this.decodeGen++;

        if (Array.isArray(bytes)) {
            for (let i = 0; i < bytes.length; i++) {
                this.decodeChunks(bytes[i], { offset: 0 });
            }
        } else {
            this.decodeChunks(bytes, it);
        }

        // resync mode: prune everything the snapshot didn't visit. Runs
        // before triggerChanges (DELETE changes fire onRemove with the real
        // previousValue) and before GC (removeRef feeds deletedRefs).
        if (this.resyncVisited !== null) resyncSweep(this, batch);
        this.batch = null;
        if (batch !== null) this.triggerChanges?.(batch);
        this.root.garbageCollectDeletedRefs();
        return batch;
    }

    /**
     * @internal Where a gated batch records the changes of ref `refId`: built
     * during this decode (`decodeGen`, its tree's stamp; callbacks registered
     * while the batch dispatches can still pick them up) or has callbacks.
     * Callers test `gated` first, once per pass.
     */
    changesFor(refId: number, decodeGen: number): DataChange[] | null {
        return (decodeGen === this.decodeGen || this.root.callbacks.get(refId) !== undefined) ? this.batch : null;
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

    private decodeChunks(bytes: Uint8Array, it: Iterator): void {
        const total = bytes.byteLength;
        const $root = this.root;

        // chunk header: `refId*2+1` (absolute, first chunk of a slice) or
        // `zigzag(refId - prevRefId)*2` (delta from the previous chunk)
        let prevRefId = -1;
        const batch = this.batch;
        const gated = this.gated;
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
                    prevRefId = decodeRun(this, bytes, it, end, refId);
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
                const tree: any = treeOfDecoded(ref); // one load serves the decode record and a Schema's `values`
                const ri: RefInfo = (tree.decodeInfo !== undefined) ? tree.decodeInfo : refInfoOf(ref);
                const kind = ri.kind;
                const changes = gated ? this.changesFor(refId, tree.decodeGen) : batch;
                if (kind === KIND_SCHEMA) decodeSchemaOps(this, bytes, it, end, ref, refId, changes, ri.info!, tree.values);
                else if (kind === KIND_ARRAY) decodeArrayOps(this, bytes, it, end, ref, refId, changes, ri);
                else decodeKeyValueOps(this, bytes, it, end, ref, refId, changes, kind === KIND_MAP, ri);
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

    removeChildRefs(ref: Collection, changes: DataChange[] | null) {
        const needRemoveRef = typeof ((ref as any)[$childType]) !== "string";
        const refId = decodedRefIdOf(ref);

        ref.forEach((value: any, key: any) => {
            changes?.push({
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
