import { OPERATION } from "../encoding/spec.js";
import { Schema } from "../Schema.js";
import { $changes, $childType, $decoder, $onEncodeEnd, $encoder, $getByIndex, $refId, $refTypeFieldIndexes, $viewFieldIndexes, type $deleteByIndex } from "../types/symbols.js";

import type { MapSchema } from "../types/custom/MapSchema.js";
import type { ArraySchema } from "../types/custom/ArraySchema.js";
import type { CollectionSchema } from "../types/custom/CollectionSchema.js";
import type { SetSchema } from "../types/custom/SetSchema.js";

import { Root } from "./Root.js";
import { Metadata } from "../Metadata.js";
import { type ChangeRecorder, SchemaChangeRecorder, CollectionChangeRecorder } from "./ChangeRecorder.js";
import { $numFields } from "../types/symbols.js";
import type { EncodeOperation } from "./EncodeOperation.js";
import type { DecodeOperation } from "../decoder/DecodeOperation.js";

declare global {
    interface Object {
        // FIXME: not a good practice to extend globals here
        [$changes]?: ChangeTree;
        // [$refId]?: number;
        [$encoder]?: EncodeOperation,
        [$decoder]?: DecodeOperation,
    }
}

export interface IRef {
    // FIXME: we only commented this out to allow mixing @colyseus/schema bundled types with server types in Cocos Creator
    // [$changes]?: ChangeTree;
    [$refId]?: number;
    [$getByIndex]?: (index: number, isEncodeAll?: boolean) => any;
    [$deleteByIndex]?: (index: number) => void;
}

export type Ref = Schema | ArraySchema | MapSchema | CollectionSchema | SetSchema;

export type ChangeSetName = "changes"
    | "allChanges"
    | "filteredChanges"
    | "allFilteredChanges";

export interface IndexedOperations {
    [index: number]: OPERATION;
}

// Linked list node for change trees
export interface ChangeTreeNode {
    changeTree: ChangeTree;
    next?: ChangeTreeNode;
    prev?: ChangeTreeNode;
    position: number; // Cached position in the linked list for O(1) lookup
}

// Linked list for change trees
export interface ChangeTreeList {
    next?: ChangeTreeNode;
    tail?: ChangeTreeNode;
}

// Linked list helper functions
export function createChangeTreeList(): ChangeTreeList {
    return { next: undefined, tail: undefined };
}

export interface ParentChain {
    ref: Ref;
    index: number;
    next?: ParentChain;
}

// Flags bitfield
const IS_FILTERED = 1;
const IS_VISIBILITY_SHARED = 2;
const IS_NEW = 4;
const HAS_FILTERED_CHANGES = 8;

export class ChangeTree<T extends Ref = any> {
    ref: T;
    metadata: Metadata;

    root?: Root;

    // Inline single parent (the common case)
    parentRef?: Ref;
    _parentIndex?: number;
    extraParents?: ParentChain; // linked list for 2nd+ parents (rare: instance sharing)

    /**
     * Packed boolean flags:
     * bit 0: isFiltered
     * bit 1: isVisibilitySharedWithParent
     * bit 2: isNew
     * bit 3: hasFilteredChanges (tree tracks filtered/allFiltered changes in its recorder)
     */
    flags: number = IS_NEW; // default: isNew=true

    /**
     * Unified change-tracking abstraction — the single source of truth for
     * current-tick and cumulative changes on this tree. SchemaChangeRecorder
     * (bitmask) for Schema instances, CollectionChangeRecorder (Map) for
     * ArraySchema / MapSchema / SetSchema / CollectionSchema.
     */
    recorder: ChangeRecorder;

    /**
     * When true, mutations on the associated ref are NOT tracked.
     * See `pause()` / `resume()` / `untracked(fn)`.
     *
     * The public API lives on Schema (and collection classes) as
     * `instance.pauseTracking()`, `instance.resumeTracking()`, and
     * `instance.untracked(fn)` — all of which delegate here.
     */
    paused: boolean = false;

