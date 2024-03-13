import type { ChangeTree, Ref } from "../changes/ChangeTree";
import { $changes } from "../changes/consts";

export class StateView<T extends Ref = any> {
    private owned = new WeakSet<ChangeTree>();
    private visible: WeakSet<ChangeTree>;

    owns(obj: Ref) {
        console.log("OWNS =>", obj.constructor.name, obj[$changes].refId);
        if (obj && obj[$changes]) {
            let changes: ChangeTree = obj[$changes];
            this.owned.add(changes);

            // TODO: avoid recursive call here
            changes.forEachChild((change, _) =>
                this.owns(change.ref));

            // TODO: avoid unnecessary iteration here
            while (
                changes.parent &&
                (changes = changes.parent[$changes]) &&
                (changes.isFiltered || changes.isPartiallyFiltered)
            ) {
                this.owned.add(changes);
            }
        }

        return obj;
    }
}