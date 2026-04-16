import { OPERATION } from "../encoding/spec.js";

/**
 * ChangeRecorder is the unifying abstraction for "what changed this tick"
 * across Schema and Collection types. Two implementations:
 *
 *   - {@link SchemaChangeRecorder}: fixed fields (≤64), bitmask + Uint8Array
 *   - {@link CollectionChangeRecorder}: dynamic indexes, Map
 *
 * A single `dirty` bucket per tree. The per-field filter/visibility decision
 * (untagged vs @view-tagged, unfiltered vs inherited-filtered subtree) is
 * made at encode time, not at record time. Full-sync output is derived
 * structurally via {@link ChangeTree.forEachLive}.
 */
export interface ChangeRecorder {
    /**
     * Record a change at the given index with the given operation type.
     * Handles op merge (e.g. DELETE followed by ADD becomes DELETE_AND_ADD).
     */
    record(index: number, op: OPERATION): void;

    /** Record a DELETE at the given index. */
    recordDelete(index: number, op: OPERATION): void;

    /**
     * Record an operation without op-merge semantics. Used by ArraySchema
     * positional writes where DELETE→ADD merge is undesirable.
     */
    recordRaw(index: number, op: OPERATION): void;

    /**
     * Record a pure operation (CLEAR, REVERSE) that has no index.
     * Only collections use this. Schema implementations may throw.
     */
    recordPure(op: OPERATION): void;

    /** Get the current operation type recorded at index, or undefined if none. */
    operationAt(index: number): OPERATION | undefined;

    /** Overwrite the operation type at index. */
    setOperationAt(index: number, op: OPERATION): void;

    /**
     * Iterate (index, op) pairs in record order.
     * Pure operations (CLEAR/REVERSE) are emitted with index = -op (matching
     * the existing wire-encoding convention).
     */
    forEach(cb: (index: number, op: OPERATION) => void): void;

    /**
     * Iterate with a reusable context object to avoid per-call closure
     * allocation in the hot encode path.
     */
    forEachWithCtx<T>(ctx: T, cb: (ctx: T, index: number, op: OPERATION) => void): void;

    /** Number of recorded entries. */
    size(): number;

    /** True if there are any changes recorded. */
    has(): boolean;

    /** Clear all recorded changes. */
    reset(): void;

    /**
     * Shift current-tick dirty indexes by `shiftIndex`. Used by ArraySchema.unshift.
     */
    shift(shiftIndex: number): void;
}

// ──────────────────────────────────────────────────────────────────────────
// SchemaChangeRecorder — bitmask-based, for Schema types (≤64 fields)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Schema field operations are limited to ADD(128), DELETE(64), and
 * DELETE_AND_ADD(192). REPLACE(0) is collection-only. So `ops[i] === 0`
 * is a safe "no operation" sentinel for Schema instances.
 */
export class SchemaChangeRecorder implements ChangeRecorder {
    // Bitmask storage for fields 0-31 (low) and 32-63 (high)
    private dirtyLow = 0;
    private dirtyHigh = 0;

    /** ops[fieldIndex] = OPERATION value. Pre-sized to numFields+1. */
    private readonly ops: Uint8Array;

    constructor(numFields: number) {
        this.ops = new Uint8Array(Math.max(numFields + 1, 1));
    }

    record(index: number, op: OPERATION): void {
        // Op merge: DELETE followed by ADD becomes DELETE_AND_ADD
        const prev = this.ops[index];
        if (prev === 0 || prev === OPERATION.DELETE) {
            this.ops[index] = (prev === OPERATION.DELETE) ? OPERATION.DELETE_AND_ADD : op;
        }

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

    recordPure(_op: OPERATION): void {
        throw new Error("SchemaChangeRecorder: pure operations are not supported");
    }

    shift(_shiftIndex: number): void {
        throw new Error("SchemaChangeRecorder: shift is not supported");
    }

