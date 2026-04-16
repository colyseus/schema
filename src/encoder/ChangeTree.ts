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

export type ChangeSetName = "changes" | "filteredChanges";

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
     * bit 3: hasFilteredChanges (tree tracks filtered changes in its recorder)
     */
    flags: number = IS_NEW; // default: isNew=true

    /**
     * Unified change-tracking abstraction — the single source of truth for
     * current-tick changes on this tree. Full-sync snapshots (encodeAll,
     * StateView.add of an existing instance) are derived by walking the
     * live ref structure via {@link forEachLive}, not from the recorder.
     */
    recorder: ChangeRecorder;

    /**
     * When true, mutations on the associated ref are NOT tracked.
     * See `pause()` / `resume()` / `untracked(fn)`.
     */
    paused: boolean = false;

    // Direct queue-node refs. Set by Root.addToChangeTreeList / cleared by
    // endEncode / removeChangeFromChangeSet.
    changesNode?: ChangeTreeNode;
    filteredChangesNode?: ChangeTreeNode;

    getQueueNode(name: ChangeSetName): ChangeTreeNode | undefined {
        switch (name) {
            case "changes": return this.changesNode;
            case "filteredChanges": return this.filteredChangesNode;
        }
    }

    setQueueNode(name: ChangeSetName, node: ChangeTreeNode | undefined): void {
        switch (name) {
            case "changes": this.changesNode = node; break;
            case "filteredChanges": this.filteredChangesNode = node; break;
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

        const isSchema = Metadata.isValidInstance(ref);
        if (isSchema) {
            const numFields = (this.metadata?.[$numFields] ?? 0) as number;
            this.recorder = new SchemaChangeRecorder(numFields);
        } else {
            this.recorder = new CollectionChangeRecorder();
        }

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

    /**
     * Walk all currently-populated indexes on this tree, emitting each index
     * once. Used by Root.add (re-stage), Encoder.encodeAll, and StateView.add
     * to derive full-sync output from the live structure rather than from a
     * maintained cumulative bucket.
     *
     * - Schema: walks metadata fields 0..$numFields, emits indexes where
     *   `ref[field.name] !== undefined`.
     * - ArraySchema: walks `items`, emits indexes where the slot is defined.
     * - MapSchema: walks the journal's index→key map, emits indexes whose
     *   key is still present in `$items`.
     * - SetSchema / CollectionSchema: walks `$items.keys()` (the key IS the
     *   wire index).
     */
    forEachLive(callback: (index: number) => void): void {
        const ref = this.ref as any;

        if (ref[$childType] !== undefined) {
            // Collection types: dispatch by shape.
            if (Array.isArray(ref.items)) {
                // ArraySchema
                const items = ref.items as any[];
                for (let i = 0, len = items.length; i < len; i++) {
                    if (items[i] !== undefined) callback(i);
                }
            } else if (ref.journal !== undefined) {
                // MapSchema
                for (const [index, key] of ref.journal.keyByIndex as Map<number, any>) {
                    if (ref.$items.has(key)) callback(index);
                }
            } else if (ref.$items !== undefined) {
                // SetSchema / CollectionSchema (key === wire index)
                for (const index of (ref.$items as Map<number, any>).keys()) {
                    callback(index);
                }
            }
        } else {
            // Schema: walk declared fields. `null` is treated as absent —
            // the setter records a DELETE when a field is set to null or
            // undefined, so it should not appear in full-sync output.
            const metadata = this.metadata;
            if (!metadata) return;
            const numFields = (metadata[$numFields] ?? -1) as number;
            for (let i = 0; i <= numFields; i++) {
                const field = metadata[i as any];
                if (field === undefined) continue;
                const value = ref[field.name];
                if (value !== undefined && value !== null) callback(i);
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
            this.root?.enqueueChangeTree(this, 'filteredChanges');
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

    indexedOperation(index: number, operation: OPERATION) {
        if (this.paused) return;

        this.recorder.recordRaw(index, operation, this.hasFilteredChanges);

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

    delete(index: number, operation?: OPERATION) {
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

        this.recorder.recordDelete(index, operation ?? OPERATION.DELETE, this.hasFilteredChanges);

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

    discard() {
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
            }
        }

        if (!this.isFiltered) {
            this.root?.enqueueChangeTree(this, 'changes');
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

            // Promote any current-tick entries recorded before this tree was
            // known to be filtered into the filtered bucket.
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
