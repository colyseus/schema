import { Decoder } from "../decoder/Decoder.js";
import { resyncSweep } from "../decoder/Resync.js";
import { CollectionKind, type DataChange } from "../decoder/DecodeOperation.js";
import type { IRef } from "../encoder/ChangeTree.js";
import type { Iterator } from "../encoding/decode.js";
import { $onDecodeEnd } from "../types/symbols.js";
import { ChunkMismatch, decodeArrayOps6, decodeKeyValueOps6, decodeSchemaOps6 } from "./DecodeOperation6.js";
import { readUvarint } from "./encoding.js";

/**
 * v6 wire-format decoder (PoC). Extends `Decoder` so the `Callbacks`
 * strategy, `ReferenceTracker` and the resync sweep work unchanged; only the
 * byte loop differs: length-prefixed chunks (exact skip of unknown refIds)
 * and inline bodies.
 *
 * `decode()` accepts a single buffer or the `[shared, view]` pair returned
 * by `Encoder6.encodeView` — decoded as ONE session (callbacks + GC once).
 */
export class Decoder6<T extends IRef = any> extends Decoder<T> {
    decode(bytes: Uint8Array | Uint8Array[], it: Iterator = { offset: 0 }, _ref?: IRef): DataChange[] | null {
        const allChanges: DataChange[] | null = (this.triggerChanges !== undefined) ? [] : null;

        if (Array.isArray(bytes)) {
            for (let i = 0; i < bytes.length; i++) {
                this.decodeChunks(bytes[i], { offset: 0 }, allChanges);
            }
        } else {
            this.decodeChunks(bytes, it, allChanges);
        }

        if (this.resyncVisited !== null) resyncSweep(this, allChanges);
        if (allChanges !== null) this.triggerChanges?.(allChanges);
        this.root.garbageCollectDeletedRefs();
        return allChanges;
    }

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

        while (it.offset < total) {
            const refId = readUvarint(bytes, it);
            const len = readUvarint(bytes, it);
            const end = it.offset + len;

            if (end > total) {
                this.damaged(`truncated chunk for refId ${refId} (${len} bytes declared, ${total - it.offset} available)`);
                it.offset = total;
                break;
            }

            const ref = $root.refs.get(refId);
            if (ref === undefined) {
                console.error(`"refId" not found: ${refId}`, { previousRefId: this.currentRefId });
                this.resyncDamaged = true;
                it.offset = end; // exact skip
                continue;
            }

            this.currentRefId = refId;
            try {
                const kind = (ref.constructor as any).COLLECTION_KIND;
                if (kind === undefined) decodeSchemaOps6(this, bytes, it, end, ref, refId, allChanges);
                else if (kind === CollectionKind.Array) decodeArrayOps6(this, bytes, it, end, ref, refId, allChanges);
                else decodeKeyValueOps6(this, bytes, it, end, ref, refId, allChanges, kind === CollectionKind.Map);
            } catch (e) {
                if (!(e instanceof ChunkMismatch)) throw e;
                this.damaged("definition mismatch");
                it.offset = end;
            }

            if (it.offset !== end) {
                this.damaged(`chunk desync on refId ${refId} (${it.offset - end} bytes)`);
                it.offset = end;
            }

            (ref as any)[$onDecodeEnd]?.();
        }
    }

    /** Warn and, when resyncing, veto the sweep (`resyncDamaged` is only read under `resyncVisited !== null`). */
    private damaged(message: string): void {
        console.warn(`@colyseus/schema: ${message}`);
        this.resyncDamaged = true;
    }
}