    // Direct queue-node refs (moved from ChangeSet).
    // Set by Root.addToChangeTreeList / cleared by endEncode / removeChangeFromChangeSet.
    changesNode?: ChangeTreeNode;
    allChangesNode?: ChangeTreeNode;
    filteredChangesNode?: ChangeTreeNode;
    allFilteredChangesNode?: ChangeTreeNode;

    getQueueNode(name: ChangeSetName): ChangeTreeNode | undefined {
        switch (name) {
            case "changes": return this.changesNode;
            case "allChanges": return this.allChangesNode;
            case "filteredChanges": return this.filteredChangesNode;
            case "allFilteredChanges": return this.allFilteredChangesNode;
        }
    }

    setQueueNode(name: ChangeSetName, node: ChangeTreeNode | undefined): void {
        switch (name) {
            case "changes": this.changesNode = node; break;
            case "allChanges": this.allChangesNode = node; break;
            case "filteredChanges": this.filteredChangesNode = node; break;
            case "allFilteredChanges": this.allFilteredChangesNode = node; break;
        }
    }

    // Accessor properties for flags
    get isFiltered(): boolean { return (this.flags & IS_FILTERED) !== 0; }
    set isFiltered(v: boolean) { this.flags = v ? (this.flags | IS_FILTERED) : (this.flags & ~IS_FILTERED); }

    get isVisibilitySharedWithParent(): boolean { return (this.flags & IS_VISIBILITY_SHARED) !== 0; }
    set isVisibilitySharedWithParent(v: boolean) { this.flags = v ? (this.flags | IS_VISIBILITY_SHARED) : (this.flags & ~IS_VISIBILITY_SHARED); }

    get isNew(): boolean { return (this.flags & IS_NEW) !== 0; }
    set isNew(v: boolean) { this.flags = v ? (this.flags | IS_NEW) : (this.flags & ~IS_NEW); }

    get hasFilteredChanges(): boolean { return (this.flags & HAS_FILTERED_CHANGES) !== 0; }
    set hasFilteredChanges(v: boolean) { this.flags = v ? (this.flags | HAS_FILTERED_CHANGES) : (this.flags & ~HAS_FILTERED_CHANGES); }

    constructor(ref: T) {
        this.ref = ref;
        this.metadata = (ref.constructor as typeof Schema)[Symbol.metadata];

        // Allocate the appropriate ChangeRecorder. Schema instances have
        // metadata with $numFields; collections do not (their items are
        // dynamic, not declared via metadata).
        const isSchema = Metadata.isValidInstance(ref);
        if (isSchema) {
            const numFields = (this.metadata?.[$numFields] ?? 0) as number;
            this.recorder = new SchemaChangeRecorder(numFields);
        } else {
            this.recorder = new CollectionChangeRecorder();
        }

        //
        // Does this structure have "filters" declared? Mark the tree as
        // filter-capable so subsequent change() / delete() calls route to
        // the filtered buckets.
        //
        if (this.metadata?.[$viewFieldIndexes]) {
            this.hasFilteredChanges = true;
        }
    }

    setRoot(root: Root) {
        this.root = root;

        const isNewChangeTree = this.root.add(this);

        this.checkIsFiltered(this.parent, this.parentIndex, isNewChangeTree);

        // Recursively set root on child structures
        if (isNewChangeTree) {
            this.forEachChild((child, _) => {
                if (child.root !== root) {
                    child.setRoot(root);
                } else {
                    root.add(child); // increment refCount
                }
            });
        }
    }

