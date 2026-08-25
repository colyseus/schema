import { $numFields, $values, $changes } from "../types/symbols.js";
import { encode } from "../encoding/encode.js";
import { Encoder } from "../encoder/Encoder.js";
import { getEncodeDescriptor, type EncodeDescriptor } from "../encoder/EncodeDescriptor.js";
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

/**
 * Bound single-struct encoder for client→server input packets. Holds a
 * reference to a Schema instance and produces wire-compatible bytes.
 *
 * Always delta-encodes: each `encode()` emits only the fields that changed
 * since the previous call (via the setter-populated ChangeTree dirty set),
 * wrapping a standard {@link Encoder}. The first call (or first after
 * {@link reset}) emits a full snapshot, since there's no baseline to diff
 * against.
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
 * Flat primitive fields only. Nested Schema / collection fields throw
 * at construction.
 */
export class InputEncoder<T extends Schema = any> {
    readonly instance: T;
    readonly mode: InputMode;
    readonly historySize: number;

    private readonly _desc: EncodeDescriptor;
    private readonly _numFields: number;

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

    // Delta delegate; setters populate its ChangeTree, `encode()` drains dirty fields.
    private readonly _encoder: Encoder<T>;

    constructor(instance: T, options: InputEncoderOptions = {}) {
        this.instance = instance;
        this.mode = options.mode ?? "reliable";
        this.historySize = this.mode === "unreliable"
            ? Math.max(1, options.historySize ?? 3)
            : 1;

        // Resolve + validate schema metadata up front.
        this._desc = getEncodeDescriptor(instance);
        const numFields = this._desc.metadata?.[$numFields];
        if (numFields === undefined) {
            throw new Error(`InputEncoder: '${instance.constructor.name}' has no fields`);
        }
        this._numFields = numFields;
        for (let i = 0; i <= numFields; i++) {
            if (this._desc.names[i] !== undefined && this._desc.encoders[i] === undefined) {
                throw new Error(
                    `InputEncoder: non-primitive field '${this._desc.names[i]}' on '${instance.constructor.name}' is not supported. Use Encoder for state containing refs/collections.`
                );
            }
        }

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

        // Wrap a standard Encoder; keep tracking on so setters keep populating
        // the dirty set we drain each encode().
        this._encoder = new Encoder<T>(instance);
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
        const blob = this._produceDelta();
        return this.mode === "reliable" ? blob : this._pushAndEmitRing(blob);
    }

    /**
     * Reset the encoder's internal state:
     * - Drops the unreliable ring buffer.
     * - Re-marks every currently populated field as dirty, so the next
     *   `encode()` emits a fresh full snapshot.
     *
     * Useful on disconnect / reconnect / scene transitions.
     */
    reset(): void {
        this._slotHead = 0;
        this._slotCount = 0;
        this._encoder.discardChanges();
        const tree = this.instance[$changes];
        const values = this.instance[$values];
        for (let i = 0; i <= this._numFields; i++) {
            if (values[i] === undefined || values[i] === null) continue;
            tree.markDirty(i);
        }
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
        for (let i = 0; i <= this._numFields; i++) dst[i] = src[i];
    }

    // ────────────────────────────────────────────────────────────────────
    // Delta producer — one diff of the instance; caller routes by mode.
    // ────────────────────────────────────────────────────────────────────

    /** Delegate to the wrapped Encoder, then clear its dirty set. */
    private _produceDelta(): Uint8Array {
        const bytes = this._encoder.encode();
        this._encoder.discardChanges();
        return bytes;
    }

    // ────────────────────────────────────────────────────────────────────
    // Ring — push blob to current slot, concat oldest→newest, return framed packet.
    // ────────────────────────────────────────────────────────────────────

    private _pushAndEmitRing(blob: Uint8Array): Uint8Array {
        // Push a slot EVERY tick (even an empty delta) so ring seqs stay
        // consecutive: the packet carries ONE base seq and the decoder derives
        // each slot's seq by position. An empty slot decodes as carry-forward.
        this._seq++;
        let slot = this._slots![this._slotHead];
        if (blob.length > slot.byteLength) {
            slot = this._slots![this._slotHead] = InputEncoder._grow(
                slot, blob.length, "unreliable ring slot",
            );
        }
        slot.set(blob);
        this._slotLens![this._slotHead] = blob.length;
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
            out.set(this._slots![idx].subarray(0, len), outIt.offset);
            outIt.offset += len;
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
