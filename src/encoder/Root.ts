import { OPERATION } from "../encoding/spec.js";
import { TypeContext } from "../types/TypeContext.js";
import { ChangeTree, ChangeTreeList, createChangeTreeList, type ChangeTreeNode } from "./ChangeTree.js";
import { $changes, $refId } from "../types/symbols.js";
import type { StateView } from "./StateView.js";
import type { StreamSchema } from "../types/custom/StreamSchema.js";
import type { StreamableState } from "./streaming.js";

/**
 * Minimal shape the encoder needs from a streamable collection. Both
 * `StreamSchema` and `.stream()`-decorated `MapSchema`/`SetSchema` etc.
 * satisfy this via a single lazily-allocated `_stream` slot — the
 * per-view / broadcast bookkeeping lives on that object, not directly
 * on the collection, so non-streaming instances pay zero Map/Set
 * allocation cost.
 */
export interface Streamable {
    [$refId]?: number;
    [$changes]: ChangeTree;
    _stream?: StreamableState;
    _dropView(viewId: number): void;
    _unregister(): void;
}

// Reused across Root.add calls — defineProperty is unavoidable ($refId must
// stay non-enumerable for deepStrictEqual) but the descriptor literal isn't.
const $refIdDescriptor = { value: 0, enumerable: false, writable: true };

export class Root {
    /**
     * Monotonic refId counter. RefIds are never recycled — a refId is a
     * stable identity for the lifetime of the room, so a client that
     * missed DELETEs (reconnect) can never see an old id rebound to a
     * different instance. DevMode reads/writes this across HMR cycles.
     */
    protected nextUniqueId: number = 0;

    refCount: {[id: number]: number} = {};
    changeTrees: {[refId: number]: ChangeTree} = {};

    /**
     * Queue of all ChangeTrees with reliable dirty state. Per-tick encode()
     * walks this queue; per-view encodeView() walks it too (filtering at
     * emission time via tree.isFiltered + per-field @view tag).
     */
    changes: ChangeTreeList = createChangeTreeList();

    /**
     * Queue of all ChangeTrees with unreliable dirty state. Walked by
     * `Encoder.encodeUnreliable` / `encodeUnreliableView`. A tree may live
     * in both queues when the Schema has both reliable and unreliable
     * fields dirty at the same time.
     */
    unreliableChanges: ChangeTreeList = createChangeTreeList();

    /**
     * Free-list of ChangeTreeNode objects. Both queues share this pool —
     * a node carries no queue affinity, only `{ changeTree, prev, next, position }`.
     * Reusing nodes turns ~1,250 per-tick allocations (in bench) into 0.
     */
    private _nodePool: ChangeTreeNode[] = [];

    /**
     * View ID allocator for StateView visibility bitmaps on ChangeTree.
     * Each new StateView claims the lowest free ID; releaseViewId() puts
     * the ID back. Avoids unbounded bitmap growth across long-running rooms
     * with view churn (clients joining/leaving).
     */
    private _nextViewId: number = 0;
    private _freeViewIds: number[] = [];

    /** Allocate a fresh view ID (lowest available). */
    public acquireViewId(): number {
        return this._freeViewIds.length > 0
            ? this._freeViewIds.pop()!
            : this._nextViewId++;
    }

    /** Return a view ID to the freelist for reuse. */
    public releaseViewId(id: number): void {
        this._freeViewIds.push(id);
    }

    /**
     * Currently-bound StateViews, keyed by view ID and held via `WeakRef`
     * so the FinalizationRegistry backstop in StateView still works when
     * the user forgets `dispose()`. Callers must iterate via
     * `forEachActiveView`, which prunes dead entries.
     */
    public activeViews: Map<number, WeakRef<StateView>> = new Map();

    /**
     * Streamable collections attached under this Root — `StreamSchema`
     * plus any collection opted into streaming via `.stream()` on the
     * builder. Encoder.encodeView / broadcast pass iterates this set to
     * dispatch per-view / per-tick budget gates.
     */
    public streamTrees: Set<Streamable> = new Set();

    public registerView(view: StateView): void {
        this.activeViews.set(view.id, new WeakRef(view));
    }

    public unregisterView(view: StateView): void {
        this.activeViews.delete(view.id);
        // Clear per-view state on every registered stream so dispose()ing
        // a view doesn't leak its `_pendingByView` / `_sentByView` entries
        // indefinitely. O(streams) on dispose, acceptable since dispose is
        // rare (once per client disconnect).
        const id = view.id;
        for (const stream of this.streamTrees) {
            stream._dropView(id);
        }
    }

