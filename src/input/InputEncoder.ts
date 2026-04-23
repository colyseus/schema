import { OPERATION } from "../encoding/spec.js";
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

    /**
     * When `true`, `encode()` emits only fields that changed since the
     * previous call. First call (or first after `reset()`) still emits
     * a full snapshot since there's no baseline to diff against.
     *
     * **Reliable mode:** returns an empty `Uint8Array` when nothing
     * changed — caller can skip sending.
     *
     * **Unreliable mode:** no-change ticks don't push a new ring slot
     * (avoids bloating the ring with empties); the existing ring is
     * still re-emitted for redundancy. Wire ops use absolute values so
     * cross-packet re-application is per-field idempotent.
     *
     * Decoder side is unchanged in either case: `(index|ADD)` wire ops
     * apply to the bound instance; fields absent from a packet stay at
     * their previously decoded value.
     */
    delta?: boolean;

    /**
     * Override the reliable-mode output buffer. Default: 256 bytes,
     * auto-grown on overflow.
     */
    buffer?: Uint8Array;
}

const DEFAULT_SLOT_SIZE = 256;
const LENGTH_PREFIX_WORST_CASE = 5; // varint max for a uint32 length.

/**
 * Bound single-struct encoder for client→server input packets. Holds a
 * reference to a Schema instance and produces wire-compatible bytes.
 *
 * **Reliable mode** emits one snapshot per `encode()`. The bytes decode
 * cleanly through the standard {@link Decoder}.
 *
 * **Unreliable mode** pushes each snapshot onto a ring buffer of size
 * `historySize` and emits the last N snapshots in one packet, each
 * framed with a varint length prefix. Use {@link InputDecoder.decodeAll}
 * to walk the framed packet on the receiving end.
 *
 * **Delta** (`delta: true`, any mode) wraps a standard {@link Encoder}
 * and emits only fields that changed since the last call, via the
 * setter-populated ChangeTree dirty set.
 *
 * Flat primitive fields only. Nested Schema / collection fields throw
 * at construction.
 */
export class InputEncoder<T extends Schema = any> {
    readonly instance: T;
    readonly mode: InputMode;
    readonly historySize: number;
    readonly delta: boolean;

    private readonly _desc: EncodeDescriptor;
    private readonly _numFields: number;

    // Reliable-mode output + its iterator. Auto-grown on overflow, so
    // not `readonly` — `_encodeFull()` may swap in a larger buffer.
    private _buffer: Uint8Array;
    private readonly _it = { offset: 0 };

    // Unreliable-mode ring state. `_outBuffer` is where the concatenated
    // packet lives; `_slots` / `_slotLens` hold each snapshot's bytes.
    private _slots?: Uint8Array[];
    private readonly _slotLens?: number[];
    private _slotHead: number = 0;
    private _slotCount: number = 0;
    private _outBuffer?: Uint8Array;

    // Delta-mode delegate. Setter `$track` calls populate its
    // ChangeTree; `encode()` drains dirty fields into its buffer.
    private readonly _encoder?: Encoder<T>;

    constructor(instance: T, options: InputEncoderOptions = {}) {
        this.instance = instance;
        this.mode = options.mode ?? "reliable";
        this.delta = options.delta ?? false;
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

        this._buffer = options.buffer ?? new Uint8Array(DEFAULT_SLOT_SIZE);

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

        if (this.delta) {
            // Delegate to the standard Encoder — it attaches a Root and
            // drains the setter-populated dirty set on each encode().
            // Tracking stays enabled so setters keep populating it.
            this._encoder = new Encoder<T>(instance);
        } else {
            // Full mode reads `$values` directly; setter-side tracking
            // is pure overhead, so pause it.
            instance.pauseTracking();
        }
    }

    /**
     * Encode the bound instance. Returns a subarray of an internal
     * buffer — copy if retaining across calls.
     *
     * Output shape by configuration:
     * - `reliable` + full: one snapshot's worth of bytes.
     * - `reliable` + delta: only changed fields, or empty when nothing
     *   changed.
     * - `unreliable` + full: ring of last `historySize` snapshots,
     *   length-framed per slot.
     * - `unreliable` + delta: ring of last `historySize` deltas. No-
     *   change ticks don't push a new slot but still re-emit the ring.
     *   Empty only until the first change has been pushed.
     *
     * Buffers auto-grow on overflow; a one-time `console.warn` is
     * emitted the first time it happens.
     */
    encode(): Uint8Array {
        const blob = this.delta ? this._produceDelta() : this._produceFull();
        return this.mode === "reliable" ? blob : this._pushAndEmitRing(blob);
    }

