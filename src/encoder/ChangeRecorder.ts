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
     */
    recordDelete(index: number, op: OPERATION, filtered: boolean): void;

    /**
     * Record a pure operation (CLEAR, REVERSE) that has no index.
     * Only collections use this. Schema implementations may throw.
     */
    recordPure(op: OPERATION, filtered: boolean): void;

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

    recordDelete(index: number, op: OPERATION, filtered: boolean): void {
        this.ops[index] = op;

        const lowBit = (index < 32) ? (1 << index) : 0;
        const highBit = (index >= 32) ? (1 << (index - 32)) : 0;

        if (filtered) {
            this._hasFiltered = true;
            this.filteredLow |= lowBit;
            this.filteredHigh |= highBit;
            // Remove from cumulative — deleted items shouldn't appear in encodeAll
            this.allFilteredLow &= ~lowBit;
            this.allFilteredHigh &= ~highBit;
        } else {
            this.dirtyLow |= lowBit;
            this.dirtyHigh |= highBit;
            this.allLow &= ~lowBit;
            this.allHigh &= ~highBit;
        }
    }

    recordPure(_op: OPERATION, _filtered: boolean): void {
        // Schema types never use pure ops (CLEAR/REVERSE). Indicates a bug.
        throw new Error("SchemaChangeRecorder: pure operations are not supported");
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

        // Iterate set bits using clz32 trick (CPU-instruction-level bit scan)
        while (low !== 0) {
            const bit = low & -low;
            const fieldIndex = 31 - Math.clz32(bit);
            low ^= bit;
            cb(fieldIndex, this.ops[fieldIndex]);
        }
        while (high !== 0) {
            const bit = high & -high;
            const fieldIndex = 31 - Math.clz32(bit) + 32;
            high ^= bit;
            cb(fieldIndex, this.ops[fieldIndex]);
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
            case "changes": this.dirtyLow = 0; this.dirtyHigh = 0; break;
            case "allChanges": this.allLow = 0; this.allHigh = 0; break;
            case "filteredChanges": this.filteredLow = 0; this.filteredHigh = 0; break;
            case "allFilteredChanges": this.allFilteredLow = 0; this.allFilteredHigh = 0; break;
        }
        // Note: ops are not cleared on per-kind reset. They get overwritten on
        // next record() or are stale-but-harmless (only read when corresponding
        // bit is set in some mask).
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

    /** Operation type per index. Single source of truth across all kinds. */
    private ops: Map<number, OPERATION> = new Map();

    /**
     * Pure ops (CLEAR/REVERSE), no index. Stored as negative pseudo-indexes
     * for wire-format compat (encoder writes Math.abs(index) when fieldIndex < 0).
     */
    private pureOps: OPERATION[] = [];
    private filteredPureOps?: OPERATION[];

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
        // Op merge: DELETE followed by ADD becomes DELETE_AND_ADD
        const prev = this.ops.get(index);
        if (prev === undefined || prev === OPERATION.DELETE) {
            this.ops.set(index, prev === OPERATION.DELETE ? OPERATION.DELETE_AND_ADD : op);
        }

        if (filtered) {
            this.ensureFilteredStorage();
            this.filteredDirty!.set(index, op);
            this.allFiltered!.set(index, op);
        } else {
            this.dirty.set(index, op);
            this.all.set(index, op);
        }
    }

    recordDelete(index: number, op: OPERATION, filtered: boolean): void {
        this.ops.set(index, op);

        if (filtered) {
            this.ensureFilteredStorage();
            this.filteredDirty!.set(index, op);
            // Remove from cumulative — deleted items shouldn't appear in encodeAll
            this.allFiltered!.delete(index);
        } else {
            this.dirty.set(index, op);
            this.all.delete(index);
        }
    }

    recordPure(op: OPERATION, filtered: boolean): void {
        if (filtered) {
            this.ensureFilteredStorage();
            this.filteredPureOps!.push(op);
        } else {
            this.pureOps.push(op);
        }
    }

    operationAt(index: number): OPERATION | undefined {
        return this.ops.get(index);
    }

    setOperationAt(index: number, op: OPERATION): void {
        this.ops.set(index, op);
    }

    forEach(kind: ChangeKind, cb: (index: number, op: OPERATION) => void): void {
        let map: Map<number, OPERATION> | undefined;
        let pure: OPERATION[] | undefined;

        switch (kind) {
            case "changes": map = this.dirty; pure = this.pureOps; break;
            case "allChanges": map = this.all; pure = undefined; break;
            case "filteredChanges": map = this.filteredDirty; pure = this.filteredPureOps; break;
            case "allFilteredChanges": map = this.allFiltered; pure = undefined; break;
        }

        if (map !== undefined) {
            for (const [index, op] of map) {
                cb(index, op);
            }
        }
        if (pure !== undefined) {
            for (let i = 0; i < pure.length; i++) {
                cb(-pure[i], pure[i]);
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
            case "changes": this.dirty.clear(); this.pureOps.length = 0; break;
            case "allChanges": this.all.clear(); break;
            case "filteredChanges":
                this.filteredDirty?.clear();
                if (this.filteredPureOps) this.filteredPureOps.length = 0;
                break;
            case "allFilteredChanges": this.allFiltered?.clear(); break;
        }
    }

    promoteToFiltered(): void {
        this.ensureFilteredStorage();
        for (const [idx, op] of this.dirty) this.filteredDirty!.set(idx, op);
        for (const [idx, op] of this.all) this.allFiltered!.set(idx, op);
        for (const op of this.pureOps) this.filteredPureOps!.push(op);
        this.dirty.clear();
        this.all.clear();
        this.pureOps.length = 0;
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
