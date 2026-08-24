/**
 * Filter / unreliable / patchOnly / static inheritance helpers for
 * ChangeTree. Called by setRoot / setParent to derive child flags from
 * the parent field's annotation + the parent tree's own state.
 */
import { Metadata } from "../../Metadata.js";
import { DEFAULT_VIEW_TAG } from "../../annotations.js";
import {
    $changes, $childType,
    $fullStateOnlyFieldIndexes, $streamFieldIndexes,
    $patchOnlyFieldIndexes, $viewFieldIndexes,
    // $unreliableFieldIndexes — tree-level unreliable currently disabled
    // (see INHERITABLE_FLAGS comment in ChangeTree.ts). Per-field unreliable
    // routing on primitive fields still uses it via `isFieldUnreliable()`.
} from "../../types/symbols.js";
import {
    INHERITABLE_FLAGS, IS_FULL_STATE_ONLY, IS_PATCH_ONLY, PENDING_FILTER_REFRESH,
    // IS_UNRELIABLE — tree-level unreliable currently disabled; see
    // INHERITABLE_FLAGS comment in ChangeTree.ts.
    type ChangeTree, type Ref,
} from "../ChangeTree.js";
import type { ICollectionChangeRecorder } from "../ChangeRecorder.js";
import type { Root, Streamable } from "../Root.js";
import { ensureStreamState } from "../streaming.js";
import { restageLiveCb } from "./liveIteration.js";
import { isEdgeLive } from "./parentChain.js";

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
    if (tree.isFullStateOnly) return;

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
 * Inherit filter / unreliable / patchOnly / static classification from
 * the parent field's annotation. Collections (MapSchema / ArraySchema /
 * etc.) inherit these from the Schema field that holds them.
 *
 * The common case — fresh tree attached to a parent field that carries
 * none of the inheritable annotations — produces no flag change and no
 * queue update. Flag inheritance is a single bitwise OR onto
 * `tree.flags`: the per-annotation reads pack into `fieldBits`, the
 * parent's inherited bits come from `parentChangeTree.flags` directly,
 * and one read-modify-write replaces three getter/setter cycles. The bit
 * diff against `beforeFlags` gives the "just became static / unreliable"
 * signal for the side-effect branches.
 */
export function checkInheritedFlags(tree: ChangeTree, parent: Ref, parentIndex: number): void {
    if (!parent) { return; }

    // Walk up a collection level so `parent` lands on the Schema that
    // owns the field at `parentIndex`. Field annotations live on Schema
    // metadata; collections have none.
    const parentChangeTree: ChangeTree = parent[$changes];
    const parentIsCollection = !parentChangeTree._isSchema;
    let parentMetadata: any;
    if (parentIsCollection) {
        parent = parentChangeTree.parent;
        parentIndex = parentChangeTree.parentIndex;
        parentMetadata = parent?.[$changes].metadata;
    } else {
        parentMetadata = parentChangeTree.metadata;
    }

    // Flag inheritance — pack the patchOnly/static annotation checks into
    // flag bits alongside the parent's own transitive flags, then OR onto
    // `tree.flags` in one write. The bit diff tells us which flag just
    // went from 0→1, cheaper than the prior `becameX = !tree.isX && (...)`
    // pairs. IS_UNRELIABLE is omitted from both sides — tree-level
    // unreliable is disabled (see INHERITABLE_FLAGS in ChangeTree.ts).
    const fieldBits =
        (parentMetadata?.[$patchOnlyFieldIndexes]?.includes(parentIndex) ? IS_PATCH_ONLY : 0)
        | (parentMetadata?.[$fullStateOnlyFieldIndexes]?.includes(parentIndex) ? IS_FULL_STATE_ONLY : 0);
    const inheritedBits = (parentChangeTree.flags & INHERITABLE_FLAGS) | fieldBits;
    const beforeFlags = tree.flags;
    tree.flags = beforeFlags | inheritedBits;
    const gainedBits = inheritedBits & ~beforeFlags;

    // If this tree just became static via inheritance, discard any entries
    // that may have been recorded before the parent was assigned (e.g.
    // `new Config().assign({...})` populates the recorder before the
    // Config instance is attached). Static trees ship state via structural
    // walk only; per-tick dirty entries would leak post-first-sync.
    if (gainedBits & IS_FULL_STATE_ONLY) {
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

    // Filtering is a property of the *attachment*, never of the child class:
    // the same Schema class may sit under a @view field here and under a
    // public field there (#204). `parentChangeTree.isFiltered` carries the
    // ancestry — `setRoot` derives it parent-first before recursing — so the
    // field annotation only has to answer for this one edge.
    const newFiltered = parentChangeTree.isFiltered || fieldHasViewTag || fieldHasStream;
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
        const sharesEligible = _sharesEligible(tree);
        // #218: nested Schema fields inherit visibility from a @view-gated
        // parent regardless of whether the parent is a collection. The
        // `parentIsCollection` constraint that used to live here blocked
        // nested-Schema-field-of-@view-tagged-Schema from sharing visibility,
        // forcing users to wrap the child in an ArraySchema as a workaround.
        //
        // #226 (4.0.25): items inside a non-default-tag `@view(N)` collection
        // also inherit visibility from the parent collection, so items
        // pushed/set after `view.add(state, N)` show up automatically.
        // Default-tag `@view()` collections keep per-item gating —
        // `view.add(item)` is still required to opt each one in.
        // The `parentMetadata[parentIndex].tag` access is safe inside the
        // `fieldHasViewTag` short-circuit (the metadata entry and its `tag`
        // are guaranteed to exist when that flag is set).
        tree.isVisibilitySharedWithParent = (
            parentChangeTree.isFiltered
            && sharesEligible
            && !fieldHasStream
            && (!fieldHasViewTag || (parentIsCollection && parentMetadata[parentIndex].tag !== DEFAULT_VIEW_TAG))
        );
    }
}

