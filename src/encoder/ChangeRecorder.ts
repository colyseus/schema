import { OPERATION } from "../encoding/spec.js";

/**
 * ChangeRecorder — "what changed this tick" for a single ref.
 *
 * This file holds the two standalone recorder classes used for the
 * unreliable channel (lazy, opt-in). The reliable channel is inlined on
 * `ChangeTree` for perf; see `ChangeTree._isSchema` dispatch.
 *
 * Interface design (ISP):
 *   - {@link ChangeRecorder}: common ops, implemented by both Schema and
 *     Collection recorders.
 *   - {@link ICollectionChangeRecorder}: extends with `recordPure` +
 *     `shift` — collection-only. Schema recorders do NOT carry these.
 *
 * Per-field filter/visibility is decided at encode time, not record time.
 * Full-sync output is derived structurally via `ChangeTree.forEachLive`.
 */
export interface ChangeRecorder {
    /**
     * Record a change at the given index. Handles op merge
     * (DELETE followed by ADD becomes DELETE_AND_ADD).
     */
    record(index: number, op: OPERATION): void;

    /** Record a DELETE at the given index. */
    recordDelete(index: number, op: OPERATION): void;

    /**
     * Record an operation without op-merge semantics. Used by ArraySchema
     * positional writes where DELETE→ADD merge is undesirable.
     */
    recordRaw(index: number, op: OPERATION): void;

    /** Current operation at index, or undefined if none. */
    operationAt(index: number): OPERATION | undefined;

    /** Overwrite the operation at index. */
    setOperationAt(index: number, op: OPERATION): void;

    /**
     * Iterate (index, op) pairs in record order.
     * Pure operations emit with index = -op (wire convention).
     */
    forEach(cb: (index: number, op: OPERATION) => void): void;

    /** Closure-free forEach variant for the hot encode path. */
    forEachWithCtx<T>(ctx: T, cb: (ctx: T, index: number, op: OPERATION) => void): void;

    size(): number;
    has(): boolean;
    reset(): void;
}

/**
 * Extended recorder for collection types — adds `recordPure` (CLEAR /
 * REVERSE) and `shift` (ArraySchema.unshift support).
 */
export interface ICollectionChangeRecorder extends ChangeRecorder {
    /**
     * Record a pure operation (CLEAR / REVERSE) with no index.
     * Interleaves with indexed ops at record order.
     */
    recordPure(op: OPERATION): void;

    /** Shift current-tick dirty indexes by `shiftIndex`. */
    shift(shiftIndex: number): void;
}

// Module-scope adapter: lets `forEach(cb)` delegate to `forEachWithCtx`
// by passing the user's callback as ctx. No per-call allocation.
const _invokeNoCtx = (
    cb: (index: number, op: OPERATION) => void,
    index: number,
    op: OPERATION,
) => cb(index, op);

// ──────────────────────────────────────────────────────────────────────────
// SchemaChangeRecorder — bitmask + Uint8Array, for Schema types (≤64 fields)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Schema field operations are limited to ADD(128), DELETE(64), and
 * DELETE_AND_ADD(192). REPLACE(0) is collection-only, so `ops[i] === 0`
 * is a safe "no operation" sentinel.
 */
export class SchemaChangeRecorder implements ChangeRecorder {
    // Bitmask storage for fields 0-31 (low) and 32-63 (high).
    private dirtyLow = 0;
    private dirtyHigh = 0;

    // ops[fieldIndex] = OPERATION value. Pre-sized to numFields+1.
    private readonly ops: Uint8Array;

    constructor(numFields: number) {
        this.ops = new Uint8Array(Math.max(numFields + 1, 1));
    }

    record(index: number, op: OPERATION): void {
        const prev = this.ops[index];
        if (prev === 0) this.ops[index] = op;
        else if (prev === OPERATION.DELETE) this.ops[index] = OPERATION.DELETE_AND_ADD;
        // else preserve existing ADD / DELETE_AND_ADD.

