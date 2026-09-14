import { OPERATION } from "../encoding/spec.js";

/**
 * KeyedRecorder — the change recorder of the wire-index-keyed collections
 * (`MapSchema`, `SetSchema`, `StreamSchema`).
 *
 * Entries are addressed by a stable wire index, so a tick's mutations merge
 * per index (last state wins) and `ops` insertion order is the wire order.
 * `CLEAR` is absorbing: it drops every pending op and is emitted first.
 *
 * Removed values are remembered in `deleted` until the end of the tick, so
 * the emitter can (a) resolve the visibility of a removed ref for a
 * `StateView` and (b) never needs to look a removed entry up in the
 * collection's storage.
 */
export class KeyedRecorder<V = any> {
    ops: Map<number, OPERATION> = new Map();
    cleared = false;
    deleted?: Map<number, V>;

    /**
     * Merge table (incoming over pending):
     *   ADD / REPLACE / DELETE_AND_ADD over DELETE → DELETE_AND_ADD
     *   DELETE_AND_ADD over anything            → DELETE_AND_ADD
     *   REPLACE over ADD                        → ADD (still unseen)
     *   otherwise                               → keep the pending op
     */
    add(index: number, op: OPERATION): void {
        const ops = this.ops;
        const prev = ops.get(index);
        let next: OPERATION;
        if (prev === undefined) next = op;
        else if (prev === OPERATION.DELETE) next = OPERATION.DELETE_AND_ADD;
        else if (op === OPERATION.DELETE_AND_ADD) next = OPERATION.DELETE_AND_ADD;
        else if (prev === OPERATION.ADD && op === OPERATION.REPLACE) next = OPERATION.ADD;
        else next = prev;
        ops.set(index, next);
    }

    /** Record a DELETE and remember the removed value. */
    delete(index: number, prev: V): void {
        this.ops.set(index, OPERATION.DELETE);
        this.remember(index, prev);
    }

    /** Remember a removed value without recording an op (streaming paths route their own DELETEs). */
    remember(index: number, prev: V): void {
        (this.deleted ??= new Map()).set(index, prev);
    }

    /** A re-set of a slot removed earlier this tick no longer needs its snapshot. */
    forget(index: number): void {
        this.deleted?.delete(index);
    }

    clear(): void {
        this.ops.clear();
        this.deleted?.clear();
        this.cleared = true;
    }

    opAt(index: number): OPERATION | undefined {
        return this.ops.get(index);
    }

    has(): boolean {
        return this.cleared || this.ops.size > 0;
    }

    size(): number {
        return this.ops.size + (this.cleared ? 1 : 0);
    }

    isPureAdd(): boolean {
        if (this.cleared) return false;
        for (const op of this.ops.values()) {
            if (op !== OPERATION.ADD) return false;
        }
        return true;
    }

    forEach(cb: (index: number, op: OPERATION) => void): void {
        if (this.cleared) cb(-OPERATION.CLEAR, OPERATION.CLEAR);
        for (const [index, op] of this.ops) cb(index, op);
    }

    reset(): void {
        this.ops.clear();
        this.deleted?.clear();
        this.cleared = false;
    }

    recycle(): void {
        this.reset();
    }
}
