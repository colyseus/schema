/**
 * Tree-attachment helpers: setRoot / setParent + child-iteration recursion.
 * Hot path: every new Schema/Collection instance attached to the root
 * goes through here, which is why the recursive walk uses a hoisted
 * callback + ctx-pool instead of per-call closures.
 */
import { $elements, $childType } from "../../types/symbols.js";
import { fieldOf } from "../EncodeDescriptor.js";
import { KIND_ARRAY, KIND_MAP, KIND_SCHEMA } from "../../encoding/spec.js";
import { Root, type Streamable } from "../Root.js";
import { ChangeTree, type Ref, refTreeOf, setTree } from "../ChangeTree.js";
import { checkIsFiltered } from "./inheritedFlags.js";
import { clearParents, hasParentTree } from "./parentChain.js";
import { propagateNewChildToSubscribers } from "../subscriptions.js";

export function setRoot(tree: ChangeTree, root: Root): void {
    if (tree.root !== undefined && tree.root !== root) adoptTree(tree, root);
    tree.root = root;

    const isNewChangeTree = root.add(tree);

    checkIsFiltered(tree, tree.parent, tree.parentIndex, isNewChangeTree);

    // Recursively set root on child structures (closure-free hot path).
    if (isNewChangeTree) {
        forEachChildWithCtx(tree, tree, _setRootChildCb);
    }
}

/**
 * A tree moving to another Encoder's Root (`room.state = state` builds a new
 * Encoder over the same instances) sheds what was scoped to the previous
 * one: its pass stamp reads as "inlined already" to the new Root's passes,
 * its queue node makes `enqueueChangeTree` skip it, and its view slots and
 * stream backlogs name the previous Root's StateViews, whose ids the new
 * Root hands out again.
 */
function adoptTree(tree: ChangeTree, root: Root): void {
    tree._fullSyncGen = 0;
    tree.changesNode = undefined;
    tree.visibleViews = undefined;
    tree.tagBits = undefined;
    tree.tagViews = undefined;
    const aux = tree.aux;
    if (aux !== undefined) {
        aux.unreliableChangesNode = undefined;
        aux.subscribedViews = undefined;
    }
    if (tree.isStreamCollection) {
        const stream = tree.ref as unknown as Streamable;
        const st = stream._stream;
        if (st !== undefined) {
            st.pendingByView.clear();
            st.sentByView.clear();
            st.priorityByView?.clear();
        }
        root.registerStream(stream);
    }
}

export function setParent(
    tree: ChangeTree,
    parent: Ref,
    root?: Root,
    parentIndex?: number,
    parentTree?: ChangeTree,
): void {
    // a detached tree keeps the edges of the parents that dropped it (StateView
    // reads them); coming back, a stale one would order its ops after a parent
    // that no longer holds it
    if (root !== undefined && tree.root === undefined && tree.needsRestage) clearParents(tree);
    tree.addParent(parent, parentIndex, parentTree);

    // avoid setting parents with empty `root`
    if (!root) { return; }

    if (tree.root !== undefined && tree.root !== root) adoptTree(tree, root);
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
    const ref = tree.ref as any;
    const kind = tree.encDescriptor.kind;
    if (kind !== KIND_SCHEMA) {
        if (typeof ref[$childType] !== "string") {
            if (kind === KIND_ARRAY) {
                // ArraySchema: dense index loop over the element storage.
                const els: any[] = ref[$elements];
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
        const desc = tree.encDescriptor;
        const indexes = desc.refIndexes;
        const values = tree.values;
        for (let i = 0, len = indexes.length; i < len; i++) {
            const index = indexes[i];
            const value = fieldOf(desc, ref, values, index);
            if (!value) { continue; }
            callback(ctx, refTreeOf(value), index);
        }
    }
}

// Hoisted callbacks used by setRoot / setParent to avoid per-call
// closure allocation in the recursive attach path.

/**
 * A decoder-built instance carries an `UntrackedChangeTree` stub. Attaching
 * it to an encoder (hand-off of a decoded state) upgrades the stub to a real
 * tree on the spot. The decoder id is not inherited: `Root.add` allocates
 * this encoder's own, and re-stages the never-recorded contents.
 */
export function ensureTracked(child: ChangeTree): ChangeTree {
    // a tracked tree of another library copy misses `instanceof`: only the stub reads `isTracked === false`
    if (child instanceof ChangeTree || (child as any).isTracked !== false) return child;
    const ref: any = (child as any).ref;
    const real = new ChangeTree(ref);
    real.needsRestage = true;
    if (real.encDescriptor.kind === KIND_MAP) {
        // the decoder keeps no `nextIndex` for maps: new keys go after every decoded wire index
        for (const i of ref.indexByKey.values()) { if (i >= ref.nextIndex) ref.nextIndex = i + 1; }
    }
    setTree(ref, real);
    return real;
}

/** A shared instance reached again by an attach walk: an upgraded stub recorded no edge at decode time. */
function addMissingEdge(child: ChangeTree, parentTree: ChangeTree, index: any): void {
    if (!hasParentTree(child, parentTree)) child.addParent(parentTree.ref, index, parentTree);
}

function _setRootChildCb(parentTree: ChangeTree, child: ChangeTree, index: any): void {
    const root = parentTree.root!;
    const tracked = ensureTracked(child);
    if (tracked !== child) {
        tracked.setParent(parentTree.ref, root, index, parentTree); // a stub has no parent edge yet
    } else if (child.root !== root) {
        child.setRoot(root);
    } else {
        addMissingEdge(child, parentTree, index);
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
        addMissingEdge(child, ctx.parentTree, index);
        ctx.root.add(child);
        ctx.root.moveNextToParent(child);
        return;
    }
    child.setParent(ctx.parentRef, ctx.root, index, ctx.parentTree);
}
