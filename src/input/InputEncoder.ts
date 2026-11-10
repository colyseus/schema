import { $numFields, $values } from "../types/symbols.js";
import { encode } from "../encoding/encode.js";
import { endChunk, uvarint } from "../encoding/varint.js";
import { OPERATION } from "../encoding/spec.js";
import { Metadata } from "../Metadata.js";
import { fieldOf, getEncodeDescriptor, type EncodeDescriptor } from "../encoder/EncodeDescriptor.js";
import type { Schema } from "../Schema.js";

/**
 * Delivery-channel hint. Controls the wire layout:
 * - `"reliable"`: single input per packet, no framing — bytes are
 *   wire-compatible with the standard {@link Decoder}.
 * - `"unreliable"`: ring buffer of the last `historySize` inputs packed
 *   into one packet, each prefixed with a varint length. Gives the
 *   receiver redundancy against dropped packets. Use
 *   {@link InputDecoder.decodeAll} on the receiving end.
 */
export type InputMode = "reliable" | "unreliable";

export interface InputEncoderOptions {
    /** Defaults to `"reliable"`. */
    mode?: InputMode;

    /**
     * Unreliable-mode only. Number of past inputs to pack into each
     * packet as redundancy against drops. Default: 3. Ignored in
     * reliable mode (always exactly one input per packet).
     */
    historySize?: number;
}

const DEFAULT_SLOT_SIZE = 256;
const LENGTH_PREFIX_WORST_CASE = 5; // varint max for a uint32 length.

// The bound instance is the receiver's root (refId 0): one chunk, first-chunk header `refId*2+1` (see encoding/spec.ts).
const ROOT_CHUNK_HEADER = 1;
// Schema field op: `uvarint(index << 2 | op >>> 6)` (see encoding/spec.ts).
const FIELD_ADD = OPERATION.ADD >>> 6;
const FIELD_DELETE = OPERATION.DELETE >>> 6;

const EMPTY = new Uint8Array(0);
// Receiver state unknown (after `reset()`): present fields ship, absent ones ship a DELETE.
const UNKNOWN = {};

/**
 * Bound single-struct encoder for client→server input packets. Holds a
 * reference to a Schema instance and produces wire-compatible bytes.
 *
 * Always delta-encodes: each `encode()` compares the instance's fields with
 * the values it last encoded and emits only the ones that differ. The first
 * call (or first after {@link reset}) emits a full snapshot, since there's no
 * baseline to diff against. Change tracking on the instance is not used, so
 * it works the same on an untracked or paused instance, and the
 * `@colyseus/schema/input` bundle doesn't depend on the `Encoder`.
 *
 * **Reliable mode** emits one delta per `encode()` — or an empty
 * `Uint8Array` when nothing changed (the caller decides whether to send a
 * body-less keep-alive or skip the tick). The bytes decode cleanly through
 * the standard {@link Decoder}.
 *
 * **Unreliable mode** pushes each delta onto a ring buffer of size
 * `historySize` and emits the last N in one packet, each framed with a
 * varint length prefix. A no-change tick still pushes an (empty,
 * carry-forward) slot so every tick gets a consecutive framework seq. Use
 * {@link InputDecoder.decodeAll} to walk the framed packet. Wire ops use
 * absolute values, so re-applying a redundant slot is per-field idempotent.
 *
 * Flat primitive fields only. Nested Schema / collection fields, and fields
 * marked `.view()`, `.unreliable()` or `.fullStateOnly()`, throw at
 * construction.
 */
export class InputEncoder<T extends Schema = any> {
    readonly instance: T;
    readonly mode: InputMode;
    readonly historySize: number;

    private readonly _desc: EncodeDescriptor;
    /** Indexes of the encoded fields, ascending (the wire order). */
    private readonly _fields: number[];

    // Per-field value the receiver holds after the last encode (`undefined`: absent); `_next` is the pass being written.
    private _sent: any[];
    private _next: any[];

    // Delta scratch; reliable mode returns a view of it.
    private _buffer: Uint8Array = new Uint8Array(DEFAULT_SLOT_SIZE);
    private readonly _it = { offset: 0 };

    // Unreliable-mode ring: `_slots`/`_slotLens` hold each snapshot; `_outBuffer` holds the concatenated packet.
    private _slots?: Uint8Array[];
    private readonly _slotLens?: number[];
    private _slotHead: number = 0;
    private _slotCount: number = 0;
    private _outBuffer?: Uint8Array;
    // Monotonic per-tick input seq (unreliable only): ++ per pushed slot. The
    // packet carries the OLDEST slot's seq once; the decoder derives each slot's
    // seq by position (slots are consecutive — every tick pushes). This is the
    // framework-owned seq that drives server-side dedupe of the redundancy ring
    // WITHOUT the user adding a seq field. Monotonic across reset() so a
    // reconnect that reuses the server buffer doesn't replay already-seen seqs.
    private _seq: number = 0;

