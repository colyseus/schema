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

export interface ChangeSet {
    // sparse array: field index -> position in operations array (undefined = not tracked)
    indexes: number[];
    operations: number[];
}

function createChangeSet(): ChangeSet {
    return { indexes: [], operations: [] };
}

function resetChangeSet(changeSet: ChangeSet) {
    changeSet.indexes.length = 0;
    changeSet.operations.length = 0;
}

// Linked list helper functions
export function createChangeTreeList(): ChangeTreeList {
    return { next: undefined, tail: undefined };
}

export function setOperationAtIndex(changeSet: ChangeSet, index: number) {
    if (changeSet.indexes[index] === undefined) {
        changeSet.indexes[index] = changeSet.operations.push(index) - 1;
    }
}

export function deleteOperationAtIndex(changeSet: ChangeSet, index: number | string) {
    let operationsIndex = changeSet.indexes[index as number];
    if (operationsIndex === undefined) {
        //
        // if index is not found, we need to find the last operation
        // FIXME: this is not very efficient
        //
        // > See "should allow consecutive splices (same place)" tests
        //
        // Scan backwards through indexes to find last entry
        const indexes = changeSet.indexes;
        for (let i = indexes.length - 1; i >= 0; i--) {
            if (indexes[i] !== undefined) {
                operationsIndex = indexes[i];
                index = i;
                break;
            }
        }
    }
    changeSet.operations[operationsIndex] = undefined;
    changeSet.indexes[index as number] = undefined;
}

