import { ARRAY_OP } from "../encoding/spec.js";

/**
 * ArrayLog — the change recorder of an encoder-side `ArraySchema`.
 *
 * An ordered log of the mutations recorded this tick, with the values
 * captured at record time, so the emitter never has to reconstruct a
 * pre-mutation layout (no staged copy of the array, no index translation).
 *
 * Storage is flat: `ops` holds stride-3 entries `[op, a, b]` and `vals` the
 * values the entries consume, in order. Every entry has a *weight* that
 * advances the array's revision `rev`; the decoder keeps the same counter and
 * applies an op only if it has not already observed it through a snapshot
 * taken mid-tick (see the rev rule in `decoder/DecodeOperation.ts`).
 *
 * | op      | a      | b        | vals consumed                     | weight |
 * |---------|--------|----------|-----------------------------------|--------|
 * | PUSH    | count  | start    | count values                      | count  |
 * | INSERT  | index  | count    | count values                      | count  |
 * | SET     | index  | –        | prev, value                       | 1      |
 * | REMOVE  | index  | count    | count removed values              | count  |
 * | REVERSE | –      | –        | –                                 | 1      |
 * | REORDER | len    | –        | len old positions                 | 1      |
 * | CLEAR   | –      | –        | –                                 | 1      |
 * | RESTATE | count  | rev      | count values (the whole array)    | 1      |
 *
 * Invariant: `rev === baseSeq + Σ weight(entries)` at all times.
 */
export class ArrayLog<V = any> {
    /** Stride-3 entries: `[op, a, b]`. */
    ops: number[] = [];
    /** Values consumed by the entries, in order. */
    vals: any[] = [];

    /** Revision of the array: total weight of every op ever recorded (and emitted). */
    rev = 0;
    /** Sequence number of `ops[0]` — the revision the array had before this tick's first op. */
    baseSeq = 0;
    /**
     * Highest revision a mid-tick positional snapshot of this array was taken
     * at. Entries at or above it may still be rewritten (a client that
     * received the snapshot never saw them); entries below it may not.
     */
    snapRev = 0;
    /** Sequence number of the last entry. */
    private lastSeq = 0;

    // ── record ────────────────────────────────────────────────────────

    /** `start` is the array length before the push (lets later same-tick removals / writes fold into the PUSH). */
    push(values: V[], start: number): void {
        const n = values.length;
        if (n === 0) return;
        const ops = this.ops;
        const last = ops.length - 3;
        if (last >= 0 && ops[last] === ARRAY_OP.PUSH) {
            ops[last + 1] += n; // extend the trailing PUSH (weight-preserving)
        } else {
            this.lastSeq = this.rev;
            ops.push(ARRAY_OP.PUSH, n, start);
        }
        const vals = this.vals;
        for (let i = 0; i < n; i++) vals.push(values[i]);
        this.rev += n;
    }

    /**
     * When the trailing entry is a PUSH covering array index `index` whose
     * element postdates every mid-tick snapshot, returns its slot in `vals`;
     * otherwise -1. Such an element never reached the wire, so a same-tick
     * write or removal can fold into the PUSH instead of recording an op.
     */
    private pushedSlot(index: number): number {
        const ops = this.ops;
        const last = ops.length - 3;
        if (last < 0 || ops[last] !== ARRAY_OP.PUSH) return -1;
        const count = ops[last + 1];
        const start = ops[last + 2];
        if (index < start || index >= start + count) return -1;
        if (this.lastSeq + (index - start) < this.snapRev) return -1;
        return this.vals.length - count + (index - start);
    }

    /** Recompute `lastSeq` after the trailing entry was dropped. */
    private recomputeLastSeq(): void {
        const ops = this.ops;
        let seq = this.baseSeq;
        for (let i = 0; i < ops.length - 3; i += 3) seq += ArrayLog.weight(ops, i);
        this.lastSeq = seq;
    }

    insert(index: number, values: V[]): void {
        const n = values.length;
        if (n === 0) return;
        this.lastSeq = this.rev;
        this.ops.push(ARRAY_OP.INSERT, index, n);
        const vals = this.vals;
        for (let i = 0; i < n; i++) vals.push(values[i]);
        this.rev += n;
    }

    set(index: number, prev: V, value: V): void {
        // write over an element pushed this tick: fold into the PUSH
        const slot = this.pushedSlot(index);
        if (slot !== -1) {
            this.vals[slot] = value;
            return;
        }
        const ops = this.ops;
        const last = ops.length - 3;
        if (
            last >= 0 && ops[last] === ARRAY_OP.SET && ops[last + 1] === index &&
            this.lastSeq >= this.snapRev
        ) {
            this.vals[this.vals.length - 1] = value; // overwrite; keep the original `prev`
            return;
        }
        this.lastSeq = this.rev;
        ops.push(ARRAY_OP.SET, index, 0);
        this.vals.push(prev, value);
        this.rev += 1;
    }