    setParent(
        parent: Ref,
        root?: Root,
        parentIndex?: number,
    ) {
        this.addParent(parent, parentIndex);

        // avoid setting parents with empty `root`
        if (!root) { return; }

        const isNewChangeTree = root.add(this);

        // skip if parent is already set
        if (root !== this.root) {
            this.root = root;
            this.checkIsFiltered(parent, parentIndex, isNewChangeTree);
        }

        // assign same parent on child structures
        if (isNewChangeTree) {
            this.forEachChild((child, index) => {
                if (child.root === root) {
                    root.add(child);
                    root.moveNextToParent(child);
                    return;
                }
                child.setParent(this.ref, root, index);
            });
        }
    }

    forEachChild(callback: (change: ChangeTree, at: any) => void) {
        //
        // assign same parent on child structures
        //
        if ((this.ref as any)[$childType]) {
            if (typeof ((this.ref as any)[$childType]) !== "string") {
                // MapSchema / ArraySchema, etc.
                for (const [key, value] of (this.ref as MapSchema).entries()) {
                    if (!value) { continue; } // sparse arrays can have undefined values
                    callback(value[$changes], (this.ref as any)._collectionIndexes?.[key] ?? key);
                };
            }

        } else {
            for (const index of this.metadata?.[$refTypeFieldIndexes] ?? []) {
                const field = this.metadata[index as any as number];
                const value = this.ref[field.name as keyof Ref];
                if (!value) { continue; }
                callback(value[$changes], index);
            }
        }
    }

    operation(op: OPERATION) {
        if (this.paused) return;

        if (this.hasFilteredChanges) {
            this.recorder.recordPure(op, true);
            this.root?.enqueueChangeTree(this, 'filteredChanges');
        } else {
            this.recorder.recordPure(op, false);
            this.root?.enqueueChangeTree(this, 'changes');
        }
    }

    /**
     * Ensure `index` is tracked in the cumulative (allChanges / allFilteredChanges)
     * list without also adding to the current-tick dirty list.
     *
     * Used by ArraySchema.unshift to append the former-last index to the
     * cumulative list (it's being relocated, not newly added).
     */
    trackCumulativeIndex(index: number) {
        const op = this.recorder.operationAt(index) ?? OPERATION.ADD;
        if (this.hasFilteredChanges) {
            // Legacy semantics: writes to filteredChanges (current-tick filtered).
            this.recorder.recordInCurrentTick(index, op, true);
        } else {
            // Legacy semantics: writes to allChanges (cumulative unfiltered).
            this.recorder.recordInCumulative(index, op, false);
        }
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        if (this.paused) return;

        const isFiltered = this.isFiltered || (this.metadata?.[index]?.tag !== undefined);

        const previousOperation = this.recorder.operationAt(index);
        const op = (!previousOperation)
            ? operation
            : (previousOperation === OPERATION.DELETE)
                ? OPERATION.DELETE_AND_ADD
                : previousOperation; // preserve existing op (e.g. already-ADD stays ADD)

        this.recorder.record(index, op, isFiltered);

        if (isFiltered) {
            if (this.root) {
                this.root.enqueueChangeTree(this, 'filteredChanges');
                this.root.enqueueChangeTree(this, 'allFilteredChanges');
            }
        } else {
            this.root?.enqueueChangeTree(this, 'changes');
        }
    }

    shiftChangeIndexes(shiftIndex: number) {
        //
        // Used only during ArraySchema#unshift()
        //
        this.recorder.shift(shiftIndex);
    }

    shiftAllChangeIndexes(shiftIndex: number, startIndex: number = 0) {
        //
        // Used only during ArraySchema#splice()
        //
        this.recorder.shiftCumulative(shiftIndex, startIndex);
    }

    indexedOperation(index: number, operation: OPERATION, allChangesIndex: number = index) {
        if (this.paused) return;

        // ArraySchema passes distinct current-tick (index) vs cumulative
        // (allChangesIndex); other callers default both to the same index.
        this.recorder.recordWithCumulativeIndex(index, allChangesIndex, operation, this.hasFilteredChanges);

        if (this.hasFilteredChanges) {
            this.root?.enqueueChangeTree(this, 'filteredChanges');
        } else {
            this.root?.enqueueChangeTree(this, 'changes');
        }
    }

