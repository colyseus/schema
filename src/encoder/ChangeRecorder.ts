import { OPERATION } from "../encoding/spec.js";

/**
 * Identifies which "view" of recorded changes to read or write.
 *
 *  - "changes":         dirty indexes for the next outgoing patch (cleared on endEncode)
 *  - "filteredChanges": filtered variant of "changes" (per-view encoding)
 *
 * Full-sync (encodeAll / fresh StateView.add) does NOT use a recorder kind;
 * it walks the live ref structure directly via ChangeTree.forEachLive.
 */
export type ChangeKind =
    | "changes"
    | "filteredChanges";

/**
 * ChangeRecorder is the unifying abstraction for "what changed this tick"
 * across Schema and Collection types. Two implementations:
 *
 *   - {@link SchemaChangeRecorder}: fixed fields (≤64), bitmask + Uint8Array
 *   - {@link CollectionChangeRecorder}: dynamic indexes, Map
 */
export interface ChangeRecorder {
    /**
     * Record a change at the given index with the given operation type.
     * Handles op merge (e.g. DELETE followed by ADD becomes DELETE_AND_ADD).
     *
     * If `filtered` is true, writes to the filtered variant instead.
     */
    record(index: number, op: OPERATION, filtered: boolean): void;

    /**
     * Record a DELETE at the given index.
     */
    recordDelete(index: number, op: OPERATION, filtered: boolean): void;

    /**
     * Record an operation without op-merge semantics. Used by ArraySchema
     * positional writes where DELETE→ADD merge is undesirable.
     */
    recordRaw(index: number, op: OPERATION, filtered: boolean): void;

    /**
     * Record a pure operation (CLEAR, REVERSE) that has no index.
     * Only collections use this. Schema implementations may throw.
     */
    recordPure(op: OPERATION, filtered: boolean): void;

    /**
     * Get the current operation type recorded at index, or undefined if none.
     */
    operationAt(index: number): OPERATION | undefined;

    /**
     * Overwrite the operation type at index.
     */
    setOperationAt(index: number, op: OPERATION): void;

    /**
     * Iterate (index, op) pairs for the given kind, in record order.
     * Pure operations (CLEAR/REVERSE) are emitted with index = -op (matching
     * the existing wire-encoding convention).
     */
    forEach(kind: ChangeKind, cb: (index: number, op: OPERATION) => void): void;

    /**
     * Iterate with a reusable context object to avoid per-call closure
     * allocation in the hot encode path.
     */
    forEachWithCtx<T>(kind: ChangeKind, ctx: T, cb: (ctx: T, index: number, op: OPERATION) => void): void;

    /** Number of recorded entries for the given kind. */
    sizeOf(kind: ChangeKind): number;

    /** True if there are any changes recorded for the given kind. */
    has(kind: ChangeKind): boolean;

    /** Clear all recorded changes for the given kind. */
    reset(kind: ChangeKind): void;

    /**
     * Move all current-tick entries in `changes` into `filteredChanges`,
     * clearing the originals. Used by ChangeTree._checkFilteredByParent
     * when an instance becomes filtered after first being recorded as unfiltered.
     */
    promoteToFiltered(): void;

    /**
     * Shift current-tick dirty indexes by `shiftIndex`. Used by ArraySchema.unshift.
     */
    shift(shiftIndex: number): void;

    /**
     * Returns true if filtered storage has been allocated.
     */
    readonly hasFilteredStorage: boolean;
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
    private filteredLow = 0;
    private filteredHigh = 0;

    /** ops[fieldIndex] = OPERATION value. Pre-sized to numFields+1. */
    private readonly ops: Uint8Array;

    private _hasFiltered = false;

    constructor(numFields: number) {
        // numFields is highest field index; size to numFields+1
        this.ops = new Uint8Array(Math.max(numFields + 1, 1));
    }

    get hasFilteredStorage(): boolean {
        return this._hasFiltered;
    }

    record(index: number, op: OPERATION, filtered: boolean): void {
        // Op merge: DELETE followed by ADD becomes DELETE_AND_ADD
        const prev = this.ops[index];
        if (prev === 0 || prev === OPERATION.DELETE) {
            this.ops[index] = (prev === OPERATION.DELETE) ? OPERATION.DELETE_AND_ADD : op;
        }

        const lowBit = (index < 32) ? (1 << index) : 0;
        const highBit = (index >= 32) ? (1 << (index - 32)) : 0;

