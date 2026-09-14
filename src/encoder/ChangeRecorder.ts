import { OPERATION } from "../encoding/spec.js";

/**
 * SchemaChangeRecorder — "what changed this tick" for the UNRELIABLE channel
 * of a Schema instance (lazy, opt-in via `@unreliable`). The reliable channel
 * is inlined on `ChangeTree` for perf; collections record on their own
 * recorder (`ArrayLog` / `KeyedRecorder`) and never carry an unreliable one.
 *
 * Per-field filter/visibility is decided at encode time, not record time.
 */
export interface ChangeRecorder {
    record(index: number, op: OPERATION): void;
    recordDelete(index: number, op: OPERATION): void;
    operationAt(index: number): OPERATION | undefined;
    forEach(cb: (index: number, op: OPERATION) => void): void;
    forEachWithCtx<T>(ctx: T, cb: (ctx: T, index: number, op: OPERATION) => void): void;
    size(): number;
    has(): boolean;
    reset(): void;
}

// Module-scope adapter: lets `forEach(cb)` delegate to `forEachWithCtx`
// by passing the user's callback as ctx. No per-call allocation.
const _invokeNoCtx = (
    cb: (index: number, op: OPERATION) => void,
    index: number,
    op: OPERATION,
) => cb(index, op);

/**
 * Schema field operations are limited to ADD(128), DELETE(64), and
 * DELETE_AND_ADD(192). REPLACE(0) is collection-only, so `ops[i] === 0`
 * is a safe "no operation" sentinel.
 *
 * `dirtyLow` / `dirtyHigh` / `ops` are public so the unreliable emitter can
 * walk the storage directly (same reason the reliable emitter reads
 * `ChangeTree.dirtyLow` etc.).
 */
export class SchemaChangeRecorder implements ChangeRecorder {
    // Bitmask storage for fields 0-31 (low) and 32-63 (high).
    dirtyLow = 0;
    dirtyHigh = 0;

    // ops[fieldIndex] = OPERATION value. Pre-sized to numFields+1.
    readonly ops: Uint8Array;

    constructor(numFields: number) {
        this.ops = new Uint8Array(Math.max(numFields + 1, 1));
    }

    record(index: number, op: OPERATION): void {
        const prev = this.ops[index];
        if (prev === 0) this.ops[index] = op;
        else if (prev === OPERATION.DELETE) this.ops[index] = OPERATION.DELETE_AND_ADD;
        // Promote ADD → DELETE_AND_ADD when a ref is replaced in the same
        // tick. See `ChangeTree.record` for rationale.
        else if (prev === OPERATION.ADD && op === OPERATION.DELETE_AND_ADD) {
            this.ops[index] = OPERATION.DELETE_AND_ADD;
        }
        // else preserve existing ADD / DELETE_AND_ADD.

        if (index < 32) this.dirtyLow |= (1 << index);
        else this.dirtyHigh |= (1 << (index - 32));
    }

    recordDelete(index: number, op: OPERATION): void {
        this.ops[index] = op;
        if (index < 32) this.dirtyLow |= (1 << index);
        else this.dirtyHigh |= (1 << (index - 32));
    }

    operationAt(index: number): OPERATION | undefined {
        const op = this.ops[index];
        return op === 0 ? undefined : op;
    }

    forEach(cb: (index: number, op: OPERATION) => void): void {
        this.forEachWithCtx(cb, _invokeNoCtx);
    }

    forEachWithCtx<T>(ctx: T, cb: (ctx: T, index: number, op: OPERATION) => void): void {
        let low = this.dirtyLow;
        let high = this.dirtyHigh;
        const ops = this.ops;
        // Iterate set bits via clz32 (CPU-level bit scan).
        while (low !== 0) {
            const bit = low & -low;
            const fieldIndex = 31 - Math.clz32(bit);
            low ^= bit;
            cb(ctx, fieldIndex, ops[fieldIndex]);
        }
        while (high !== 0) {
            const bit = high & -high;
            const fieldIndex = 31 - Math.clz32(bit) + 32;
            high ^= bit;
            cb(ctx, fieldIndex, ops[fieldIndex]);
        }
    }

    size(): number {
        return popcount32(this.dirtyLow) + popcount32(this.dirtyHigh);
    }

    has(): boolean {
        return (this.dirtyLow | this.dirtyHigh) !== 0;
    }

    reset(): void {
        this.dirtyLow = 0;
        this.dirtyHigh = 0;
        this.ops.fill(0);
    }
}

/** 32-bit Hamming weight (popcount). */
export function popcount32(n: number): number {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