    constructor(instance: T, options: InputEncoderOptions = {}) {
        this.instance = instance;
        this.mode = options.mode ?? "reliable";
        this.historySize = this.mode === "unreliable"
            ? Math.max(1, options.historySize ?? 3)
            : 1;

        // Resolve + validate schema metadata up front.
        const desc = this._desc = getEncodeDescriptor(instance);
        const metadata = desc.metadata;
        const numFields = metadata?.[$numFields];
        if (numFields === undefined) {
            throw new Error(`InputEncoder: '${instance.constructor.name}' has no fields`);
        }
        this._fields = [];
        for (let i = 0; i <= numFields; i++) {
            const name = desc.names[i];
            if (name === undefined) continue;
            if (desc.encoders[i] === undefined) {
                throw new Error(
                    `InputEncoder: non-primitive field '${name}' on '${instance.constructor.name}' is not supported. Use Encoder for state containing refs/collections.`
                );
            }
            // a blocklist: a new channel-routing modifier must be added here
            const modifier = Metadata.hasViewTagAtIndex(metadata, i) ? "view"
                : Metadata.hasUnreliableAtIndex(metadata, i) ? "unreliable"
                : Metadata.hasFullStateOnlyAtIndex(metadata, i) ? "fullStateOnly"
                : undefined;
            if (modifier !== undefined) {
                throw new Error(
                    `InputEncoder: field '${name}' on '${instance.constructor.name}' is marked .${modifier}(), which inputs don't support. Choose the channel with the \`mode\` option instead.`
                );
            }
            this._fields.push(i);
        }
        this._sent = desc.valuesTemplate.slice();
        this._next = desc.valuesTemplate.slice();

        if (this.mode === "unreliable") {
            this._slots = new Array(this.historySize);
            this._slotLens = new Array(this.historySize).fill(0);
            for (let i = 0; i < this.historySize; i++) {
                this._slots[i] = new Uint8Array(DEFAULT_SLOT_SIZE);
            }
            this._outBuffer = new Uint8Array(
                (DEFAULT_SLOT_SIZE + LENGTH_PREFIX_WORST_CASE) * this.historySize,
            );
        }
    }

    /**
     * The framework input seq of the most recently encoded tick (unreliable
     * mode): monotonic, ++ per `encode()`, kept across {@link reset}. `0` in
     * reliable mode (which sequences inputs implicitly by message count). The
     * client keys its reconciliation replay ring by this so the server's
     * seq-value ack lines up across packet loss.
     */
    get seq(): number { return this._seq; }

    /**
     * Encode the bound instance's delta. Returns a subarray of an internal
     * buffer — copy if retaining across calls.
     *
     * Output shape by mode:
     * - `reliable`: only changed fields, or empty when nothing changed.
     * - `unreliable`: ring of the last `historySize` deltas, length-framed
     *   per slot. A no-change tick pushes an empty (carry-forward) slot but
     *   still re-emits the ring. Empty only until the first slot is pushed.
     *
     * Buffers auto-grow on overflow; a one-time `console.warn` is
     * emitted the first time it happens.
     */
    encode(): Uint8Array {
        const len = this._produceDelta();
        if (this.mode === "unreliable") return this._pushAndEmitRing(len);
        return (len === 0) ? EMPTY : this._buffer.subarray(0, len);
    }

    /**
     * Reset the encoder's internal state:
     * - Drops the unreliable ring buffer.
     * - Forgets what the receiver holds, so the next `encode()` emits every
     *   populated field, plus a DELETE for each empty one (the receiver may
     *   still hold a value from before the reset).
     *
     * Useful on disconnect / reconnect / scene transitions.
     */
    reset(): void {
        this._slotHead = 0;
        this._slotCount = 0;
        this._sent.fill(UNKNOWN);
    }

    /**
     * Copy the bound instance's field values into `target` (a same-type instance)
     * in place — no allocation, no `Object.keys` (cf. `Schema#assign`) and no
     * `clone()`. For buffering a snapshot of the just-sent input into a reused
     * slot (e.g. a client reconciliation/replay ring) without the transport
     * having to reach into schema internals. The codec owns this because it owns
     * the field representation. The in-place / alloc-free cousin of `clone()`,
     * and the inverse direction of `Schema#assign(source)`.
     */
    copyInto(target: T): void {
        const src = (this.instance as any)[$values];
        const dst = (target as any)[$values];
        for (let i = 0, n = this._desc.numFields; i <= n; i++) dst[i] = src[i];
    }

    // ────────────────────────────────────────────────────────────────────
    // Delta producer — one diff of the instance; caller routes by mode.
    // ────────────────────────────────────────────────────────────────────

    /** Writes the delta into `_buffer`, growing it as needed; returns its byte length (0: nothing changed). */
    private _produceDelta(): number {
        let len = this._writeDelta(this._buffer);
        while (len < 0) {
            // `_it.offset` ran past the end by the bytes that didn't fit; nothing was committed
            this._buffer = InputEncoder._grow(this._buffer, this._it.offset, "delta buffer");
            len = this._writeDelta(this._buffer);
        }
        return len;
    }

