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

/**
 * The setter `obj[name] = v` runs on an instance of `proto` — for a data
 * property (or none), a function doing that plain store.
 */
export function setterOf(proto: any, name: string): (this: any, value: any) => void {
    for (let p = proto; p !== null; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, name);
        if (d !== undefined) {
            if (d.set !== undefined) return d.set;
            break;
        }
    }
    return function (this: any, value: any) { this[name] = value; };
}
