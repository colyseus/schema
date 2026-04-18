/**
 * Filter / unreliable / transient / static inheritance helpers for
 * ChangeTree. Called by setRoot / setParent to derive child flags from
 * the parent field's annotation + the parent tree's own state.
 */
import { Metadata } from "../../Metadata.js";
import { $changes, $childType } from "../../types/symbols.js";
import type { Schema } from "../../Schema.js";
import type { ChangeTree, Ref } from "../ChangeTree.js";
import type { ICollectionChangeRecorder } from "../ChangeRecorder.js";
import type { Streamable } from "../Root.js";
import { ensureStreamState } from "../streaming.js";

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
        // Pure ops (index < 0) only come from collection trees — and a
        // collection tree's unreliable recorder is a CollectionChangeRecorder.
        const dst = tree.ensureUnreliableRecorder() as ICollectionChangeRecorder;
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
    // Stream fields are always view-scoped: the stream itself and its
    // child elements must behave as filtered trees. Elements must NOT
    // share visibility with the parent stream — `encodeView`'s priority
    // pass is the only way elements become visible to a view.
    const fieldHasStream = Metadata.hasStreamAtIndex(parentMetadata, parentIndex);

    tree.isFiltered = parentChangeTree.isFiltered
        || tree.root.types.parentFiltered[key]
        || fieldHasViewTag
        || fieldHasStream;

    // Flag collection trees attached to a `.stream()` field so the encoder
    // routes their emission through the priority/broadcast pass. Applies
    // when the tree IS the collection (not the collection's parent
    // structure walk above). `parentIsCollection` was true at entry iff
    // `tree.ref` is a child-of-collection (e.g. stream element) — we only
    // set the flag on the collection itself, not its elements.
    if (fieldHasStream && !parentIsCollection) {
        tree.isStreamCollection = true;
        // Allocate the lazy `_stream` slot once, here — so downstream
        // helpers (`streamRouteAdd`, `_emitStreamPriority`, …) never need
        // a null-check. `_stream` was always declared on the class at
        // `undefined`, so this is a value write, not a shape transition.
        const state = ensureStreamState(tree.ref as unknown as Streamable);
        // Seed the priority callback from the schema declaration (builder's
        // `.priority(fn)` or decorator's `{ stream: X, priority: fn }`).
        // Instance-level overrides via `stream.priority = ...` win — only
        // assign if the instance slot hasn't already been set.
        if (state.priority === undefined) {
            const declared = Metadata.getStreamPriority(parentMetadata, parentIndex);
            if (declared !== undefined) state.priority = declared;
        }
        // Auto-register with `root.streamTrees` so the encoder's priority /
        // broadcast pass picks it up. Covers both `StreamSchema` and any
        // `.stream()`-opted collection (e.g. MapSchema.stream()).
        if (tree.root !== undefined) {
            tree.root.registerStream(tree.ref as any);
        }
    }

    if (tree.isFiltered) {
        tree.isVisibilitySharedWithParent = (
            parentChangeTree.isFiltered &&
            typeof (refType) !== "string" &&
            !fieldHasViewTag &&
            !fieldHasStream &&
            parentIsCollection
        );
    }
}
