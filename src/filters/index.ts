import { ChangeTree } from "../changes/ChangeTree";

export class ClientState {
    refIds = new WeakSet<ChangeTree>();
    containerIndex = new WeakMap<ChangeTree, Set<number>>();
}
