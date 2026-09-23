/**
 * Tree-attachment helpers: setRoot / setParent + child-iteration recursion.
 * Hot path: every new Schema/Collection instance attached to the root
 * goes through here, which is why the recursive walk uses a hoisted
 * callback + ctx-pool instead of per-call closures.
 */
import { $childType, $proxyTarget, $refTypeFieldIndexes } from "../../types/symbols.js";
import { KIND_ARRAY, KIND_MAP, KIND_SCHEMA } from "../../encoding/spec.js";
import { Root } from "../Root.js";
import { ChangeTree, type Ref, refTreeOf, setTree } from "../ChangeTree.js";
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
    parentTree?: ChangeTree,
): void {
    tree.addParent(parent, parentIndex, parentTree);

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
    // Handed in by the caller, or recorded by `addParent` above when `parent` is
    // the primary parent; a 2nd+ parent of a shared instance is derived from the ref.
    if (parentTree === undefined) {
        const primary = tree.parentTree;
        parentTree = (primary !== undefined && primary.ref === parent) ? primary : refTreeOf(parent);
    }
    if (
        parentTree !== undefined &&
        parentTree.aux?.subscribedViews !== undefined &&
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
            ctx = { parentRef: undefined!, parentTree: undefined!, root: undefined! };
            _setParentCtxPool[_setParentDepth] = ctx;
        }
        ctx.parentRef = tree.ref;
        ctx.parentTree = tree;
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
 * tree, so a per-call closure would be a hotspot. Pass an explicit `ctx` so callers can hoist the callback to module
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
    // skips the ArraySchema Proxy on every lookup below — hot during the
    // encodeAll DFS walk which touches every ArraySchema in the tree.
    const ref = tree.refTarget as any;
    const kind = tree.encDescriptor.kind;
    if (kind !== KIND_SCHEMA) {
        if (typeof ref[$childType] !== "string") {
            if (kind === KIND_ARRAY) {
                // ArraySchema: dense index loop over the element storage.
                const els = tree.refTarget as any[];
                for (let i = 0, len = els.length; i < len; i++) {
                    const value = els[i];
                    if (!value) { continue; }
                    callback(ctx, refTreeOf(value), i);
                }
            } else if (kind === KIND_MAP) {
                // MapSchema: the child's index is its wire index.
                const $items = ref.$items as Map<any, any>;
                const indexByKey = ref.indexByKey as Map<any, number>;
                for (const [key, value] of $items) {
                    if (!value) { continue; }
                    callback(ctx, refTreeOf(value), indexByKey.get(key));
                }
            } else {
                // SetSchema / CollectionSchema / StreamSchema: keyed by wire index.
                for (const [index, value] of ref.$items as Map<number, any>) {
                    if (!value) { continue; }
                    callback(ctx, refTreeOf(value), index);
                }
            }
        }
    } else {
        const metadata = tree.encDescriptor.metadata;
        const indexes = metadata?.[$refTypeFieldIndexes];
        if (!indexes) return;
        const names = tree.encDescriptor.names;
        const values = tree.values;
        for (let i = 0, len = indexes.length; i < len; i++) {
            const index = indexes[i];
            // The tree's `$values` slot first — `ref[name]` is a megamorphic
            // keyed load that lands in the field's getter. Named fallback:
            // manual fields skip `$values` (same rule as `readSchemaValue`).
            const value = (values !== undefined ? values[index] : undefined) ?? ref[names[index]];
            if (!value) { continue; }
            callback(ctx, refTreeOf(value), index);
        }
    }
}

// Hoisted callbacks used by setRoot / setParent to avoid per-call
// closure allocation in the recursive attach path.

/**
 * A decoder-built instance carries an `UntrackedChangeTree` stub. Attaching
 * it to an encoder (re-encoding a decoded state) upgrades the stub to a real
 * tree on the spot; the live walk then covers it like any other instance.
 * Index writes on a decoder-built ArraySchema stay untracked (no Proxy).
 */
function ensureTracked(child: ChangeTree): ChangeTree {
    if (child instanceof ChangeTree) return child;
    const ref: any = (child as any).ref;
    const target = ref[$proxyTarget] ?? ref;
    const real = new ChangeTree(ref, target);
    real.refId = (child as any).refId; // keep the decoder-assigned identity
    setTree(target, real);
    return real;
}

function _setRootChildCb(root: Root, child: ChangeTree, _index: any): void {
    child = ensureTracked(child);
    if (child.root !== root) {
        child.setRoot(root);
    } else {
        root.add(child); // increment refCount
    }
}

interface SetParentCtx { parentRef: Ref; parentTree: ChangeTree; root: Root; }
// Pool of ctx objects, indexed by setParent recursion depth. Grows to
// max depth seen (typically tree height = 3-5 in bench), then stays put.
const _setParentCtxPool: SetParentCtx[] = [];
let _setParentDepth = 0;

function _setParentChildCb(ctx: SetParentCtx, child: ChangeTree, index: any): void {
    child = ensureTracked(child);
    if (child.root === ctx.root) {
        ctx.root.add(child);
        ctx.root.moveNextToParent(child);
        return;
    }
    child.setParent(ctx.parentRef, ctx.root, index, ctx.parentTree);
}
