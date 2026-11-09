/**
 * Parent-chain helpers for ChangeTree. A tree can have multiple parents
 * (rare — instance sharing between Schema/Collection containers). The
 * primary parent is stored inline on the tree (`parentTree` / `_parentIndex`);
 * additional parents live in the `extraParents` linked list.
 */
import { refTreeOf, type ChangeTree, type ParentEntry, type Ref } from "../ChangeTree.js";

/**
 * Add a parent to the chain. If `parent` already exists anywhere in the
 * chain, update the primary parent's index instead (matches legacy
 * behavior). Parents are compared by tree: an ArraySchema is reachable both
 * as its Proxy and as the raw target.
 */
export function addParent(tree: ChangeTree, parent: Ref, index: number, parentTree?: ChangeTree): void {
    // every internal attach passes it; derived from the ref otherwise
    const pt = (parentTree !== undefined) ? parentTree : refTreeOf(parent);
    const current = tree.parentTree;
    if (current !== undefined) {
        if (current === pt) {
            tree._parentIndex = index;
            return;
        }
        for (let entry = tree.aux?.extraParents; entry !== undefined; entry = entry.next) {
            if (entry.tree === pt) {
                tree._parentIndex = index; // the primary's slot, not the entry's: known quirk
                return;
            }
        }
        tree.extraParents = {
            tree: current,
            index: tree._parentIndex,
            next: tree.extraParents
        };
    }
    tree.parentTree = pt;
    tree._parentIndex = index;
}

/** Forget every parent edge. */
export function clearParents(tree: ChangeTree): void {
    tree.parentTree = undefined;
    tree._parentIndex = undefined;
    tree.extraParents = undefined;
}

/**
 * Remove a parent from the chain.
 * @returns true if parent was found and removed (Root.remove relies on this).
 */
export function removeParent(tree: ChangeTree, parent: Ref): boolean {
    const pt = refTreeOf(parent); // by tree: ArraySchema is reachable as Proxy and as raw target
    const primary = tree.parentTree;
    if (primary !== undefined && primary === pt) {
        // Removing inline parent — promote first extra parent if exists
        const promoted = tree.aux?.extraParents;
        if (promoted !== undefined) {
            tree.parentTree = promoted.tree;
            tree._parentIndex = promoted.index;
            tree.extraParents = promoted.next;
        } else {
            tree.parentTree = undefined;
            tree._parentIndex = undefined;
        }
        return true;
    }

    // Search extra parents
    let current = tree.aux?.extraParents;
    let previous = null;
    while (current) {
        if (current.tree === pt) {
            if (previous) {
                previous.next = current.next;
            } else {
                tree.extraParents = current.next;
            }
            return true;
        }
        previous = current;
        current = current.next;
    }
    return tree.parentTree === undefined;
}

/**
 * First parent matching `predicate`, as a detached `ParentEntry`. Never returns
 * a live `ParentChain` node — the inline parent has no node to return in the
 * first place, so handing out the real node for the `extraParents` case only
 * would make writes land or vanish depending on which parent matched.
 */
export function findParent(
    tree: ChangeTree,
    predicate: (parent: Ref, index: number) => boolean,
): ParentEntry | undefined {
    if (tree.parentRef !== undefined && predicate(tree.parentRef, tree._parentIndex)) {
        return { ref: tree.parentRef, index: tree._parentIndex };
    }
    for (let entry = tree.aux?.extraParents; entry !== undefined; entry = entry.next) {
        if (predicate(entry.tree.ref, entry.index)) {
            return { ref: entry.tree.ref, index: entry.index };
        }
    }
    return undefined;
}

/** Is `parentTree` among `tree`'s parents (primary or extra)? */
export function hasParentTree(tree: ChangeTree, parentTree: ChangeTree): boolean {
    if (tree.parentTree === parentTree) return true;
    for (let entry = tree.aux?.extraParents; entry !== undefined; entry = entry.next) {
        if (entry.tree === parentTree) return true;
    }
    return false;
}

/** Any parent matching `predicate`? Walks in place. */
export function hasParent(
    tree: ChangeTree,
    predicate: (parent: Ref, index: number) => boolean,
): boolean {
    if (tree.parentRef !== undefined && predicate(tree.parentRef, tree._parentIndex)) {
        return true;
    }
    for (let entry = tree.aux?.extraParents; entry !== undefined; entry = entry.next) {
        if (predicate(entry.tree.ref, entry.index)) { return true; }
    }
    return false;
}

/**
 * Return all parents as detached entries (debug/test helper).
 */
export function getAllParents(tree: ChangeTree): ParentEntry[] {
    const parents: ParentEntry[] = [];
    if (tree.parentRef) {
        parents.push({ ref: tree.parentRef, index: tree._parentIndex });
    }
    let current = tree.aux?.extraParents;
    while (current) {
        parents.push({ ref: current.tree.ref, index: current.index });
        current = current.next;
    }
    return parents;
}

/**
 * True iff `parent` currently holds `tree`. Detached edges linger in the
 * parent chain (Root.remove leaves the child's own link dangling until it
 * is re-parented), so the chain alone cannot answer which edges are live.
 * ArraySchema is probed by scanning the array itself: the recorded slot is
 * informational only and goes stale after reorders.
 */
export function isEdgeLive(tree: ChangeTree, parentTree: ChangeTree, index: number): boolean {
    const target = parentTree.refTarget as any;
    if (parentTree.isArray) {
        const at = target[index];
        if (at !== undefined && refTreeOf(at) === tree) return true;
        for (let i = 0, len = target.length; i < len; i++) {
            const v = target[i];
            if (v !== undefined && refTreeOf(v) === tree) return true;
        }
        return false;
    }
    const at = parentTree.getValue(index);
    return at !== undefined && refTreeOf(at) === tree;
}