    /**
     * Iterate all live StateViews bound to this Root. Prunes entries
     * whose underlying view has been garbage collected without an
     * explicit `dispose()`.
     */
    public forEachActiveView(cb: (view: StateView) => void): void {
        for (const [id, ref] of this.activeViews) {
            const view = ref.deref();
            if (view === undefined) {
                this.activeViews.delete(id);
                for (const stream of this.streamTrees) stream._dropView(id);
                continue;
            }
            cb(view);
        }
    }

    public registerStream(stream: Streamable): void {
        this.streamTrees.add(stream);
    }

    public unregisterStream(stream: Streamable): void {
        this.streamTrees.delete(stream);
    }

    constructor(public types: TypeContext, startRefId: number = 0) {
        this.nextUniqueId = startRefId;
    }

    add(changeTree: ChangeTree) {
        const ref = changeTree.ref;

        // Assign unique `refId` to ref if it doesn't have one yet.
        // $refId is a Symbol but assert.deepStrictEqual still walks
        // *enumerable* own Symbols, so we keep defineProperty(enumerable:false)
        // to keep $refId hidden from deep-equal comparisons in tests.
        if (ref[$refId] === undefined) {
            $refIdDescriptor.value = this.nextUniqueId++;
            Object.defineProperty(ref, $refId, $refIdDescriptor);
        }

        const refId = ref[$refId];

        const isNewChangeTree = (this.changeTrees[refId] === undefined);
        if (isNewChangeTree) { this.changeTrees[refId] = changeTree; }

        const previousRefCount = this.refCount[refId];
        if (previousRefCount === 0 || changeTree.needsRestage) {
            //
            // Re-stage every currently-populated non-transient index as a
            // fresh ADD in the matching dirty bucket so the next encode
            // re-emits it on the correct channel. Two triggers:
            // - refCount 0: a previously-removed tree re-added under the
            //   same refId (its ops were consumed by an earlier encode).
            // - NEEDS_RESTAGE: a `Schema.reset` instance re-entering under
            //   a fresh refId (reset cleared the buckets; its retained
            //   values would otherwise never be encoded).
            //
            changeTree.needsRestage = false;
            changeTree.forEachLive((fieldIndex) => {
                if (changeTree.isFieldUnreliable(fieldIndex)) {
                    changeTree.ensureUnreliableRecorder().record(fieldIndex, OPERATION.ADD);
                } else {
                    changeTree.record(fieldIndex, OPERATION.ADD);
                }
            });
        }

        this.refCount[refId] = (previousRefCount || 0) + 1;

        return isNewChangeTree;
    }

    remove(changeTree: ChangeTree) {
        const refId = changeTree.ref[$refId];
        const refCount = (this.refCount[refId]) - 1;

        if (refCount <= 0) {
            //
            // Only remove "root" reference if it's the last reference
            //
            changeTree.root = undefined;
            delete this.changeTrees[refId];

            // Streamable-collection detach (StreamSchema + any `.stream()`
            // collection). Tree flag is cheaper than the class-level
            // brand and covers both cases uniformly.
            if (changeTree.isStreamCollection) {
                const streamable = changeTree.ref as unknown as Streamable;
                streamable._unregister?.();
                this.unregisterStream(streamable);
            }

            this.removeFromQueue(changeTree);
            this.removeFromUnreliableQueue(changeTree);

            this.refCount[refId] = 0;

            changeTree.forEachChild((child, _) => {
                if (child.removeParent(changeTree.ref)) {
                    if ((
                        child.parentRef === undefined || // no parent, remove it
                        (child.parentRef && this.refCount[child.ref[$refId]] > 0) // parent is still in use, but has more than one reference, remove it
                    )) {
                        this.remove(child);

                    } else if (child.parentRef) {
                        // re-assigning a child of the same root, move it next to parent
                        this.moveNextToParent(child);
                    }
                }
            });

        } else {
            this.refCount[refId] = refCount;

            //
            // When losing a reference to an instance, it is best to move the
            // ChangeTree next to its parent in the encoding queue.
            //
            // This way, at decoding time, the instance that contains the
            // ChangeTree will be available before the ChangeTree itself. If the
            // containing instance is not available, the Decoder will throw
            // "refId not found" error.
            //
            this.recursivelyMoveNextToParent(changeTree);
        }

        return refCount;
    }

    recursivelyMoveNextToParent(changeTree: ChangeTree) {
        this.moveNextToParent(changeTree);
        changeTree.forEachChild((child, _) => this.recursivelyMoveNextToParent(child));
    }