    getType(index?: number) {
        return (
            //
            // Get the child type from parent structure.
            // - ["string"] => "string"
            // - { map: "string" } => "string"
            // - { set: "string" } => "string"
            //
            (this.ref as any)[$childType] || // ArraySchema | MapSchema | SetSchema | CollectionSchema
            this.metadata[index].type // Schema
        );
    }

    getChange(index: number) {
        return this.recorder.operationAt(index);
    }

    // ────────────────────────────────────────────────────────────────────
    // Change-tracking control API
    //
    // By default, every mutation on a Schema / collection instance is
    // automatically recorded as a change. These methods let the user opt
    // out for bulk-load scenarios or custom batching.
    // ────────────────────────────────────────────────────────────────────

    /**
     * Stop recording mutations until resume() is called.
     *
     * Mutations applied while paused are NOT emitted in the next encode()
     * output. `allChanges` is also not updated for those mutations — if
     * you pause, mutate, resume, then encode, the paused mutations will
     * NOT appear in subsequent encodeAll() snapshots either.
     *
     * Use `markDirty(index)` after resuming to force specific fields into
     * the next patch if needed.
     */
    pause(): void {
        this.paused = true;
    }

    /** Re-enable automatic change tracking. See pause(). */
    resume(): void {
        this.paused = false;
    }

    /**
     * Run `fn` with change tracking paused, then resume.
     * Preserves the previous paused state (safe to nest).
     */
    untracked<T>(fn: () => T): T {
        const wasPaused = this.paused;
        this.paused = true;
        try {
            return fn();
        } finally {
            this.paused = wasPaused;
        }
    }

    /**
     * Manually mark a field/index as dirty so it gets emitted in the next
     * encode(). Useful after paused mutations or when a nested object
     * was mutated without triggering the schema setter.
     */
    markDirty(index: number, operation: OPERATION = OPERATION.ADD): void {
        const wasPaused = this.paused;
        this.paused = false;
        try {
            this.change(index, operation);
        } finally {
            this.paused = wasPaused;
        }
    }

    //
    // used during `.encode()`
    //
    getValue(index: number, isEncodeAll: boolean = false) {
        //
        // `isEncodeAll` param is only used by ArraySchema
        //
        return (this.ref as any)[$getByIndex](index, isEncodeAll);
    }

    delete(index: number, operation?: OPERATION, allChangesIndex = index) {
        if (index === undefined) {
            try {
                throw new Error(`@colyseus/schema ${this.ref.constructor.name}: trying to delete non-existing index '${index}'`);
            } catch (e) {
                console.warn(e);
            }
            return;
        }

        if (this.paused) {
            // Still return the previous value so callers (e.g., MapSchema.delete
            // via journal snapshot) get consistent semantics.
            return this.getValue(index);
        }

        // recordDelete adds to the dirty bucket (filtered if the tree has
        // filtered storage) and removes from both `all` and `allFiltered`
        // cumulative maps. For ArraySchema, `index` (tmpItems-position) may
        // differ from `allChangesIndex` (items-position).
        this.recorder.recordDelete(index, operation ?? OPERATION.DELETE, this.hasFilteredChanges, allChangesIndex);

        const previousValue = this.getValue(index);

        // remove `root` reference
        if (previousValue && previousValue[$changes]) {
            //
            // FIXME: this.root is "undefined"
            //
            // This method is being called at decoding time when a DELETE operation is found.
            //
            // - This is due to using the concrete Schema class at decoding time.
            // - "Reflected" structures do not have this problem.
            //
            // (The property descriptors should NOT be used at decoding time. only at encoding time.)
            //
            this.root?.remove(previousValue[$changes]);
        }

        this.root?.enqueueChangeTree(this, this.hasFilteredChanges ? 'filteredChanges' : 'changes');

        return previousValue;
    }