// ────────────────────────────────────────────────────────────────────────
// Per-edge filter refresh — instance sharing across a @view boundary.
//
// `checkIsFiltered` classifies a tree from the edge it was FIRST attached
// through. A shared instance has N parent edges with different visibility,
// and the wire emits field data per-refId per-channel — so the tree-level
// invariant is:
//
//     isFiltered  ⇔  no fully-public root path reaches this tree
//
// Rather than reconciling eagerly at every attach/detach (whose ordering
// against the container's own storage mutation is fragile), edge events
// call `Root.enqueueFilterRefresh` and the encoder re-derives the flags at
// the top of the next encode — after every container mutation of the tick
// has settled — via `drainFilterRefresh`. `isFiltered` is only CONSUMED at
// encode time (recording is channel-agnostic), so the deferral is safe for
// wire routing; only same-tick StateView bootstrap reads see the stale
// flags, which at worst emits redundant (deduped) entries.
// ────────────────────────────────────────────────────────────────────────

/**
 * Drain `root.pendingFilterRefresh`. Called by the encoder before any
 * emission (per-tick channels and full-sync).
 */
export function drainFilterRefresh(root: Root): void {
    const list = root.pendingFilterRefresh;
    for (let i = 0; i < list.length; i++) {
        const tree = list[i];
        // Already settled as another entry's parent, or detached/recycled
        // since it was queued.
        if ((tree.flags & PENDING_FILTER_REFRESH) === 0) continue;
        refreshFilterState(tree);
    }
    list.length = 0;
}

/**
 * Primitive-element collections never share visibility downward. One
 * predicate for both derivations (`checkInheritedFlags` and
 * `refreshFilterState`) — the InstanceSharing invariant test pins them
 * together. `_isSchema` short-circuits the `$childType` probe for Schema
 * trees (whose `$childType` is undefined and would pass anyway).
 */
function _sharesEligible(tree: ChangeTree): boolean {
    return tree._isSchema || typeof (tree.refTarget as any)[$childType] !== "string";
}

