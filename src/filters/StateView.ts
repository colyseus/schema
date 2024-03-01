import type { ChangeTree, Ref } from "../changes/ChangeTree";
import { $changes } from "../changes/consts";

export class StateView<T extends Ref = any> {
    private owned = new WeakSet<ChangeTree>();
    private visible: WeakSet<ChangeTree>;

    owns(obj: any) {
        if (obj && obj[$changes]) {
            this.owned.add(obj[$changes]);
        }

        return obj;
    }
}