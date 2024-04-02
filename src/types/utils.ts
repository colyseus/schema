import { CollectionSchema, DataChange } from "..";
import { OPERATION } from "../encoding/spec";
import { $changes } from "./symbols";

//
// TODO: move this to "Decoder"
//
export function removeChildRefs(this: CollectionSchema, changes: DataChange[]) {
    const changeTree = this[$changes];

    const needRemoveRef = (typeof (changeTree.getType()) !== "string");
    const refId = changeTree.refId;

    this.$items.forEach((item: any, key: any) => {
        changes.push({
            ref: item,
            refId,
            op: OPERATION.DELETE,
            field: key,
            value: undefined,
            previousValue: item
        });

        if (needRemoveRef) {
            //
            // TODO: must call .removeRef() on "ReferenceTracker"
            //

            // @ts-ignore
            this.$changes.root.removeRef(item['$changes'].refId);
        }
    });
}


export function spliceOne(arr: any[], index: number): boolean {
    // manually splice an array
    if (index === -1 || index >= arr.length) {
        return false;
    }

    const len = arr.length - 1;

    for (let i = index; i < len; i++) {
        arr[i] = arr[i + 1];
    }

    arr.length = len;

    return true;
}