/**
 * Re-derive `isFiltered` (AND over live edges) and
 * `isVisibilitySharedWithParent` (OR over live edges) from the parent
 * chain. On a filtered→public flip, live state is re-staged — it may have
 * already drained to view channels only, and clients that hold it decode
 * the duplicate ADDs as no-ops (StateView bootstrap re-adds rely on the
 * same property). The public→filtered flip needs no re-stage: the public
 * container's DELETE already ships on the shared channel.
 *
 * A flip cascades into children so classifications inherited through this
 * tree follow it; re-derivation is idempotent and a child that does not
 * flip does not recurse, so the walk terminates on cyclic instance graphs.
 */
function refreshFilterState(tree: ChangeTree): void {
    tree.flags &= ~PENDING_FILTER_REFRESH;
    const root = tree.root;
    if (root === undefined || tree.parentRef === undefined) return;

    const sharesEligible = _sharesEligible(tree);

    let bits = _edgeBits(tree, tree.parentRef, tree._parentIndex, sharesEligible);
    // Saturated means no further edge can change the outcome.
    for (let e = tree.extraParents; e !== undefined && bits !== EDGE_SATURATED; e = e.next) {
        bits |= _edgeBits(tree, e.ref, e.index, sharesEligible);
    }

    // No live edge resolved (mid-detach churn) — keep the current
    // classification rather than guess.
    if (bits === 0) return;

    tree.isVisibilitySharedWithParent = (bits & EDGE_SHARES) !== 0;

    const newFiltered = (bits & EDGE_PUBLIC) === 0;
    if (newFiltered === tree.isFiltered) return;
    tree.isFiltered = newFiltered;

    // Became public: clients that only ever had the view channel never saw
    // this state. Static trees ship via structural walk instead.
    if (!newFiltered && !tree.isFullStateOnly) {
        tree.forEachLiveWithCtx(tree, restageLiveCb);
        if (tree.has()) root.enqueueChangeTree(tree);
        if (tree.unreliableRecorder?.has()) root.enqueueUnreliable(tree);
    }

    tree.forEachChildWithCtx(tree, _cascadeRefreshCb);
}

const EDGE_LIVE = 1, EDGE_PUBLIC = 2, EDGE_SHARES = 4;
const EDGE_SATURATED = EDGE_LIVE | EDGE_PUBLIC | EDGE_SHARES;

/**
 * Classify one parent edge: is it live, does it make the tree publicly
 * reachable, does view visibility flow through it.
 */
function _edgeBits(tree: ChangeTree, parentRef: Ref, index: number, sharesEligible: boolean): number {
    const parentTree: ChangeTree = parentRef[$changes];
    if (parentTree.root !== tree.root || !isEdgeLive(tree, parentTree, index)) return 0;

    // A queued parent must settle first — this edge reads its `isFiltered`.
    // The flag-clear on entry terminates cycles, and a cascade re-entering
    // `tree` is idempotent (same edges, same result — the outer pass then
    // sees "no change").
    if (parentTree.flags & PENDING_FILTER_REFRESH) refreshFilterState(parentTree);

    let bits = EDGE_LIVE;
    if (parentTree._isSchema) {
        // A @view/stream-marked field stays filtered even under a public
        // parent, and never shares visibility downward.
        const marked = parentTree.encDescriptor.tags[index] !== undefined
            || parentTree.isFieldStream(index);
        if (!marked) {
            if (!parentTree.isFiltered) bits |= EDGE_PUBLIC;
            else if (sharesEligible) bits |= EDGE_SHARES;
        }
    } else if (!parentTree.isFiltered) {
        // Collection edge: the collection's own classification already
        // folds in the field that holds it.
        bits |= EDGE_PUBLIC;
    } else if (sharesEligible && !parentTree.isStreamCollection) {
        // #226: default-tag @view() collections keep per-item gating;
        // untagged and non-default-tag @view(N) ones share.
        const gp = parentTree.parent?.[$changes];
        const tag = gp?._isSchema ? gp.encDescriptor.tags[parentTree.parentIndex] : undefined;
        if (tag !== DEFAULT_VIEW_TAG) bits |= EDGE_SHARES;
    }
    return bits;
}

const _cascadeRefreshCb = (_parentTree: ChangeTree, child: ChangeTree, _index: any): void => {
    refreshFilterState(child);
};
