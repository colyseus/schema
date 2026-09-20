/**
 * Parent-chain helpers for ChangeTree. A tree can have multiple parents
 * (rare — instance sharing between Schema/Collection containers). The
 * primary parent is stored inline on the tree (`parentRef` / `_parentIndex`);
 * additional parents live in the `extraParents` linked list.
 */
import { } from "../../types/symbols.js";
import { refTreeOf, type ChangeTree, type ParentEntry, type Ref } from "../ChangeTree.js";

/**
 * Same structure? An ArraySchema is reachable both as its Proxy and as the raw
 * target, so identity alone can miss — the trees are compared then. Identity
 * first: it is the overwhelmingly common answer (a subtree being attached
 * re-adds the parent every node already has) and costs no tree load.
 */
function sameRef(a: Ref, b: Ref): boolean {
    return a === b || refTreeOf(a) === refTreeOf(b);
}

/**
 * Add a parent to the chain. If `parent` already exists anywhere in the
 * chain, update the primary parent's index instead (matches legacy
 * behavior).
 */
/**
 * Same parent? `parentTree` when the caller handed it in; otherwise identity of
 * the ref first, its tree second (an ArraySchema is reachable as Proxy and as
 * raw target).
 */
function isPrimaryParent(current: ChangeTree, parent: Ref, parentTree: ChangeTree | undefined): boolean {
    return (parentTree !== undefined) ? current === parentTree : (current.ref === parent || current === refTreeOf(parent));
}

export function addParent(tree: ChangeTree, parent: Ref, index: number, parentTree?: ChangeTree): void {
    const current = tree.parentTree;
    if (current !== undefined) {
        // Check if this parent already exists anywhere in the chain
        if (isPrimaryParent(current, parent, parentTree)) {
            // Primary parent matches — update index
            tree._parentIndex = index;
            return;
        }

        // Check extra parents for duplicate (walked in place: no closure per re-parent)
        for (let entry = tree.extraParents; entry !== undefined; entry = entry.next) {
            if (sameRef(entry.ref, parent)) {
                // Match old behavior: update primary parent's index
                tree._parentIndex = index;
                return;
            }
        }

        // Push current inline parent to extraParents, set new as primary
        tree.extraParents = {
            ref: current.ref,
            index: tree._parentIndex,
            next: tree.extraParents
        };
    }

    // from the caller when it has it (every internal attach does); derived from the ref otherwise
    tree.parentTree = (parentTree !== undefined) ? parentTree : refTreeOf(parent);
    tree._parentIndex = index;
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
    const primary = tree.parentTree;
    if (primary !== undefined && isPrimaryParent(primary, parent, undefined)) {
        // Removing inline parent — promote first extra parent if exists
        const promoted = tree.extraParents;
        if (promoted !== undefined) {
            tree.parentTree = refTreeOf(promoted.ref);
            tree._parentIndex = promoted.index;
            tree.extraParents = promoted.next;
        } else {
            tree.parentTree = undefined;
            tree._parentIndex = undefined;
        }
        return true;
    }

    // Search extra parents
    let current = tree.extraParents;
    let previous = null;
    while (current) {
        if (sameRef(current.ref, parent)) {
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