    /**
     * Reset the encoder's internal state:
     * - Unreliable mode: drops the ring buffer.
     * - Delta mode: re-marks every currently populated field as dirty,
     *   so the next `encode()` emits a fresh full snapshot.
     *
     * Useful on disconnect / reconnect / scene transitions.
     */
    reset(): void {
        this._slotHead = 0;
        this._slotCount = 0;
        if (this.delta) {
            this._encoder!.discardChanges();
            const tree = (this.instance as any)[$changes];
            const values = (this.instance as any)[$values];
            for (let i = 0; i <= this._numFields; i++) {
                if (values[i] === undefined || values[i] === null) continue;
                tree.markDirty(i);
            }
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Blob producers — return a single snapshot (or delta) of the
    // current instance. Caller routes by mode.
    // ────────────────────────────────────────────────────────────────────

    /** Write every populated primitive field into `_buffer`. */
    private _produceFull(): Uint8Array {
        let buf = this._buffer;
        const it = this._it;
        this._writeFields(buf, it);
        if (it.offset > buf.byteLength) {
            buf = this._buffer = InputEncoder._grow(buf, it.offset, "reliable encode");
            this._writeFields(buf, it);
        }
        return buf.subarray(0, it.offset);
    }

    /** Delegate to the wrapped Encoder, then clear its dirty set. */
    private _produceDelta(): Uint8Array {
        const bytes = this._encoder!.encode();
        this._encoder!.discardChanges();
        return bytes;
    }

    /** Emit every populated field as `(index|ADD)` + value. */
    private _writeFields(buf: Uint8Array, it: { offset: number }): void {
        const values = (this.instance as any)[$values];
        const encoders = this._desc.encoders;
        it.offset = 0;
        for (let i = 0; i <= this._numFields; i++) {
            const value = values[i];
            if (value === undefined || value === null) continue;
            buf[it.offset++] = (i | OPERATION.ADD) & 255;
            (encoders[i] as (b: Uint8Array, v: any, it: any) => void)(buf, value, it);
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Ring — push blob to the current slot, concat (oldest → newest)
    // into the output buffer, return the framed packet.
    // ────────────────────────────────────────────────────────────────────

    private _pushAndEmitRing(blob: Uint8Array): Uint8Array {
        // Empty blob = no-change delta tick. Skip the push but re-emit
        // the existing ring (redundancy). Empty ring → empty output.
        if (blob.length === 0) {
            if (this._slotCount === 0) return this._outBuffer!.subarray(0, 0);
            return this._emitRing();
        }

        // Copy blob into the current slot, growing it if needed.
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
        // Upper bound: sum of slot byte counts + per-slot varint length.
        let needed = 0;
        for (let i = 0; i < this._slotCount; i++) {
            needed += this._slotLens![i] + LENGTH_PREFIX_WORST_CASE;
        }

        let out = this._outBuffer!;
        if (needed > out.byteLength) {
            out = this._outBuffer = InputEncoder._grow(out, needed, "unreliable output packet");
        }

        const outIt = { offset: 0 };
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
    // Buffer growth. Uint8Array writes past `byteLength` silently drop
    // but `it.offset` still advances — callers detect overflow via the
    // `offset > byteLength` check and re-encode into the grown buffer.
    // ────────────────────────────────────────────────────────────────────

    private static _warned = false;
    private static _grow(buf: Uint8Array, needed: number, where: string): Uint8Array {
        const newSize = Math.max(needed, buf.byteLength * 2);
        if (!InputEncoder._warned) {
            InputEncoder._warned = true;
            console.warn(
                `@colyseus/schema/input: InputEncoder buffer overflow in ${where}. ` +
                `Growing to ${newSize} bytes. Pass a larger { buffer } option to avoid this at runtime.`
            );
        }
        return new Uint8Array(newSize);
    }
}