    /**
     * One chunk with an op per field that differs from `_sent`, in index
     * order; returns its byte length (0: nothing changed). `-1` when `buffer`
     * is too small; the baseline only moves once the chunk fits.
     */
    private _writeDelta(buffer: Uint8Array): number {
        const desc = this._desc;
        const ref: any = this.instance;
        const values = ref[$values];
        const fields = this._fields;
        const encoders = desc.encoders;
        const sent = this._sent;
        const next = this._next;
        const it = this._it;

        it.offset = 0;
        buffer[it.offset++] = ROOT_CHUNK_HEADER;
        const lenPos = it.offset++;

        for (let k = 0; k < fields.length; k++) {
            const index = fields[k];
            let value = fieldOf(desc, ref, values, index);
            if (value === null) value = undefined; // null clears the field, like the setter
            next[index] = value;

            const previous = sent[index];
            if (value === previous || (value !== value && previous !== previous)) continue; // NaN → NaN: unchanged
            if (value === undefined) {
                uvarint(buffer, (index << 2) | FIELD_DELETE, it);
            } else {
                uvarint(buffer, (index << 2) | FIELD_ADD, it);
                encoders[index]!(buffer, value, it);
            }
        }

        if (it.offset === lenPos + 1) return 0;
        endChunk(buffer, lenPos, it, buffer.byteLength);
        if (it.offset > buffer.byteLength) return -1;

        this._sent = next;
        this._next = sent;
        return it.offset;
    }

    // ────────────────────────────────────────────────────────────────────
    // Ring — push blob to current slot, concat oldest→newest, return framed packet.
    // ────────────────────────────────────────────────────────────────────

    /** Push the `len`-byte delta in `_buffer` as the newest slot. */
    private _pushAndEmitRing(len: number): Uint8Array {
        // Push a slot EVERY tick (even an empty delta) so ring seqs stay
        // consecutive: the packet carries ONE base seq and the decoder derives
        // each slot's seq by position. An empty slot decodes as carry-forward.
        this._seq++;
        let slot = this._slots![this._slotHead];
        if (len > slot.byteLength) {
            slot = this._slots![this._slotHead] = InputEncoder._grow(
                slot, len, "unreliable ring slot",
            );
        }
        const delta = this._buffer;
        for (let b = 0; b < len; b++) slot[b] = delta[b]; // a few bytes: a loop beats subarray() + set()
        this._slotLens![this._slotHead] = len;
        this._slotHead = (this._slotHead + 1) % this.historySize;
        if (this._slotCount < this.historySize) this._slotCount++;

        return this._emitRing();
    }

    private _emitRing(): Uint8Array {
        // Packet layout: [baseSeq][len][slot]…[len][slot] (oldest→newest).
        // baseSeq = the oldest slot's seq; consecutive slots ⇒ slot i has seq baseSeq + i.
        const baseSeq = this._seq - this._slotCount + 1;

        // Upper bound: baseSeq varint + sum of slot byte counts + per-slot varint length.
        let needed = LENGTH_PREFIX_WORST_CASE;
        for (let i = 0; i < this._slotCount; i++) {
            needed += this._slotLens![i] + LENGTH_PREFIX_WORST_CASE;
        }

        let out = this._outBuffer!;
        if (needed > out.byteLength) {
            out = this._outBuffer = InputEncoder._grow(out, needed, "unreliable output packet");
        }

        const outIt = { offset: 0 };
        encode.number(out, baseSeq, outIt);   // packet-level base seq
        const oldest = (this._slotHead - this._slotCount + this.historySize) % this.historySize;
        for (let i = 0; i < this._slotCount; i++) {
            const idx = (oldest + i) % this.historySize;
            const len = this._slotLens![idx];
            encode.number(out, len, outIt);
            const slot = this._slots![idx];
            let o = outIt.offset;
            for (let b = 0; b < len; b++) out[o++] = slot[b];
            outIt.offset = o;
        }
        return out.subarray(0, outIt.offset);
    }

    // ────────────────────────────────────────────────────────────────────
    // Buffer growth. Writes past `byteLength` silently drop but `it.offset` still advances, so callers detect overflow via `offset > byteLength` and re-encode into the grown buffer.
    // ────────────────────────────────────────────────────────────────────

    private static _warned = false;
    private static _grow(buf: Uint8Array, needed: number, where: string): Uint8Array {
        const newSize = Math.max(needed, buf.byteLength * 2);
        if (!InputEncoder._warned) {
            InputEncoder._warned = true;
            console.warn(
                `@colyseus/schema/input: InputEncoder buffer overflow in ${where}. ` +
                `Growing to ${newSize} bytes.`
            );
        }
        return new Uint8Array(newSize);
    }
}
