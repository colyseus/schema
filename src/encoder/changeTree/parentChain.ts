/**
 * Parent-chain helpers for ChangeTree. A tree can have multiple parents
 * (rare — instance sharing between Schema/Collection containers). The
 * primary parent is stored inline on the tree (`parentRef` / `_parentIndex`);
 * additional parents live in the `extraParents` linked list.
 */
import { $changes } from "../../types/symbols.js";
import type { ChangeTree, ParentChain, Ref } from "../ChangeTree.js";

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
 * Find the first parent in the chain matching `predicate`.
 */
export function findParent(
    tree: ChangeTree,
    predicate: (parent: Ref, index: number) => boolean,
): ParentChain | undefined {
    // Check inline parent first
    if (tree.parentRef && predicate(tree.parentRef, tree._parentIndex)) {
        return { ref: tree.parentRef, index: tree._parentIndex };
    }

    let current = tree.extraParents;
    while (current) {
        if (predicate(current.ref, current.index)) {
            return current;
        }
        current = current.next;
    }
    return undefined;
}

export function hasParent(
    tree: ChangeTree,
    predicate: (parent: Ref, index: number) => boolean,
): boolean {
    return findParent(tree, predicate) !== undefined;
}

/**
 * Return all parents as an array (debug/test helper).
 */
export function getAllParents(tree: ChangeTree): Array<{ ref: Ref, index: number }> {
    const parents: Array<{ ref: Ref, index: number }> = [];
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