    /**
     * `removed` are the elements removed from `index` on, in removal order.
     * Removals of elements pushed this tick shorten the PUSH (they never
     * reached the wire). Adjacent single removals coalesce: `i === s`
     * (shift / splice at the same index) and `i === s - 1` (pop) extend the
     * trailing REMOVE.
     */
    remove(index: number, removed: V[]): void {
        const n = removed.length;
        if (n === 0) return;
        const ops = this.ops;
        const vals = this.vals;

        // removal inside the trailing PUSH: drop those values from the PUSH
        const slot = this.pushedSlot(index);
        if (slot !== -1) {
            const last = ops.length - 3;
            const count = ops[last + 1];
            const start = ops[last + 2];
            const inPush = Math.min(n, start + count - index);
            vals.splice(slot, inPush);
            this.rev -= inPush;
            if (count === inPush) {
                ops.length -= 3;
                this.recomputeLastSeq();
            } else {
                ops[last + 1] = count - inPush;
            }
            if (inPush === n) return;
            // the rest of the range predates the PUSH: record it as a REMOVE
            removed = removed.slice(inPush);
            // (those elements sat before `start`; their index is unchanged)
            return this.remove(index, removed);
        }

        const last = ops.length - 3;
        if (last >= 0 && ops[last] === ARRAY_OP.REMOVE && n === 1) {
            const s = ops[last + 1];
            if (index === s) {
                ops[last + 2] += 1;
                vals.push(removed[0]);
                this.rev += 1;
                return;
            }
            if (index === s - 1) {
                ops[last + 1] = index;
                ops[last + 2] += 1;
                vals.push(removed[0]);
                this.rev += 1;
                return;
            }
        }
        this.lastSeq = this.rev;
        ops.push(ARRAY_OP.REMOVE, index, n);
        for (let i = 0; i < n; i++) vals.push(removed[i]);
        this.rev += n;
    }

    reverse(): void {
        this.lastSeq = this.rev;
        this.ops.push(ARRAY_OP.REVERSE, 0, 0);
        this.rev += 1;
    }

    /** `perm[k]` = old position of the element now at `k`. */
    reorder(perm: number[]): void {
        const n = perm.length;
        this.lastSeq = this.rev;
        this.ops.push(ARRAY_OP.REORDER, n, 0);
        const vals = this.vals;
        for (let i = 0; i < n; i++) vals.push(perm[i]);
        this.rev += 1;
    }

    /** Absorbing: every pending entry is dropped (`baseSeq` moves to their end). */
    clear(): void {
        this.ops.length = 0;
        this.vals.length = 0;
        this.baseSeq = this.rev;
        this.lastSeq = this.rev;
        this.ops.push(ARRAY_OP.CLEAR, 0, 0);
        this.rev += 1;
    }

    /**
     * Absorbing re-statement of the whole array: used when the array is
     * re-staged (re-added under the same refId, a filtered array becoming
     * public) or after a `move()` that changed membership. Bumps the
     * revision (weight 1) — the entry carries the new revision, so every
     * client below it applies the re-statement and clients already at it
     * consume it without effect.
     */
    restate(values: V[]): void {
        this.ops.length = 0;
        this.vals.length = 0;
        this.baseSeq = this.rev;
        this.lastSeq = this.rev;
        this.rev += 1;
        const n = values.length;
        this.ops.push(ARRAY_OP.RESTATE, n, this.rev);
        const vals = this.vals;
        for (let i = 0; i < n; i++) vals.push(values[i]);
    }

    // ── query ─────────────────────────────────────────────────────────

    has(): boolean {
        return this.ops.length > 0;
    }

    size(): number {
        return this.ops.length / 3;
    }

    /** True iff the log holds nothing but PUSH entries (a fresh array built by pushes). */
    isPureAdd(): boolean {
        const ops = this.ops;
        for (let i = 0; i < ops.length; i += 3) {
            if (ops[i] !== ARRAY_OP.PUSH) return false;
        }
        return true;
    }

    /** Arrays have no per-index pending op; kept so `ChangeTree.getChange` stays monomorphic. */
    opAt(_index: number): undefined {
        return undefined;
    }

    /** Number of `vals` slots entry `i` (stride index) consumes. */
    static consumed(ops: number[], i: number): number {
        switch (ops[i]) {
            case ARRAY_OP.PUSH: return ops[i + 1];
            case ARRAY_OP.INSERT: return ops[i + 2];
            case ARRAY_OP.SET: return 2;
            case ARRAY_OP.REMOVE: return ops[i + 2];
            case ARRAY_OP.REORDER: return ops[i + 1];
            case ARRAY_OP.RESTATE: return ops[i + 1];
            default: return 0;
        }
    }

    /** Weight (revision advance) of entry `i`. */
    static weight(ops: number[], i: number): number {
        switch (ops[i]) {
            case ARRAY_OP.PUSH: return ops[i + 1];
            case ARRAY_OP.INSERT: return ops[i + 2];
            case ARRAY_OP.REMOVE: return ops[i + 2];
            default: return 1;
        }
    }

    /** Debug / dump: `(op, a, b, valsOffset)` per entry. */
    forEach(cb: (op: number, a: number, b: number, valsOffset: number) => void): void {
        const ops = this.ops;
        let v = 0;
        for (let i = 0; i < ops.length; i += 3) {
            cb(ops[i], ops[i + 1], ops[i + 2], v);
            v += ArrayLog.consumed(ops, i);
        }
    }

    // ── lifecycle ─────────────────────────────────────────────────────

    /** End of tick: drop the entries; the next tick starts at the current revision. */
    reset(): void {
        this.ops.length = 0;
        this.vals.length = 0;
        this.baseSeq = this.rev;
        this.snapRev = this.rev;
        this.lastSeq = this.rev;
    }

    /** Pool recycle: back to a freshly-constructed log. */
    recycle(): void {
        this.reset();
        this.rev = 0;
        this.baseSeq = 0;
        this.snapRev = 0;
        this.lastSeq = 0;
    }
}
