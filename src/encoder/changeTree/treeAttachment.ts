/**
 * Tree-attachment helpers: setRoot / setParent + child-iteration recursion.
 * Hot path: every new Schema/Collection instance attached to the root
 * goes through here, which is why the recursive walk uses a hoisted
 * callback + ctx-pool instead of per-call closures.
 */
import { $changes, $childType, $refTypeFieldIndexes } from "../../types/symbols.js";
import { Root } from "../Root.js";
import type { ChangeTree, Ref } from "../ChangeTree.js";
import { checkIsFiltered } from "./inheritedFlags.js";
import { propagateNewChildToSubscribers } from "../subscriptions.js";

export function setRoot(tree: ChangeTree, root: Root): void {
    tree.root = root;

    const isNewChangeTree = root.add(tree);

    checkIsFiltered(tree, tree.parent, tree.parentIndex, isNewChangeTree);

    // Recursively set root on child structures (closure-free hot path).
    if (isNewChangeTree) {
        forEachChildWithCtx(tree, root, _setRootChildCb);
    }
}

export function setParent(
    tree: ChangeTree,
    parent: Ref,
    root?: Root,
    parentIndex?: number,
): void {
    tree.addParent(parent, parentIndex);

    // avoid setting parents with empty `root`
    if (!root) { return; }

    const isNewChangeTree = root.add(tree);

    // skip if parent is already set
    if (root !== tree.root) {
        tree.root = root;
        checkIsFiltered(tree, parent, parentIndex, isNewChangeTree);
    }

    // Persistent-subscription propagation — when this new child is being
    // attached to a collection that has one or more subscribed views,
    // force-ship (or enqueue, for streams) the new child to each of them.
    // Gated by `parent` being a collection (not a Schema) and the parent
    // tree having a non-empty `subscribedViews` bitmap; both common-case
    // short circuits are cheap.
    const parentTree = parent?.[$changes];
    if (
        parentTree !== undefined &&
        parentTree.subscribedViews !== undefined &&
        // Collection check: `$childType` on the ref identifies Array/Map/
        // Set/Collection/Stream. Schema-field parents don't have it.
        (parent as any)[$childType] !== undefined
    ) {
        propagateNewChildToSubscribers(parentTree, parentIndex!, tree.ref, root);
    }

    // assign same parent on child structures (closure-free hot path).
    // setParent recurses, so each depth gets its own ctx from a pool
    // that grows to the recursion depth (typically tree height = 3-5).
    if (isNewChangeTree) {
        let ctx = _setParentCtxPool[_setParentDepth];
        if (ctx === undefined) {
            ctx = { parentRef: undefined!, root: undefined! };
            _setParentCtxPool[_setParentDepth] = ctx;
        }
        ctx.parentRef = tree.ref;
        ctx.root = root;
        _setParentDepth++;
        forEachChildWithCtx(tree, ctx, _setParentChildCb);
        _setParentDepth--;
    }
}

export function forEachChild(
    tree: ChangeTree,
    callback: (change: ChangeTree, at: any) => void,
): void {
    forEachChildWithCtx(tree, callback, _forEachChildTrampoline);
}

function _forEachChildTrampoline(cb: (change: ChangeTree, at: any) => void, change: ChangeTree, at: any): void {
    cb(change, at);
}

/**
 * Closure-free variant of {@link forEachChild}. Hot setRoot / setParent
 * recursion calls this once per new Schema instance attached to the
 * tree — the per-call closure was the #1 JS hotspot in profile-baseline.
 * Pass an explicit `ctx` so callers can hoist the callback to module
 * scope and avoid the allocation.
 */
export function forEachChildWithCtx<C>(
    tree: ChangeTree,
    ctx: C,
    callback: (ctx: C, change: ChangeTree, at: any) => void,
): void {
    // `refTarget` is the raw backing instance — identical to `ref` for all
    // non-Proxy types (Schema / Map / Set / Collection / Stream), and the
    // un-wrapped `$proxyTarget` for ArraySchema. Reading through it here
    // skips the ArraySchema Proxy `get` trap on every `$childType`,
    // `_collectionIndexes`, `.entries()`, `.items` lookup below — hot during
    // the encodeAll DFS walk which touches every ArraySchema in the tree.
    const ref = tree.refTarget as any;
    if (ref[$childType]) {
        if (typeof ref[$childType] !== "string") {
            const items = ref.items;
            if (items !== undefined) {
                // ArraySchema (raw target): dense index loop — the previous
                // `for..of entries()` allocated an iterator + a [key, value]
                // pair array per child (top-10 allocation site in the
                // stateview and deep-nested heap profiles).
                for (let i = 0, len = items.length; i < len; i++) {
                    const value = items[i];
                    if (!value) { continue; } // sparse arrays can have undefined values
                    callback(ctx, value[$changes], i);
                }
            } else {
                // Map-backed collections (MapSchema/SetSchema/CollectionSchema/
                // StreamSchema all store `$items: Map`): keys() loop skips the
                // per-child [key, value] pair arrays of entries(), with no
                // closure either (a forEach closure showed up as a GC
                // regression on the construct bench).
                const $items = ref.$items as Map<any, any>;
                const collectionIndexes = ref._collectionIndexes;
                for (const key of $items.keys()) {
                    const value = $items.get(key);
                    if (!value) { continue; }
                    callback(ctx, value[$changes], collectionIndexes?.[key] ?? key);
                }
            }
        }
    } else {
        const metadata = tree.metadata;
        const indexes = metadata?.[$refTypeFieldIndexes];
        if (!indexes) return;
        const names = tree.encDescriptor.names;
        for (let i = 0, len = indexes.length; i < len; i++) {
            const index = indexes[i];
            const value = ref[names[index]];
            if (!value) { continue; }
            callback(ctx, value[$changes], index);
        }
    }
}

// Hoisted callbacks used by setRoot / setParent to avoid per-call
// closure allocation in the recursive attach path.

function _setRootChildCb(root: Root, child: ChangeTree, _index: any): void {
    if (child.root !== root) {
        child.setRoot(root);
    } else {
        root.add(child); // increment refCount
    }
}

interface SetParentCtx { parentRef: Ref; root: Root; }
// Pool of ctx objects, indexed by setParent recursion depth. Grows to
// max depth seen (typically tree height = 3-5 in bench), then stays put.
const _setParentCtxPool: SetParentCtx[] = [];
let _setParentDepth = 0;

function _setParentChildCb(ctx: SetParentCtx, child: ChangeTree, index: any): void {
    if (child.root === ctx.root) {
        ctx.root.add(child);
        ctx.root.moveNextToParent(child);
        return;
    }
    child.setParent(ctx.parentRef, ctx.root, index);
}
