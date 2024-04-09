import type { ChangeTree, Ref } from "./ChangeTree";
import { $changes } from "../types/symbols";

export class StateView<T extends Ref = any> {
    items = new WeakSet<ChangeTree>();

    add(obj: Ref) {
        // console.log("OWNS =>", obj.constructor.name, obj[$changes].refId);

        if (obj && obj[$changes]) {
            let changeTree: ChangeTree = obj[$changes];
            this.items.add(changeTree);

            // TODO: avoid recursive call here
            changeTree.forEachChild((change, _) =>
                this.add(change.ref));

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
}