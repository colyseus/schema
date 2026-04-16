import { OPERATION } from "../encoding/spec.js";

/**
 * Identifies which "view" of recorded changes to read or write.
 *
 *  - "changes":              dirty indexes for the next outgoing patch (cleared on endEncode)
 *  - "allChanges":           cumulative dirty indexes since instance creation (used by encodeAll / new views)
 *  - "filteredChanges":      filtered variant of "changes" (per-view encoding)
 *  - "allFilteredChanges":   filtered variant of "allChanges"
 */
export type ChangeKind =
    | "changes"
    | "allChanges"
    | "filteredChanges"
    | "allFilteredChanges";

/**
 * ChangeRecorder is the unifying abstraction for "what changed this tick"
 * across Schema and Collection types. Two implementations:
 *
 *   - {@link SchemaChangeRecorder}: fixed fields (≤64), bitmask + Uint8Array
 *   - {@link CollectionChangeRecorder}: dynamic indexes, Map + Set
 *
 * Replaces the per-instance `indexedOperations` sparse array + 4 ChangeSet
 * objects + their inner index/operation arrays. Net allocation reduction of
 * 4-5 objects per Schema and 4-8 objects per Collection (depending on
 * whether filtered changes are active).
 */
export interface ChangeRecorder {
    /**
     * Record a change at the given index with the given operation type.
     * Updates both current-tick and cumulative dirty sets. Handles op merge
     * (e.g. DELETE followed by ADD becomes DELETE_AND_ADD).
     *
     * If `filtered` is true, writes to the filtered variants instead.
     */
    record(index: number, op: OPERATION, filtered: boolean): void;

    /**
     * Record a DELETE at the given index. Adds to current-tick dirty set
     * but REMOVES from cumulative set (a deleted item shouldn't reappear
     * in encodeAll snapshots).
     *
     * For ArraySchema, the current-tick `index` (position in tmpItems)
     * may differ from `cumulativeIndex` (position in items). Defaults to
     * `index` for callers that don't distinguish.
     */
    recordDelete(index: number, op: OPERATION, filtered: boolean, cumulativeIndex?: number): void;

    /**
     * Like record(), but allows distinct current-tick index and cumulative
     * index. Used by ArraySchema.push()/set() where the position in tmpItems
     * (the last-encoded snapshot) can differ from the position in items (the
     * live state).
     *
     * Schema implementations treat cumulativeIndex as identical to index
     * (Schema field indexes are stable).
     */
    recordWithCumulativeIndex(index: number, cumulativeIndex: number, op: OPERATION, filtered: boolean): void;

    /**
     * Record a pure operation (CLEAR, REVERSE) that has no index.
     * Only collections use this. Schema implementations may throw.
     */
    recordPure(op: OPERATION, filtered: boolean): void;

    /**
     * Add an entry to the current-tick dirty set only (changes / filteredChanges),
     * WITHOUT also adding to the cumulative set.
     *
     * Used by ChangeTree.trackCumulativeIndex when mirroring legacy's
     * asymmetric setOperationAtIndex(filteredChanges, i) call in ArraySchema.unshift.
     */
    recordInCurrentTick(index: number, op: OPERATION, filtered: boolean): void;

    /**
     * Add an entry to the cumulative set only (allChanges / allFilteredChanges),
     * WITHOUT also adding to the current-tick set.
     *
     * Used by ChangeTree.trackCumulativeIndex when mirroring legacy's
     * asymmetric setOperationAtIndex(allChanges, i) call in ArraySchema.unshift.
     */
    recordInCumulative(index: number, op: OPERATION, filtered: boolean): void;

    /**
     * Get the current operation type recorded at index, or 0 / undefined if none.
     * Used by Root.add() re-add path and ChangeTree's getChange() debug API.
     */
    operationAt(index: number): OPERATION | undefined;

    /**
     * Overwrite the operation type at index. Used by Root.add() when re-adding
     * a previously-removed ChangeTree (resets all ops to ADD).
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
     * allocation in the hot encode path. The callback is a pure module-level
     * function that reads state from `ctx` — no captured variables, so V8
     * can inline efficiently.
     */
    forEachWithCtx<T>(kind: ChangeKind, ctx: T, cb: (ctx: T, index: number, op: OPERATION) => void): void;

    /** Number of recorded entries for the given kind. */
    sizeOf(kind: ChangeKind): number;

    /** True if there are any changes recorded for the given kind. */
    has(kind: ChangeKind): boolean;

    /** Clear all recorded changes for the given kind (called from endEncode/discard). */
    reset(kind: ChangeKind): void;

