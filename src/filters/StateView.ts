import type { ChangeTree, Ref } from "../changes/ChangeTree";
import { $changes } from "../changes/consts";

export class StateView<T extends Ref = any> {
    private owned = new WeakSet<ChangeTree>();
    private visible: WeakSet<ChangeTree>;

    owns(obj: any) {
        if (obj && obj[$changes]) {
            const changes: ChangeTree = obj[$changes];
            this.owned.add(changes);

            changes.forEachChild((change, atIndex) => {
                this.owns(change.ref)
            });
        }

        return obj;
    }
}