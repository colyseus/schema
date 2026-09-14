/**
 * Parent-chain helpers for ChangeTree. A tree can have multiple parents
 * (rare — instance sharing between Schema/Collection containers). The
 * primary parent is stored inline on the tree (`parentRef` / `_parentIndex`);
 * additional parents live in the `extraParents` linked list.
 */
import { $changes } from "../../types/symbols.js";
import type { ChangeTree, ParentEntry, Ref } from "../ChangeTree.js";

/**
 * Add a parent to the chain. If `parent` already exists anywhere in the
 * chain, update the primary parent's index instead (matches legacy
 * behavior).
 */
export function addParent(tree: ChangeTree, parent: Ref, index: number): void {
    // Check if this parent already exists anywhere in the chain
    if (tree.parentRef) {
        if (tree.parentRef[$changes] === parent[$changes]) {
            // Primary parent matches — update index
            tree._parentIndex = index;
            return;
        }

        // Check extra parents for duplicate
        if (hasParent(tree, (p, _) => p[$changes] === parent[$changes])) {
            // Match old behavior: update primary parent's index
            tree._parentIndex = index;
            return;
        }
    }

    if (tree.parentRef === undefined) {
        // First parent — store inline
        tree.parentRef = parent;
        tree._parentIndex = index;
    } else {
        // Push current inline parent to extraParents, set new as primary
        tree.extraParents = {
            ref: tree.parentRef,
            index: tree._parentIndex,
            next: tree.extraParents
        };
        tree.parentRef = parent;
        tree._parentIndex = index;
    }
}

/**
 * Remove a parent from the chain.
 * @returns true if parent was found and removed (Root.remove relies on this).
 */
export function removeParent(tree: ChangeTree, parent: Ref): boolean {
    //
    // FIXME: it is required to check against `$changes` here because
    // ArraySchema is instance of Proxy
    //
    if (tree.parentRef && tree.parentRef[$changes] === parent[$changes]) {
        // Removing inline parent — promote first extra parent if exists
        if (tree.extraParents) {
            tree.parentRef = tree.extraParents.ref;
            tree._parentIndex = tree.extraParents.index;
            tree.extraParents = tree.extraParents.next;
        } else {
            tree.parentRef = undefined;
            tree._parentIndex = undefined;
        }
        return true;
    }

    // Search extra parents
    let current = tree.extraParents;
    let previous = null;
    while (current) {
        if (current.ref[$changes] === parent[$changes]) {
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
    return tree.parentRef === undefined;
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
    for (let entry = tree.extraParents; entry !== undefined; entry = entry.next) {
        if (predicate(entry.ref, entry.index)) {
            return { ref: entry.ref, index: entry.index };
        }
    }
    return undefined;
}

/** Walks in place — `addParent` calls this per shared-instance attach. */
export function hasParent(
    tree: ChangeTree,
    predicate: (parent: Ref, index: number) => boolean,
): boolean {
    if (tree.parentRef !== undefined && predicate(tree.parentRef, tree._parentIndex)) {
        return true;
    }
    for (let entry = tree.extraParents; entry !== undefined; entry = entry.next) {
        if (predicate(entry.ref, entry.index)) { return true; }
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
    let current = tree.extraParents;
    while (current) {
        parents.push({ ref: current.ref, index: current.index });
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
    const target = parentTree.elements as any;
    if (parentTree.isArray) {
        const at = target[index];
        if (at !== undefined && at[$changes] === tree) return true;
        for (let i = 0, len = target.length; i < len; i++) {
            const v = target[i];
            if (v !== undefined && v[$changes] === tree) return true;
        }
        return false;
    }
    const at = parentTree.getValue(index);
    return at !== undefined && at[$changes] === tree;
}