export function debugChangeSet(label: string, changeSet: ChangeSet) {
    let indexes: string[] = [];
    let operations: string[] = [];

    for (let i = 0; i < changeSet.indexes.length; i++) {
        if (changeSet.indexes[i] !== undefined) {
            indexes.push(`\t${i} => [${changeSet.indexes[i]}]`);
        }
    }

    for (let i = 0; i < changeSet.operations.length; i++) {
        const index = changeSet.operations[i];
        if (index !== undefined) {
            operations.push(`\t[${i}] => ${index}`);
        }
    }

    const indexCount = changeSet.indexes.reduce((count, v) => v !== undefined ? count + 1 : count, 0);
    console.log(`${label} =>\nindexes (${indexCount}) {`);
    console.log(indexes.join("\n"), "\n}");
    console.log(`operations (${changeSet.operations.filter(op => op !== undefined).length}) {`);
    console.log(operations.join("\n"), "\n}");
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
     */
    flags: number = IS_NEW; // default: isNew=true

    // Sparse array: index -> OPERATION. Much faster than Map for small integer keys.
    indexedOperations: OPERATION[] = [];

    //
    // TODO:
    //   try storing the index + operation per item.
    //   example: 1024 & 1025 => ADD, 1026 => DELETE
    //
    // => https://chatgpt.com/share/67107d0c-bc20-8004-8583-83b17dd7c196
    //
    changes: ChangeSet = { indexes: [], operations: [] };
    allChanges: ChangeSet = { indexes: [], operations: [] };
    filteredChanges: ChangeSet;
    allFilteredChanges: ChangeSet;

    /**
     * Unified change-tracking abstraction. Populated alongside the legacy
     * fields above (dual-write). Future commits will migrate readers to use
     * this exclusively, then remove the legacy fields.
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

    constructor(ref: T) {
        this.ref = ref;
        this.metadata = (ref.constructor as typeof Schema)[Symbol.metadata];

        //
        // Does this structure have "filters" declared?
        //
        if (this.metadata?.[$viewFieldIndexes]) {
            this.allFilteredChanges = { indexes: [], operations: [] };
            this.filteredChanges = { indexes: [], operations: [] };
        }

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

        // operations without index use negative values to represent them
        // this is checked during .encode() time.
        if (this.filteredChanges !== undefined) {
            this.filteredChanges.operations.push(-op);
            this.recorder.recordPure(op, true);
            this.root?.enqueueChangeTree(this, 'filteredChanges');

        } else {
            this.changes.operations.push(-op);
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
        if (this.filteredChanges !== undefined) {
            setOperationAtIndex(this.filteredChanges, index);
            // Mirror in recorder: the legacy code writes to filteredChanges
            // here (not allFilteredChanges). We record into cumulative via
            // the "allFilteredChanges" side since that's the cumulative map.
            this.recorder.recordWithCumulativeIndex(index, index, this.indexedOperations[index] ?? OPERATION.ADD, true);
        } else {
            setOperationAtIndex(this.allChanges, index);
            this.recorder.recordWithCumulativeIndex(index, index, this.indexedOperations[index] ?? OPERATION.ADD, false);
        }
    }

    change(index: number, operation: OPERATION = OPERATION.ADD) {
        if (this.paused) return;

        const isFiltered = this.isFiltered || (this.metadata?.[index]?.tag !== undefined);
        const changeSet = (isFiltered)
            ? this.filteredChanges
            : this.changes;

        const previousOperation = this.indexedOperations[index];
        if (!previousOperation || previousOperation === OPERATION.DELETE) {
            const op = (!previousOperation)
                ? operation
                : (previousOperation === OPERATION.DELETE)
                    ? OPERATION.DELETE_AND_ADD
                    : operation
            //
            // TODO: are DELETE operations being encoded as ADD here ??
            //
            this.indexedOperations[index] = op;
        }

        setOperationAtIndex(changeSet, index);

        // Dual-write to the unified recorder (legacy state above is the read source).
        this.recorder.record(index, this.indexedOperations[index], isFiltered);

        if (isFiltered) {
            setOperationAtIndex(this.allFilteredChanges, index);

            if (this.root) {
                this.root.enqueueChangeTree(this, 'filteredChanges');
                this.root.enqueueChangeTree(this, 'allFilteredChanges');
            }

        } else {
            setOperationAtIndex(this.allChanges, index);
            this.root?.enqueueChangeTree(this, 'changes');
        }
    }

    shiftChangeIndexes(shiftIndex: number) {
        //
        // Used only during:
        //
        // - ArraySchema#unshift()
        //
        const changeSet = (this.isFiltered)
            ? this.filteredChanges
            : this.changes;

        const oldOps = this.indexedOperations;
        const newOps: OPERATION[] = [];
        const newIndexes: number[] = [];
        for (let i = 0; i < oldOps.length; i++) {
            if (oldOps[i] !== undefined) {
                newOps[i + shiftIndex] = oldOps[i];
                newIndexes[i + shiftIndex] = changeSet.indexes[i];
            }
        }
        this.indexedOperations = newOps;
        changeSet.indexes = newIndexes;

        changeSet.operations = changeSet.operations.map((index) => index + shiftIndex);

        // Dual-write: mirror the shift in the recorder.
        this.recorder.shift(shiftIndex);
    }

    shiftAllChangeIndexes(shiftIndex: number, startIndex: number = 0) {
        //
        // Used only during:
        //
        // - ArraySchema#splice()
        //
        if (this.filteredChanges !== undefined) {
            this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allFilteredChanges);
            this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allChanges);

        } else {
            this._shiftAllChangeIndexes(shiftIndex, startIndex, this.allChanges);
        }

        // Dual-write: mirror the shift in the recorder.
        this.recorder.shiftCumulative(shiftIndex, startIndex);
    }

    private _shiftAllChangeIndexes(shiftIndex: number, startIndex: number = 0, changeSet: ChangeSet) {
        const newIndexes: number[] = [];
        let newKey = 0;
        const indexes = changeSet.indexes;
        for (let i = 0; i < indexes.length; i++) {
            if (indexes[i] !== undefined) {
                newIndexes[newKey++] = indexes[i];
            }
        }
        changeSet.indexes = newIndexes;

        for (let i = 0; i < changeSet.operations.length; i++) {
            const index = changeSet.operations[i];
            if (index > startIndex) {
                changeSet.operations[i] = index + shiftIndex;
            }
        }
    }

    indexedOperation(index: number, operation: OPERATION, allChangesIndex: number = index) {
        if (this.paused) return;

        this.indexedOperations[index] = operation;

        // Dual-write to recorder. ArraySchema passes distinct current-tick
        // (index) vs cumulative (allChangesIndex); other callers default
        // both to the same index.
        this.recorder.recordWithCumulativeIndex(index, allChangesIndex, operation, this.filteredChanges !== undefined);

        if (this.filteredChanges !== undefined) {
            setOperationAtIndex(this.allFilteredChanges, allChangesIndex);
            setOperationAtIndex(this.filteredChanges, index);
            this.root?.enqueueChangeTree(this, 'filteredChanges');

        } else {
            setOperationAtIndex(this.allChanges, allChangesIndex);
            setOperationAtIndex(this.changes, index);
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
        return this.indexedOperations[index];
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

        const changeSet = (this.filteredChanges !== undefined)
            ? this.filteredChanges
            : this.changes;

        this.indexedOperations[index] = operation ?? OPERATION.DELETE;
        setOperationAtIndex(changeSet, index);
        deleteOperationAtIndex(this.allChanges, allChangesIndex);

        // Dual-write to recorder. recordDelete() adds to dirty but removes
        // from cumulative — matching the legacy delete-from-allChanges behavior.
        this.recorder.recordDelete(index, operation ?? OPERATION.DELETE, this.filteredChanges !== undefined);

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

        //
        // FIXME: this is looking a ugly and repeated
        //
        if (this.filteredChanges !== undefined) {
            deleteOperationAtIndex(this.allFilteredChanges, allChangesIndex);
            this.root?.enqueueChangeTree(this, 'filteredChanges');

        } else {
            this.root?.enqueueChangeTree(this, 'changes');
        }

        return previousValue;
    }

    endEncode(changeSetName: ChangeSetName) {
        this.indexedOperations.length = 0;

        // clear changeset in place
        resetChangeSet(this[changeSetName]);

        // Dual-write: also clear the recorder for this kind.
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

        this.indexedOperations.length = 0;
        resetChangeSet(this.changes);
        this.recorder.reset("changes");

        if (this.filteredChanges !== undefined) {
            resetChangeSet(this.filteredChanges);
            this.recorder.reset("filteredChanges");
        }

        if (discardAll) {
            resetChangeSet(this.allChanges);
            this.recorder.reset("allChanges");

            if (this.allFilteredChanges !== undefined) {
                resetChangeSet(this.allFilteredChanges);
                this.recorder.reset("allFilteredChanges");
            }
        }
    }

    /**
     * Recursively discard all changes from this, and child structures.
     * (Used in tests only)
     */
    discardAll() {
        const ops = this.indexedOperations;
        for (let i = 0; i < ops.length; i++) {
            if (ops[i] === undefined) { continue; }
            const value = this.getValue(i);

            if (value && value[$changes]) {
                value[$changes].discardAll();
            }
        }

        this.discard();
    }

    get changed() {
        // Check if any entries exist in sparse array
        for (let i = 0; i < this.indexedOperations.length; i++) {
            if (this.indexedOperations[i] !== undefined) return true;
        }
        return false;
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

            if (this.filteredChanges !== undefined) {
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

            if (!this.filteredChanges) {
                this.filteredChanges = createChangeSet();
                this.allFilteredChanges = createChangeSet();
            }

            if (this.changes.operations.length > 0) {
                this.changes.operations.forEach((index) =>
                    setOperationAtIndex(this.filteredChanges, index));

                this.allChanges.operations.forEach((index) =>
                    setOperationAtIndex(this.allFilteredChanges, index));

                resetChangeSet(this.changes);
                resetChangeSet(this.allChanges);
            }

            // Mirror promotion in the recorder.
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