    operationAt(index: number): OPERATION | undefined {
        const op = this.ops[index];
        return op === 0 ? undefined : op;
    }

    setOperationAt(index: number, op: OPERATION): void {
        this.ops[index] = op;
    }

    forEach(cb: (index: number, op: OPERATION) => void): void {
        let low = this.dirtyLow;
        let high = this.dirtyHigh;
        const ops = this.ops;
        // Iterate set bits using clz32 (CPU-instruction-level bit scan).
        while (low !== 0) {
            const bit = low & -low;
            const fieldIndex = 31 - Math.clz32(bit);
            low ^= bit;
            cb(fieldIndex, ops[fieldIndex]);
        }
        while (high !== 0) {
            const bit = high & -high;
            const fieldIndex = 31 - Math.clz32(bit) + 32;
            high ^= bit;
            cb(fieldIndex, ops[fieldIndex]);
        }
    }

    forEachWithCtx<T>(ctx: T, cb: (ctx: T, index: number, op: OPERATION) => void): void {
        let low = this.dirtyLow;
        let high = this.dirtyHigh;
        const ops = this.ops;
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
 * Collection items can have sparse indexes (e.g. 0, 7, 1024) far exceeding
 * the 64-field cap that Schema imposes. Map-based storage handles arbitrary
 * indexes; the value at each entry is the OPERATION type itself.
 *
 * Pure operations (CLEAR, REVERSE) are stored as parallel `[position, op]`
 * entries to preserve insertion order interleaving with indexed ops.
 */
export class CollectionChangeRecorder implements ChangeRecorder {
    private dirty: Map<number, OPERATION> = new Map();
    /**
     * Pure ops (CLEAR/REVERSE), no index. Each entry is `[position, op]` where
     * `position` is the size of the dirty Map at record time. Preserves the
     * interleaved insertion order of pure vs indexed ops (e.g. CLEAR must
     * come BEFORE subsequent ADDs in the emitted sequence).
     */
    private pureOps: Array<[number, OPERATION]> = [];

    record(index: number, op: OPERATION): void {
        const prev = this.dirty.get(index);
        const finalOp = (prev === undefined)
            ? op
            : (prev === OPERATION.DELETE ? OPERATION.DELETE_AND_ADD : prev);
        this.dirty.set(index, finalOp);
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
        const pure = this.pureOps;
        if (pure.length > 0) {
            let pureIdx = 0;
            let i = 0;
            for (const [index, op] of this.dirty) {
                while (pureIdx < pure.length && pure[pureIdx][0] <= i) {
                    const pureOp = pure[pureIdx][1];
                    cb(-pureOp, pureOp);
                    pureIdx++;
                }
                cb(index, op);
                i++;
            }
            while (pureIdx < pure.length) {
                const pureOp = pure[pureIdx][1];
                cb(-pureOp, pureOp);
                pureIdx++;
            }
        } else {
            for (const [index, op] of this.dirty) {
                cb(index, op);
            }
        }
    }

    forEachWithCtx<T>(ctx: T, cb: (ctx: T, index: number, op: OPERATION) => void): void {
        const pure = this.pureOps;
        if (pure.length > 0) {
            let pureIdx = 0;
            let i = 0;
            for (const [index, op] of this.dirty) {
                while (pureIdx < pure.length && pure[pureIdx][0] <= i) {
                    const pureOp = pure[pureIdx][1];
                    cb(ctx, -pureOp, pureOp);
                    pureIdx++;
                }
                cb(ctx, index, op);
                i++;
            }
            while (pureIdx < pure.length) {
                const pureOp = pure[pureIdx][1];
                cb(ctx, -pureOp, pureOp);
                pureIdx++;
            }
        } else {
            for (const [index, op] of this.dirty) {
                cb(ctx, index, op);
            }
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
        for (const [idx, val] of this.dirty) {
            dst.set(idx + shiftIndex, val);
        }
        this.dirty = dst;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Population count for 32-bit integer (Hamming weight). */
function popcount32(n: number): number {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