        if (filtered) {
            this._hasFiltered = true;
            this.filteredLow |= lowBit;
            this.filteredHigh |= highBit;
        } else {
            this.dirtyLow |= lowBit;
            this.dirtyHigh |= highBit;
        }
    }

    recordDelete(index: number, op: OPERATION, filtered: boolean): void {
        this.ops[index] = op;

        const lowBit = (index < 32) ? (1 << index) : 0;
        const highBit = (index >= 32) ? (1 << (index - 32)) : 0;

        if (filtered) {
            this._hasFiltered = true;
            this.filteredLow |= lowBit;
            this.filteredHigh |= highBit;
        } else {
            this.dirtyLow |= lowBit;
            this.dirtyHigh |= highBit;
        }
    }

    recordRaw(index: number, op: OPERATION, filtered: boolean): void {
        // Schema doesn't have raw (no-merge) writes in practice; fall back to record.
        this.record(index, op, filtered);
    }

    recordPure(_op: OPERATION, _filtered: boolean): void {
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

    forEach(kind: ChangeKind, cb: (index: number, op: OPERATION) => void): void {
        let low: number, high: number;
        switch (kind) {
            case "changes": low = this.dirtyLow; high = this.dirtyHigh; break;
            case "filteredChanges": low = this.filteredLow; high = this.filteredHigh; break;
        }

        const ops = this.ops;
        // Iterate set bits using clz32 trick (CPU-instruction-level bit scan)
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

    forEachWithCtx<T>(kind: ChangeKind, ctx: T, cb: (ctx: T, index: number, op: OPERATION) => void): void {
        let low: number, high: number;
        switch (kind) {
            case "changes": low = this.dirtyLow; high = this.dirtyHigh; break;
            case "filteredChanges": low = this.filteredLow; high = this.filteredHigh; break;
        }

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

    sizeOf(kind: ChangeKind): number {
        let low: number, high: number;
        switch (kind) {
            case "changes": low = this.dirtyLow; high = this.dirtyHigh; break;
            case "filteredChanges": low = this.filteredLow; high = this.filteredHigh; break;
        }
        return popcount32(low) + popcount32(high);
    }

    has(kind: ChangeKind): boolean {
        switch (kind) {
            case "changes": return (this.dirtyLow | this.dirtyHigh) !== 0;
            case "filteredChanges": return (this.filteredLow | this.filteredHigh) !== 0;
        }
    }

    reset(kind: ChangeKind): void {
        switch (kind) {
            case "changes":
                this.dirtyLow = 0; this.dirtyHigh = 0;
                this.ops.fill(0);
                break;
            case "filteredChanges":
                this.filteredLow = 0; this.filteredHigh = 0;
                this.ops.fill(0);
                break;
        }
    }

    promoteToFiltered(): void {
        this._hasFiltered = true;
        this.filteredLow |= this.dirtyLow;
        this.filteredHigh |= this.dirtyHigh;
        this.dirtyLow = 0;
        this.dirtyHigh = 0;
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
 * Pure operations (CLEAR, REVERSE) are stored as separate negative-keyed
 * entries to preserve the wire-encoding convention.
 */
export class CollectionChangeRecorder implements ChangeRecorder {
    private dirty: Map<number, OPERATION> = new Map();
    private filteredDirty?: Map<number, OPERATION>;

    /**
     * Pure ops (CLEAR/REVERSE), no index. Each entry is `[position, op]` where
     * `position` is the size of the corresponding dirty Map at record time.
     * This preserves the interleaved insertion order of pure vs indexed ops
     * (e.g. CLEAR must come BEFORE subsequent ADDs in the emitted sequence).
     */
    private pureOps: Array<[number, OPERATION]> = [];
    private filteredPureOps?: Array<[number, OPERATION]>;

    get hasFilteredStorage(): boolean {
        return this.filteredDirty !== undefined;
    }

    private ensureFilteredStorage(): void {
        if (this.filteredDirty === undefined) {
            this.filteredDirty = new Map();
            this.filteredPureOps = [];
        }
    }

    record(index: number, op: OPERATION, filtered: boolean): void {
        if (filtered) {
            this.ensureFilteredStorage();
            // Op merge: DELETE followed by ADD becomes DELETE_AND_ADD.
            const prev = this.filteredDirty!.get(index);
            const finalOp = (prev === undefined)
                ? op
                : (prev === OPERATION.DELETE ? OPERATION.DELETE_AND_ADD : prev);
            this.filteredDirty!.set(index, finalOp);
        } else {
            const prev = this.dirty.get(index);
            const finalOp = (prev === undefined)
                ? op
                : (prev === OPERATION.DELETE ? OPERATION.DELETE_AND_ADD : prev);
            this.dirty.set(index, finalOp);
        }
    }

    recordDelete(index: number, op: OPERATION, filtered: boolean): void {
        if (filtered) {
            this.ensureFilteredStorage();
            this.filteredDirty!.set(index, op);
        } else {
            this.dirty.set(index, op);
        }
    }

    recordRaw(index: number, op: OPERATION, filtered: boolean): void {
        // No merge — matches legacy `indexedOperation` which overwrites unconditionally.
        if (filtered) {
            this.ensureFilteredStorage();
            this.filteredDirty!.set(index, op);
        } else {
            this.dirty.set(index, op);
        }
    }

    recordPure(op: OPERATION, filtered: boolean): void {
        if (filtered) {
            this.ensureFilteredStorage();
            this.filteredPureOps!.push([this.filteredDirty!.size, op]);
        } else {
            this.pureOps.push([this.dirty.size, op]);
        }
    }

    operationAt(index: number): OPERATION | undefined {
        return this.dirty.get(index) ?? this.filteredDirty?.get(index);
    }

    setOperationAt(index: number, op: OPERATION): void {
        if (this.dirty.has(index)) this.dirty.set(index, op);
        if (this.filteredDirty?.has(index)) this.filteredDirty.set(index, op);
    }

    forEach(kind: ChangeKind, cb: (index: number, op: OPERATION) => void): void {
        let map: Map<number, OPERATION> | undefined;
        let pure: Array<[number, OPERATION]> | undefined;

        switch (kind) {
            case "changes": map = this.dirty; pure = this.pureOps; break;
            case "filteredChanges": map = this.filteredDirty; pure = this.filteredPureOps; break;
        }

        if (map === undefined) return;

        if (pure !== undefined && pure.length > 0) {
            let pureIdx = 0;
            let i = 0;
            for (const [index, op] of map) {
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
            for (const [index, op] of map) {
                cb(index, op);
            }
        }
    }

    forEachWithCtx<T>(kind: ChangeKind, ctx: T, cb: (ctx: T, index: number, op: OPERATION) => void): void {
        let map: Map<number, OPERATION> | undefined;
        let pure: Array<[number, OPERATION]> | undefined;

        switch (kind) {
            case "changes": map = this.dirty; pure = this.pureOps; break;
            case "filteredChanges": map = this.filteredDirty; pure = this.filteredPureOps; break;
        }

        if (map === undefined) return;

        if (pure !== undefined && pure.length > 0) {
            let pureIdx = 0;
            let i = 0;
            for (const [index, op] of map) {
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
            for (const [index, op] of map) {
                cb(ctx, index, op);
            }
        }
    }

    sizeOf(kind: ChangeKind): number {
        switch (kind) {
            case "changes": return this.dirty.size + this.pureOps.length;
            case "filteredChanges": return (this.filteredDirty?.size ?? 0) + (this.filteredPureOps?.length ?? 0);
        }
    }

    has(kind: ChangeKind): boolean {
        return this.sizeOf(kind) > 0;
    }

    reset(kind: ChangeKind): void {
        switch (kind) {
            case "changes":
                this.dirty.clear();
                this.pureOps.length = 0;
                break;
            case "filteredChanges":
                this.filteredDirty?.clear();
                if (this.filteredPureOps) this.filteredPureOps.length = 0;
                break;
        }
    }

    promoteToFiltered(): void {
        this.ensureFilteredStorage();
        for (const [idx, op] of this.dirty) this.filteredDirty!.set(idx, op);
        for (const entry of this.pureOps) this.filteredPureOps!.push(entry);
        this.dirty.clear();
        this.pureOps.length = 0;
    }

    shift(shiftIndex: number): void {
        this.dirty = shiftMap(this.dirty, shiftIndex);
        if (this.filteredDirty !== undefined) {
            this.filteredDirty = shiftMap(this.filteredDirty, shiftIndex);
        }
    }
}

function shiftMap<V>(src: Map<number, V>, shiftIndex: number): Map<number, V> {
    const dst = new Map<number, V>();
    for (const [idx, val] of src) {
        dst.set(idx + shiftIndex, val);
    }
    return dst;
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