        if (index < 32) this.dirtyLow |= (1 << index);
        else this.dirtyHigh |= (1 << (index - 32));
    }

    recordDelete(index: number, op: OPERATION): void {
        this.ops[index] = op;
        if (index < 32) this.dirtyLow |= (1 << index);
        else this.dirtyHigh |= (1 << (index - 32));
    }

    recordRaw(index: number, op: OPERATION): void {
        this.record(index, op);
    }

    operationAt(index: number): OPERATION | undefined {
        const op = this.ops[index];
        return op === 0 ? undefined : op;
    }

    setOperationAt(index: number, op: OPERATION): void {
        this.ops[index] = op;
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

// ──────────────────────────────────────────────────────────────────────────
// CollectionChangeRecorder — Map-based, for collections with sparse indexes
// ──────────────────────────────────────────────────────────────────────────

/**
 * Collection items have sparse indexes (e.g. 0, 7, 1024) exceeding the
 * 64-field cap Schema imposes. Map-based storage handles arbitrary
 * indexes; the value at each entry is the OPERATION.
 *
 * Pure operations (CLEAR, REVERSE) live in `pureOps` as `[position, op]`
 * entries where `position` is `dirty.size` at record time — preserves
 * insertion-order interleaving with indexed ops (e.g. CLEAR must emit
 * BEFORE subsequent ADDs).
 */
export class CollectionChangeRecorder implements ICollectionChangeRecorder {
    private dirty: Map<number, OPERATION> = new Map();
    private pureOps: Array<[number, OPERATION]> = [];

    record(index: number, op: OPERATION): void {
        const prev = this.dirty.get(index);
        if (prev === undefined) this.dirty.set(index, op);
        else if (prev === OPERATION.DELETE) this.dirty.set(index, OPERATION.DELETE_AND_ADD);
        // else preserve existing op.
    }

    recordDelete(index: number, op: OPERATION): void {
        this.dirty.set(index, op);
    }

    recordRaw(index: number, op: OPERATION): void {
        this.dirty.set(index, op);
    }

    recordPure(op: OPERATION): void {
        this.pureOps.push([this.dirty.size, op]);
    }

    operationAt(index: number): OPERATION | undefined {
        return this.dirty.get(index);
    }

    setOperationAt(index: number, op: OPERATION): void {
        if (this.dirty.has(index)) this.dirty.set(index, op);
    }

    forEach(cb: (index: number, op: OPERATION) => void): void {
        this.forEachWithCtx(cb, _invokeNoCtx);
    }

    forEachWithCtx<T>(ctx: T, cb: (ctx: T, index: number, op: OPERATION) => void): void {
        const pure = this.pureOps;
        if (pure.length > 0) {
            let pureIdx = 0, i = 0;
            for (const [index, op] of this.dirty) {
                while (pureIdx < pure.length && pure[pureIdx][0] <= i) {
                    const pureOp = pure[pureIdx++][1];
                    cb(ctx, -pureOp, pureOp);
                }
                cb(ctx, index, op);
                i++;
            }
            while (pureIdx < pure.length) {
                const pureOp = pure[pureIdx++][1];
                cb(ctx, -pureOp, pureOp);
            }
        } else {
            for (const [index, op] of this.dirty) cb(ctx, index, op);
        }
    }

    size(): number {
        return this.dirty.size + this.pureOps.length;
    }

    has(): boolean {
        return this.dirty.size > 0 || this.pureOps.length > 0;
    }

    reset(): void {
        this.dirty.clear();
        this.pureOps.length = 0;
    }

    shift(shiftIndex: number): void {
        const dst = new Map<number, OPERATION>();
        for (const [idx, val] of this.dirty) dst.set(idx + shiftIndex, val);
        this.dirty = dst;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** 32-bit Hamming weight (popcount). */
export function popcount32(n: number): number {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
