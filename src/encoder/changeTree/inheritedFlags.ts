/**
 * Filter / unreliable / transient / static inheritance helpers for
 * ChangeTree. Called by setRoot / setParent to derive child flags from
 * the parent field's annotation + the parent tree's own state.
 */
import { Metadata } from "../../Metadata.js";
import {
    $changes, $childType,
    $staticFieldIndexes, $streamFieldIndexes,
    $transientFieldIndexes, $viewFieldIndexes,
    // $unreliableFieldIndexes — tree-level unreliable currently disabled
    // (see INHERITABLE_FLAGS comment in ChangeTree.ts). Per-field unreliable
    // routing on primitive fields still uses it via `isFieldUnreliable()`.
} from "../../types/symbols.js";
import type { Schema } from "../../Schema.js";
import {
    INHERITABLE_FLAGS, IS_STATIC, IS_TRANSIENT,
    // IS_UNRELIABLE — tree-level unreliable currently disabled; see
    // INHERITABLE_FLAGS comment in ChangeTree.ts.
    type ChangeTree, type Ref,
} from "../ChangeTree.js";
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
    //
    // Tree-level unreliable is disabled (see INHERITABLE_FLAGS) so the
    // unreliable branch is unreachable today. Kept as a comment for
    // re-enablement.
    if (!tree.has() && !(tree.unreliableRecorder?.has())) {
        // if (tree.isUnreliable) {
        //     tree.root?.enqueueUnreliable(tree);
        // } else {
            tree.root?.enqueueChangeTree(tree);
        // }
    }
}

/**
 * Inherit filter / unreliable / transient / static classification from
 * the parent field's annotation. Collections (MapSchema / ArraySchema /
 * etc.) inherit these from the Schema field that holds them.
 *
 * The common case — fresh tree attached to a parent field that carries
 * none of the inheritable annotations — produces no flag change, no
 * queue update, and no `parentFiltered` hit. Two small structural
 * choices keep that case cheap without any precomputed descriptor
 * bitmask:
 *
 *  1) Flag inheritance is a single bitwise OR onto `tree.flags`. The
 *     three per-annotation reads pack into `fieldBits`, the parent's
 *     inherited bits come from `parentChangeTree.flags` directly; one
 *     read-modify-write replaces three getter/setter cycles, and the
 *     bit diff against `beforeFlags` gives us the "just became static /
 *     unreliable" signal for the side-effect branches.
 *
 *  2) The `parentFiltered` string-key lookup is gated on
 *     `types.hasParentFilteredEntries`, which is only flipped true when
 *     `registerFilteredByParent` actually records an entry — i.e. when
 *     some @view-tagged field reaches this (child, parent, index)
 *     triple through the ancestry walk. Schemas with @view tags only on
 *     sibling fields (not along any attachment chain) skip the string
 *     concat + hash lookup entirely.
 */
