import { OPERATION } from "../spec";

export function addCallback($callbacks: {[op: number]: Function[]}, op: OPERATION, callback: Function) {
    // initialize list of callbacks
    if (!$callbacks[op]) { $callbacks[op] = []; }

    $callbacks[op].push(callback);

    return () => spliceOne($callbacks[op], $callbacks[op].indexOf(callback));
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