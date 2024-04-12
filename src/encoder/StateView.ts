import { ChangeTree, Ref } from "./ChangeTree";
import { $changes } from "../types/symbols";
import { DEFAULT_VIEW_TAG } from "../annotations";

export class StateView {
    items: WeakSet<ChangeTree> = new WeakSet<ChangeTree>();
    tags?: WeakMap<ChangeTree, Set<number>>;

    add(obj: Ref, tag: number = DEFAULT_VIEW_TAG) {
        if (obj && obj[$changes]) {
            let changeTree: ChangeTree = obj[$changes];
            this.items.add(changeTree);

            // TODO: avoid recursive call here
            changeTree.forEachChild((change, _) =>
                this.add(change.ref, tag));

            // set tag
            if (tag !== DEFAULT_VIEW_TAG) {
                if (!this.tags) {
                    this.tags = new WeakMap<ChangeTree, Set<number>>();
                }
                let tags: Set<number>;
                if (!this.tags.has(changeTree)) {
                    tags = new Set<number>();
                    this.tags.set(changeTree, tags);
                } else {
                    tags = this.tags.get(changeTree);
                }
                tags.add(tag);
            }

            // TODO: avoid unnecessary iteration here
            while (
                changeTree.parent &&
                (changeTree = changeTree.parent[$changes]) &&
                (changeTree.isFiltered || changeTree.isPartiallyFiltered)
            ) {
                this.items.add(changeTree);
            }
        }

        return obj;
    }

    remove(obj: Ref, tag?: number) {
        if (obj && obj[$changes]) {
            let changeTree: ChangeTree = obj[$changes];
            this.items.delete(changeTree);

            // remove tag
            if (this.tags && this.tags.has(changeTree)) {
                const tags = this.tags.get(changeTree);
                if (tag === undefined) {
                    // delete all tags
                    this.tags.delete(changeTree);
                } else {
                    // delete specific tag
                    tags.delete(tag);
                    if (tags.size === 0) {
                        this.tags.delete(changeTree);
                    }
                }
            }
        }
    }
}