export function checkInheritedFlags(tree: ChangeTree, parent: Ref, parentIndex: number): void {
    if (!parent) { return; }

    // Walk up a collection level so `parent` lands on the Schema that
    // owns the field at `parentIndex`. Field annotations live on Schema
    // metadata; collections have none.
    let parentChangeTree: ChangeTree = parent[$changes];
    const parentIsCollection = !Metadata.isValidInstance(parent);
    if (parentIsCollection) {
        parent = parentChangeTree.parent;
        parentIndex = parentChangeTree.parentIndex;
    }

    const parentMetadata: any = (parent as any)?.constructor?.[Symbol.metadata];

    // Flag inheritance — pack the transient/static annotation checks into
    // flag bits alongside the parent's own transitive flags, then OR onto
    // `tree.flags` in one write. The bit diff tells us which flag just
    // went from 0→1, cheaper than the prior `becameX = !tree.isX && (...)`
    // pairs. IS_UNRELIABLE is omitted from both sides — tree-level
    // unreliable is disabled (see INHERITABLE_FLAGS in ChangeTree.ts).
    const fieldBits =
        (parentMetadata?.[$transientFieldIndexes]?.includes(parentIndex) ? IS_TRANSIENT : 0)
        | (parentMetadata?.[$staticFieldIndexes]?.includes(parentIndex) ? IS_STATIC : 0);
    const inheritedBits = (parentChangeTree.flags & INHERITABLE_FLAGS) | fieldBits;
    const beforeFlags = tree.flags;
    tree.flags = beforeFlags | inheritedBits;
    const gainedBits = inheritedBits & ~beforeFlags;

    // If this tree just became static via inheritance, discard any entries
    // that may have been recorded before the parent was assigned (e.g.
    // `new Config().assign({...})` populates the recorder before the
    // Config instance is attached). Static trees ship state via structural
    // walk only; per-tick dirty entries would leak post-first-sync.
    if (gainedBits & IS_STATIC) {
        tree.reset();
        tree.unreliableRecorder?.reset();
    }
    // Tree-level unreliable promotion is disabled — no tree can gain
    // IS_UNRELIABLE via inheritance under the current decoration-time
    // rejection (`Metadata.setUnreliable` on ref-type fields throws). The
    // promotion block used to migrate reliable-recorder entries populated
    // before attach (`new Item().assign({...})` then push into an
    // unreliable collection) over to the unreliable recorder. Kept here
    // as a comment for re-enablement if a safe tree-level unreliable
    // semantics is designed later.
    //
    // else if ((gainedBits & IS_UNRELIABLE) && tree.has()) {
    //     const dst = tree.ensureUnreliableRecorder() as ICollectionChangeRecorder;
    //     tree.forEach((index, op) => {
    //         if (index < 0) dst.recordPure(op);
    //         else dst.record(index, op);
    //     });
    //     tree.reset();
    // }

    // Filter inheritance — only when the type context has any @view or
    // @stream fields registered anywhere.
    const types = tree.root?.types;
    if (!types?.hasFilters) return;

    const fieldHasViewTag = parentMetadata?.[$viewFieldIndexes]?.includes(parentIndex) ?? false;
    // Stream fields are always view-scoped: the stream itself and its
    // child elements must behave as filtered trees. Elements must NOT
    // share visibility with the parent stream — `encodeView`'s priority
    // pass is the only way elements become visible to a view.
    const fieldHasStream = parentMetadata?.[$streamFieldIndexes]?.includes(parentIndex) ?? false;

    // Skip the `parentFiltered` string-key lookup when no class has
    // actually registered filter inheritance via ancestry. The lookup
    // cannot hit in that state, so the string concat + hash lookup would
    // be wasted work every attach.
    let parentFiltered = false;
    const parentConstructor = (parent as any)?.constructor as typeof Schema | undefined;
    if (types.hasParentFilteredEntries && parentConstructor !== undefined) {
        const refType = Metadata.isValidInstance(tree.ref)
            ? tree.ref.constructor
            : (tree.ref as any)[$childType];
        const key = `${types.getTypeId(refType as typeof Schema)}-${types.schemas.get(parentConstructor)}-${parentIndex}`;
        parentFiltered = types.parentFiltered[key] ?? false;
    }

    const newFiltered = parentChangeTree.isFiltered || parentFiltered || fieldHasViewTag || fieldHasStream;
    tree.isFiltered = newFiltered;

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
        // `.stream()`-opted collection (e.g. `MapSchema.stream()`).
        tree.root?.registerStream(tree.ref as any);
    }

    if (newFiltered) {
        const refType = Metadata.isValidInstance(tree.ref)
            ? tree.ref.constructor
            : (tree.ref as any)[$childType];
        // #218: nested Schema fields inherit visibility from a @view-gated
        // parent regardless of whether the parent is a collection. The
        // `parentIsCollection` constraint that used to live here blocked
        // nested-Schema-field-of-@view-tagged-Schema from sharing visibility,
        // forcing users to wrap the child in an ArraySchema as a workaround.
        tree.isVisibilitySharedWithParent = (
            parentChangeTree.isFiltered
            && typeof refType !== "string"
            && !fieldHasViewTag
            && !fieldHasStream
        );
    }
}