    endEncode(changeSetName: ChangeSetName) {
        this.recorder.reset(changeSetName);

        // clear queue node for this changeSet
        this.setQueueNode(changeSetName, undefined);

        // ArraySchema and MapSchema have a custom "encode end" method
        (this.ref as any)[$onEncodeEnd]?.();

        // Not a new instance anymore
        this.isNew = false;
    }

    discard(discardAll: boolean = false) {
        //
        // > MapSchema:
        //      Remove cached key to ensure ADD operations is unsed instead of
        //      REPLACE in case same key is used on next patches.
        //
        (this.ref as any)[$onEncodeEnd]?.();

        this.recorder.reset("changes");
        if (this.hasFilteredChanges) {
            this.recorder.reset("filteredChanges");
        }

        if (discardAll) {
            this.recorder.reset("allChanges");
            if (this.hasFilteredChanges) {
                this.recorder.reset("allFilteredChanges");
            }
        }
    }

    /**
     * Recursively discard all changes from this, and child structures.
     * (Used in tests only)
     */
    discardAll() {
        this.recorder.forEach("changes", (index, _op) => {
            if (index < 0) return; // skip pure ops
            const value = this.getValue(index);
            if (value && value[$changes]) {
                value[$changes].discardAll();
            }
        });
        this.discard();
    }

    get changed() {
        return this.recorder.has("changes");
    }

    protected checkIsFiltered(parent: Ref, parentIndex: number, isNewChangeTree: boolean) {
        if (this.root.types.hasFilters) {
            //
            // At Schema initialization, the "root" structure might not be available
            // yet, as it only does once the "Encoder" has been set up.
            //
            // So the "parent" may be already set without a "root".
            //
            this._checkFilteredByParent(parent, parentIndex);

            if (this.hasFilteredChanges) {
                this.root?.enqueueChangeTree(this, 'filteredChanges');

                if (isNewChangeTree) {
                    this.root?.enqueueChangeTree(this, 'allFilteredChanges');
                }
            }
        }

        if (!this.isFiltered) {
            this.root?.enqueueChangeTree(this, 'changes');

            if (isNewChangeTree) {
                this.root?.enqueueChangeTree(this, 'allChanges');
            }
        }
    }

    protected _checkFilteredByParent(parent: Ref, parentIndex: number) {
        // skip if parent is not set
        if (!parent) { return; }

        //
        // ArraySchema | MapSchema - get the child type
        // (if refType is typeof string, the parentFiltered[key] below will always be invalid)
        //
        const refType = Metadata.isValidInstance(this.ref)
            ? this.ref.constructor
            : (this.ref as any)[$childType];

        let parentChangeTree: ChangeTree;

        let parentIsCollection = !Metadata.isValidInstance(parent);
        if (parentIsCollection) {
            parentChangeTree = parent[$changes];
            parent = parentChangeTree.parent;
            parentIndex = parentChangeTree.parentIndex;

        } else {
            parentChangeTree = parent[$changes]
        }

        const parentConstructor = parent.constructor as typeof Schema;

        let key = `${this.root.types.getTypeId(refType as typeof Schema)}`;
        if (parentConstructor) {
            key += `-${this.root.types.schemas.get(parentConstructor)}`;
        }
        key += `-${parentIndex}`;

        const fieldHasViewTag = Metadata.hasViewTagAtIndex(parentConstructor?.[Symbol.metadata], parentIndex);

        this.isFiltered = parent[$changes].isFiltered // in case parent is already filtered
            || this.root.types.parentFiltered[key]
            || fieldHasViewTag;

        //
        // "isFiltered" may not be imedialely available during `change()` due to the instance not being attached to the root yet.
        // when it's available, we need to enqueue the "changes" changeset into the "filteredChanges" changeset.
        //
        if (this.isFiltered) {

            this.isVisibilitySharedWithParent = (
                parentChangeTree.isFiltered &&
                typeof (refType) !== "string" &&
                !fieldHasViewTag &&
                parentIsCollection
            );

            this.hasFilteredChanges = true;

            // Promote any current-tick/cumulative entries recorded before this
            // tree was known to be filtered into the filtered buckets.
            this.recorder.promoteToFiltered();
        }
    }

