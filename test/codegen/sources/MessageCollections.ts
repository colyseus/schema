import { Schema, type } from "../../../src";

export class MsgItem extends Schema {
    @type("string") name: string;
}

export interface CollectionMessage {
    targets: string[];
    generic: Array<string>;
    frozen: readonly number[];
    items: ReadonlyArray<MsgItem>;
    item: MsgItem;
    ids: Array<string | number>;
    scores: Record<string, number>;
    flags: { [key: string]: boolean };
    byName: ReadonlyMap<string, MsgItem>;
}
