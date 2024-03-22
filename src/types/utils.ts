import { CollectionSchema, DataChange } from "..";
import { OPERATION } from "../encoding/spec";

export function removeChildRefs(this: CollectionSchema, changes: DataChange[]) {
    // @ts-ignore
    const needRemoveRef = (typeof (this.$changes.getType()) !== "string");

    this.$items.forEach((item: any, key: any) => {
        changes.push({
            refId: this.$changes.refId,
            op: OPERATION.DELETE,
            field: key,
            value: undefined,
            previousValue: item
        });

        if (needRemoveRef) {
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