    /**
     * Get the immediate parent
     */
    get parent(): Ref | undefined {
        return this.parentRef;
    }

    /**
     * Get the immediate parent index
     */
    get parentIndex(): number | undefined {
        return this._parentIndex;
    }

    /**
     * Add a parent to the chain
     */
    addParent(parent: Ref, index: number) {
        // Check if this parent already exists anywhere in the chain
        if (this.parentRef) {
            if (this.parentRef[$changes] === parent[$changes]) {
                // Primary parent matches — update index
                this._parentIndex = index;
                return;
            }

            // Check extra parents for duplicate
            if (this.hasParent((p, _) => p[$changes] === parent[$changes])) {
                // Match old behavior: update primary parent's index
                this._parentIndex = index;
                return;
            }
        }

        if (this.parentRef === undefined) {
            // First parent — store inline
            this.parentRef = parent;
            this._parentIndex = index;
        } else {
            // Push current inline parent to extraParents, set new as primary
            this.extraParents = {
                ref: this.parentRef,
                index: this._parentIndex,
                next: this.extraParents
            };
            this.parentRef = parent;
            this._parentIndex = index;
        }
    }

    /**
     * Remove a parent from the chain
     * @param parent - The parent to remove
     * @returns true if parent was found and removed
     */
    removeParent(parent: Ref = this.parent): boolean {
        //
        // FIXME: it is required to check against `$changes` here because
        // ArraySchema is instance of Proxy
        //
        if (this.parentRef && this.parentRef[$changes] === parent[$changes]) {
            // Removing inline parent — promote first extra parent if exists
            if (this.extraParents) {
                this.parentRef = this.extraParents.ref;
                this._parentIndex = this.extraParents.index;
                this.extraParents = this.extraParents.next;
            } else {
                this.parentRef = undefined;
                this._parentIndex = undefined;
            }
            return true; // parent was found and removed
        }

        // Search extra parents
        let current = this.extraParents;
        let previous = null;
        while (current) {
            if (current.ref[$changes] === parent[$changes]) {
                if (previous) {
                    previous.next = current.next;
                } else {
                    this.extraParents = current.next;
                }
                return true; // parent was found and removed
            }
            previous = current;
            current = current.next;
        }
        return this.parentRef === undefined;
    }

    /**
     * Find a specific parent in the chain
     */
    findParent(predicate: (parent: Ref, index: number) => boolean): ParentChain | undefined {
        // Check inline parent first
        if (this.parentRef && predicate(this.parentRef, this._parentIndex)) {
            return { ref: this.parentRef, index: this._parentIndex };
        }

        let current = this.extraParents;
        while (current) {
            if (predicate(current.ref, current.index)) {
                return current;
            }
            current = current.next;
        }
        return undefined;
    }

    /**
     * Check if this ChangeTree has a specific parent
     */
    hasParent(predicate: (parent: Ref, index: number) => boolean): boolean {
        return this.findParent(predicate) !== undefined;
    }

    /**
     * Get all parents as an array (for debugging/testing)
     */
    getAllParents(): Array<{ ref: Ref, index: number }> {
        const parents: Array<{ ref: Ref, index: number }> = [];
        if (this.parentRef) {
            parents.push({ ref: this.parentRef, index: this._parentIndex });
        }
        let current = this.extraParents;
        while (current) {
            parents.push({ ref: current.ref, index: current.index });
            current = current.next;
        }
        return parents;
    }

}
