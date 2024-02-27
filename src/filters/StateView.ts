import type { ChangeTree, Ref } from "../changes/ChangeTree";
import { $changes } from "../changes/consts";

export class StateView<T extends Ref = any> {
    private owned: WeakSet<ChangeTree>;

    owns(obj: any) {
        if (!this.owned) { this.owned = new Set(); }
        if (obj[$changes]) {
            this.owned.add(obj[$changes]);
        }
        return obj;
    }
}