/**
 * Filter / unreliable / transient / static inheritance helpers for
 * ChangeTree. Called by setRoot / setParent to derive child flags from
 * the parent field's annotation + the parent tree's own state.
 */
import { Metadata } from "../../Metadata.js";
import { $changes, $childType } from "../../types/symbols.js";
import type { Schema } from "../../Schema.js";
import type { ChangeTree, Ref } from "../ChangeTree.js";

/**
 * Reconcile queue membership + inherited flags for a tree that just had
 * its root/parent assigned. See `_checkInheritedFlags` for the flag
 * inheritance logic.
 */
export function checkIsFiltered(
    tree: ChangeTree,
    parent: Ref,
    parentIndex: number,
    _isNewChangeTree: boolean,
): void {
    checkInheritedFlags(tree, parent, parentIndex);

    // Static trees never track per-tick changes — skip the queue entirely.
    // Full-sync reaches them via structural walk (forEachChild).
    if (tree.isStatic) return;

    // Mutations that happened before setRoot (e.g. class-field initializers)
    // recorded into the appropriate recorder but couldn't enqueue yet.
    // Reconcile both queues now.
    if (tree.has()) {
        tree.root?.enqueueChangeTree(tree);
    }
    if (tree.unreliableRecorder?.has()) {
        tree.root?.enqueueUnreliable(tree);
    }
    // Fresh tree with nothing recorded: still enqueue into its primary
    // queue so the tree is reachable for its first mutation cycle.
    if (!tree.has() && !(tree.unreliableRecorder?.has())) {
        if (tree.isUnreliable) {
            tree.root?.enqueueUnreliable(tree);
        } else {
            tree.root?.enqueueChangeTree(tree);
        }
    }
}

/**
 * Inherit filter / unreliable / transient / static classification from
 * the parent field's annotation. Collections (MapSchema / ArraySchema /
 * etc.) inherit these from the Schema field that holds them.
 */
export function checkInheritedFlags(tree: ChangeTree, parent: Ref, parentIndex: number): void {
    if (!parent) { return; }

    //
    // ArraySchema | MapSchema - get the child type
    // (if refType is typeof string, the parentFiltered[key] below will always be invalid)
    //
    const refType = Metadata.isValidInstance(tree.ref)
        ? tree.ref.constructor
        : (tree.ref as any)[$childType];

    let parentChangeTree: ChangeTree;

    let parentIsCollection = !Metadata.isValidInstance(parent);
    if (parentIsCollection) {
        parentChangeTree = parent[$changes];
        parent = parentChangeTree.parent;
        parentIndex = parentChangeTree.parentIndex;

    } else {
        parentChangeTree = parent[$changes]
    }

    const parentConstructor = parent?.constructor as typeof Schema;
    const parentMetadata = parentConstructor?.[Symbol.metadata];

    // Unreliable/transient/static inheritance — from parent schema's field annotation.
    const fieldIsUnreliable = Metadata.hasUnreliableAtIndex(parentMetadata, parentIndex);
    const fieldIsTransient = Metadata.hasTransientAtIndex(parentMetadata, parentIndex);
    const fieldIsStatic = Metadata.hasStaticAtIndex(parentMetadata, parentIndex);
    const becameUnreliable = !tree.isUnreliable && (parentChangeTree.isUnreliable || fieldIsUnreliable);
    const becameStatic = !tree.isStatic && (parentChangeTree.isStatic || fieldIsStatic);
    tree.isUnreliable = parentChangeTree.isUnreliable || fieldIsUnreliable;
    tree.isTransient = parentChangeTree.isTransient || fieldIsTransient;
    tree.isStatic = parentChangeTree.isStatic || fieldIsStatic;

    // If this tree just became static via inheritance, discard any
    // entries that may have been recorded before the parent was
    // assigned (e.g. `new Config().assign({...})` populates the
    // recorder before the Config instance is attached to its parent).
    // Static trees ship their state via structural walk only; any
    // per-tick dirty state is moot and would leak post-first-sync.
    if (becameStatic) {
        tree.reset();
        tree.unreliableRecorder?.reset();
    }
    // If this tree just became unreliable via inheritance AND it already
    // has entries in the reliable recorder (recorded before the parent
    // was assigned — e.g. `new Item().assign({...})` populates item's
    // recorder before it's pushed into an unreliable collection),
    // promote them to the unreliable recorder.
    else if (becameUnreliable && tree.has()) {
        const dst = tree.ensureUnreliableRecorder();
        tree.forEach((index, op) => {
            if (index < 0) dst.recordPure(op);
            else dst.record(index, op);
        });
        tree.reset();
    }

    // Filtered inheritance — only run the expensive lookup when the root
    // context has filters at all.
    if (!tree.root?.types.hasFilters) return;

    let key = `${tree.root.types.getTypeId(refType as typeof Schema)}`;
    if (parentConstructor) {
        key += `-${tree.root.types.schemas.get(parentConstructor)}`;
    }
    key += `-${parentIndex}`;

    const fieldHasViewTag = Metadata.hasViewTagAtIndex(parentMetadata, parentIndex);

    tree.isFiltered = parentChangeTree.isFiltered
        || tree.root.types.parentFiltered[key]
        || fieldHasViewTag;

    if (tree.isFiltered) {
        tree.isVisibilitySharedWithParent = (
            parentChangeTree.isFiltered &&
            typeof (refType) !== "string" &&
            !fieldHasViewTag &&
            parentIsCollection
        );
    }
}