    moveNextToParent(changeTree: ChangeTree): void {
        if (changeTree.changesNode) {
            this._moveNextToParentInList(this.changes, changeTree, changeTree.changesNode, "changesNode");
        }
        if (changeTree.unreliableChangesNode) {
            this._moveNextToParentInList(this.unreliableChanges, changeTree, changeTree.unreliableChangesNode, "unreliableChangesNode");
        }
    }

    private _moveNextToParentInList(
        changeSet: ChangeTreeList,
        changeTree: ChangeTree,
        node: ChangeTreeNode,
        nodeField: "changesNode" | "unreliableChangesNode",
    ): void {
        const parent = changeTree.parent;
        if (!parent || !parent[$changes]) return;

        const parentNode = parent[$changes][nodeField];
        if (!parentNode || parentNode === node) return;

        // Positions are strictly increasing along the list, so this is an
        // exact O(1) "is child already after parent" test — no queue scan.
        if (node.position > parentNode.position) return;

        // Remove node from current position
        if (node.prev) {
            node.prev.next = node.next;
        } else {
            changeSet.next = node.next;
        }

        if (node.next) {
            node.next.prev = node.prev;
        } else {
            changeSet.tail = node.prev;
        }

        // Re-append at the tail: after `parentNode` AND after every other
        // queued parent of a multi-referenced instance — relinking next to
        // the *primary* parent could jump the child ahead of a 2nd/3rd
        // parent whose ADD the decoder must see first. Tail placement gets
        // a fresh max position, keeping the invariant append-only.
        // (`recursivelyMoveNextToParent` visits pre-order, so a moved
        // subtree re-serializes parent-first behind it.)
        node.prev = changeSet.tail;
        node.next = undefined;
        changeSet.tail!.next = node; // parentNode remains in the list — never empty here
        changeSet.tail = node;
        node.position = changeSet.nextPosition++;
    }

    public enqueueChangeTree(
        changeTree: ChangeTree,
        existingNode = changeTree.changesNode
    ) {
        if (existingNode) { return; }
        changeTree.changesNode = this._appendToList(this.changes, changeTree);
    }

    public enqueueUnreliable(
        changeTree: ChangeTree,
        existingNode = changeTree.unreliableChangesNode
    ) {
        if (existingNode) { return; }
        changeTree.unreliableChangesNode = this._appendToList(this.unreliableChanges, changeTree);
    }

    private _appendToList(list: ChangeTreeList, changeTree: ChangeTree): ChangeTreeNode {
        const pool = this._nodePool;
        let node: ChangeTreeNode;
        if (pool.length > 0) {
            node = pool.pop()!;
            node.changeTree = changeTree;
            node.next = undefined;
            node.prev = undefined;
        } else {
            node = { changeTree, next: undefined, prev: undefined, position: 0 };
        }
        if (!list.next) {
            list.nextPosition = 0; // list drained — restart sequence (stays SMI)
            list.next = node;
            list.tail = node;
        } else {
            node.prev = list.tail;
            list.tail!.next = node;
            list.tail = node;
        }
        node.position = list.nextPosition++;
        return node;
    }

    /**
     * Release a detached node back to the free-list. Caller must have
     * already unlinked it from any list and cleared the changeTree's
     * pointer to it. Clears `changeTree`/`prev`/`next` so the pool
     * doesn't retain references through the GC root.
     */
    public releaseNode(node: ChangeTreeNode): void {
        node.changeTree = undefined!;
        node.prev = undefined;
        node.next = undefined;
        this._nodePool.push(node);
    }

    public removeFromQueue(changeTree: ChangeTree): boolean {
        return this._removeNode(this.changes, changeTree, changeTree.changesNode, "changesNode");
    }

    public removeFromUnreliableQueue(changeTree: ChangeTree): boolean {
        return this._removeNode(this.unreliableChanges, changeTree, changeTree.unreliableChangesNode, "unreliableChangesNode");
    }

    private _removeNode(
        changeSet: ChangeTreeList,
        changeTree: ChangeTree,
        node: ChangeTreeNode | undefined,
        nodeField: "changesNode" | "unreliableChangesNode",
    ): boolean {
        if (!node || node.changeTree !== changeTree) return false;

        if (node.prev) {
            node.prev.next = node.next;
        } else {
            changeSet.next = node.next;
        }

        if (node.next) {
            node.next.prev = node.prev;
        } else {
            changeSet.tail = node.prev;
        }

        changeTree[nodeField] = undefined;
        this.releaseNode(node);
        return true;
    }
}