    /**
     * Move all current-tick (changes / allChanges) entries into the filtered
     * variants, clearing the originals. Used by ChangeTree._checkFilteredByParent
     * when an instance becomes filtered after first being recorded as unfiltered.
     */
    promoteToFiltered(): void;

    /**
     * Shift current-tick dirty indexes by `shiftIndex`. Used by ArraySchema.unshift.
     * Each entry at index i becomes index i+shiftIndex; ops array is likewise shifted.
     */
    shift(shiftIndex: number): void;

    /**
     * Shift cumulative dirty indexes (allChanges/allFilteredChanges) that are
     * greater than startIndex by shiftIndex. Used by ArraySchema.splice.
     */
    shiftCumulative(shiftIndex: number, startIndex: number): void;

    /**
     * Returns true if filtered storage has been allocated.
     * Used to decide whether filtered iteration is necessary.
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
    private allLow = 0;
    private allHigh = 0;
    private filteredLow = 0;
    private filteredHigh = 0;
    private allFilteredLow = 0;
    private allFilteredHigh = 0;

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
            this.allFilteredLow |= lowBit;
            this.allFilteredHigh |= highBit;
        } else {
            this.dirtyLow |= lowBit;
            this.dirtyHigh |= highBit;
            this.allLow |= lowBit;
            this.allHigh |= highBit;
        }
    }

    recordDelete(index: number, op: OPERATION, filtered: boolean, cumulativeIndex: number = index): void {
        this.ops[index] = op;

        const dirtyLowBit = (index < 32) ? (1 << index) : 0;
        const dirtyHighBit = (index >= 32) ? (1 << (index - 32)) : 0;
        const cumLowBit = (cumulativeIndex < 32) ? (1 << cumulativeIndex) : 0;
        const cumHighBit = (cumulativeIndex >= 32) ? (1 << (cumulativeIndex - 32)) : 0;

        if (filtered) {
            this._hasFiltered = true;
            this.filteredLow |= dirtyLowBit;
            this.filteredHigh |= dirtyHighBit;
        } else {
            this.dirtyLow |= dirtyLowBit;
            this.dirtyHigh |= dirtyHighBit;
        }

        // Cumulative removal — ChangeTree.delete routes the dirty write to
        // `filteredChanges` whenever the tree has filtered storage, even for
        // non-filtered fields. But the cumulative entry may live in either
        // `allChanges` or `allFilteredChanges` depending on whether the field
        // was originally added with a @view tag. Clear the bit from both to
        // match legacy deleteOperationAtIndex(allChanges, ...) + (allFiltered).
        this.allLow &= ~cumLowBit;
        this.allHigh &= ~cumHighBit;
        this.allFilteredLow &= ~cumLowBit;
        this.allFilteredHigh &= ~cumHighBit;
    }

    recordWithCumulativeIndex(index: number, _cumulativeIndex: number, op: OPERATION, filtered: boolean): void {
        // Schema field indexes are stable — cumulative and current-tick are
        // always the same. Delegate to record().
        this.record(index, op, filtered);
    }

    recordPure(_op: OPERATION, _filtered: boolean): void {
        // Schema types never use pure ops (CLEAR/REVERSE). Indicates a bug.
        throw new Error("SchemaChangeRecorder: pure operations are not supported");
    }

    recordInCurrentTick(index: number, op: OPERATION, filtered: boolean): void {
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

    recordInCumulative(index: number, op: OPERATION, filtered: boolean): void {
        this.ops[index] = op;
        const lowBit = (index < 32) ? (1 << index) : 0;
        const highBit = (index >= 32) ? (1 << (index - 32)) : 0;
        if (filtered) {
            this._hasFiltered = true;
            this.allFilteredLow |= lowBit;
            this.allFilteredHigh |= highBit;
        } else {
            this.allLow |= lowBit;
            this.allHigh |= highBit;
        }
    }

    shift(_shiftIndex: number): void {
        // Schema field indexes don't shift.
        throw new Error("SchemaChangeRecorder: shift is not supported");
    }

    shiftCumulative(_shiftIndex: number, _startIndex: number): void {
        // Schema field indexes don't shift.
        throw new Error("SchemaChangeRecorder: shiftCumulative is not supported");
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
            case "allChanges": low = this.allLow; high = this.allHigh; break;
            case "filteredChanges": low = this.filteredLow; high = this.filteredHigh; break;
            case "allFilteredChanges": low = this.allFilteredLow; high = this.allFilteredHigh; break;
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
            case "allChanges": low = this.allLow; high = this.allHigh; break;
            case "filteredChanges": low = this.filteredLow; high = this.filteredHigh; break;
            case "allFilteredChanges": low = this.allFilteredLow; high = this.allFilteredHigh; break;
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
            case "allChanges": low = this.allLow; high = this.allHigh; break;
            case "filteredChanges": low = this.filteredLow; high = this.filteredHigh; break;
            case "allFilteredChanges": low = this.allFilteredLow; high = this.allFilteredHigh; break;
        }
        return popcount32(low) + popcount32(high);
    }

    has(kind: ChangeKind): boolean {
        switch (kind) {
            case "changes": return (this.dirtyLow | this.dirtyHigh) !== 0;
            case "allChanges": return (this.allLow | this.allHigh) !== 0;
            case "filteredChanges": return (this.filteredLow | this.filteredHigh) !== 0;
            case "allFilteredChanges": return (this.allFilteredLow | this.allFilteredHigh) !== 0;
        }
    }

    reset(kind: ChangeKind): void {
        switch (kind) {
            case "changes":
                this.dirtyLow = 0; this.dirtyHigh = 0;
                // Clear ops to match legacy endEncode's `indexedOperations.length = 0`.
                // Prevents stale op values from breaking the record() merge logic
                // on subsequent ticks (e.g., a field that was ADD last tick being
                // replaced with DELETE_AND_ADD this tick).
                this.ops.fill(0);
                break;
            case "allChanges": this.allLow = 0; this.allHigh = 0; break;
            case "filteredChanges":
                this.filteredLow = 0; this.filteredHigh = 0;
                this.ops.fill(0);
                break;
            case "allFilteredChanges": this.allFilteredLow = 0; this.allFilteredHigh = 0; break;
        }
    }

    promoteToFiltered(): void {
        this._hasFiltered = true;
        this.filteredLow |= this.dirtyLow;
        this.filteredHigh |= this.dirtyHigh;
        this.allFilteredLow |= this.allLow;
        this.allFilteredHigh |= this.allHigh;
        this.dirtyLow = 0;
        this.dirtyHigh = 0;
        this.allLow = 0;
        this.allHigh = 0;
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
    private all: Map<number, OPERATION> = new Map();
    private filteredDirty?: Map<number, OPERATION>;
    private allFiltered?: Map<number, OPERATION>;

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
            this.allFiltered = new Map();
            this.filteredPureOps = [];
        }
    }

    record(index: number, op: OPERATION, filtered: boolean): void {
        if (filtered) {
            this.ensureFilteredStorage();
            // Op merge: DELETE followed by ADD becomes DELETE_AND_ADD. Other
            // existing ops are preserved.
            const prev = this.filteredDirty!.get(index);
            const finalOp = (prev === undefined)
                ? op
                : (prev === OPERATION.DELETE ? OPERATION.DELETE_AND_ADD : prev);
            this.filteredDirty!.set(index, finalOp);
            this.allFiltered!.set(index, finalOp);
        } else {
            const prev = this.dirty.get(index);
            const finalOp = (prev === undefined)
                ? op
                : (prev === OPERATION.DELETE ? OPERATION.DELETE_AND_ADD : prev);
            this.dirty.set(index, finalOp);
            this.all.set(index, finalOp);
        }
    }

    recordDelete(index: number, op: OPERATION, filtered: boolean, cumulativeIndex: number = index): void {
        // Dirty-bucket write — `filtered` indicates the bucket for the
        // current-tick dirty entry.
        if (filtered) {
            this.ensureFilteredStorage();
            this.filteredDirty!.set(index, op);
        } else {
            this.dirty.set(index, op);
        }

        // Cumulative removal — deleted entries shouldn't appear in encodeAll.
        // Legacy ChangeTree.delete removes from BOTH allChanges and (if the
        // tree has filtered storage) allFilteredChanges. The cumulative entry
        // may live in either depending on whether it was originally filtered.
        let removed = false;
        if (this.all.has(cumulativeIndex)) {
            this.all.delete(cumulativeIndex);
            removed = true;
        }
        if (this.allFiltered?.has(cumulativeIndex)) {
            this.allFiltered.delete(cumulativeIndex);
            removed = true;
        }

        if (!removed) {
            // Fallback for ArraySchema splice: the cumulative index was
            // already shifted out of `all` by prior shiftCumulative calls,
            // but we still need to decrement the cumulative set by one.
            // Remove the last-inserted entry as the closest safe approximation.
            if (this.all.size > 0) {
                this.all.delete(lastKeyOf(this.all)!);
            } else if (this.allFiltered && this.allFiltered.size > 0) {
                this.allFiltered.delete(lastKeyOf(this.allFiltered)!);
            }
        }
    }

    recordWithCumulativeIndex(index: number, cumulativeIndex: number, op: OPERATION, filtered: boolean): void {
        // No merge — ArraySchema's positional indexes don't have DELETE→ADD
        // merge semantics. Matches legacy `indexedOperation` which overwrites
        // unconditionally.
        if (filtered) {
            this.ensureFilteredStorage();
            this.filteredDirty!.set(index, op);
            this.allFiltered!.set(cumulativeIndex, op);
        } else {
            this.dirty.set(index, op);
            this.all.set(cumulativeIndex, op);
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

    recordInCurrentTick(index: number, op: OPERATION, filtered: boolean): void {
        if (filtered) {
            this.ensureFilteredStorage();
            this.filteredDirty!.set(index, op);
        } else {
            this.dirty.set(index, op);
        }
    }

    recordInCumulative(index: number, op: OPERATION, filtered: boolean): void {
        if (filtered) {
            this.ensureFilteredStorage();
            this.allFiltered!.set(index, op);
        } else {
            this.all.set(index, op);
        }
    }

    operationAt(index: number): OPERATION | undefined {
        // Current-tick only — matches legacy `ops` Map semantics (cleared
        // in reset("changes")). ChangeTree.change relies on this returning
        // undefined after endEncode so DELETE_AND_ADD merge logic works on
        // re-sets of the same key across ticks.
        return this.dirty.get(index) ?? this.filteredDirty?.get(index);
    }

    setOperationAt(index: number, op: OPERATION): void {
        // Update current-tick buckets only (matches legacy ops semantics).
        if (this.dirty.has(index)) this.dirty.set(index, op);
        if (this.filteredDirty?.has(index)) this.filteredDirty.set(index, op);
    }

    forEach(kind: ChangeKind, cb: (index: number, op: OPERATION) => void): void {
        let map: Map<number, OPERATION> | undefined;
        let pure: Array<[number, OPERATION]> | undefined;

        switch (kind) {
            case "changes": map = this.dirty; pure = this.pureOps; break;
            case "allChanges": map = this.all; pure = undefined; break;
            case "filteredChanges": map = this.filteredDirty; pure = this.filteredPureOps; break;
            case "allFilteredChanges": map = this.allFiltered; pure = undefined; break;
        }

        if (map === undefined) return;

        if (pure !== undefined && pure.length > 0) {
            // Interleave pure ops with indexed ops based on recorded position.
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
            case "allChanges": map = this.all; pure = undefined; break;
            case "filteredChanges": map = this.filteredDirty; pure = this.filteredPureOps; break;
            case "allFilteredChanges": map = this.allFiltered; pure = undefined; break;
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
            case "allChanges": return this.all.size;
            case "filteredChanges": return (this.filteredDirty?.size ?? 0) + (this.filteredPureOps?.length ?? 0);
            case "allFilteredChanges": return this.allFiltered?.size ?? 0;
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
            case "allChanges":
                this.all.clear();
                break;
            case "filteredChanges":
                this.filteredDirty?.clear();
                if (this.filteredPureOps) this.filteredPureOps.length = 0;
                break;
            case "allFilteredChanges":
                this.allFiltered?.clear();
                break;
        }
    }

    promoteToFiltered(): void {
        this.ensureFilteredStorage();
        for (const [idx, op] of this.dirty) this.filteredDirty!.set(idx, op);
        for (const [idx, op] of this.all) this.allFiltered!.set(idx, op);
        for (const entry of this.pureOps) this.filteredPureOps!.push(entry);
        this.dirty.clear();
        this.all.clear();
        this.pureOps.length = 0;
    }

    shift(shiftIndex: number): void {
        // Shift entries in current-tick dirty (and filtered variant, if present).
        // Cumulative (allChanges) is NOT shifted — matches the existing
        // shiftChangeIndexes behavior.
        this.dirty = shiftMap(this.dirty, shiftIndex);
        if (this.filteredDirty !== undefined) {
            this.filteredDirty = shiftMap(this.filteredDirty, shiftIndex);
        }
    }

    shiftCumulative(shiftIndex: number, startIndex: number): void {
        this.all = shiftMapConditional(this.all, shiftIndex, startIndex);
        if (this.allFiltered !== undefined) {
            this.allFiltered = shiftMapConditional(this.allFiltered, shiftIndex, startIndex);
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

function shiftMapConditional<V>(src: Map<number, V>, shiftIndex: number, startIndex: number): Map<number, V> {
    const dst = new Map<number, V>();
    for (const [idx, val] of src) {
        dst.set(idx > startIndex ? idx + shiftIndex : idx, val);
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

/** Return the last-inserted key in a Map (insertion order). */
function lastKeyOf<K>(m: Map<K, any>): K | undefined {
    let last: K | undefined;
    for (const k of m.keys()) last = k;
    return last;
}
