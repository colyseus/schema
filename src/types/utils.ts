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
 * Does `name` resolve on the prototype chain to the accessor `installed` (the
 * class's `metadata[$descriptors]` entry)? Then the field's value lives in
 * `$values[index]`; otherwise (a `manual` data slot, a user's accessor
 * override) only `obj[name]` reaches it.
 */
export function resolvesTo(proto: any, name: string, installed: PropertyDescriptor | undefined): boolean {
    if (installed?.get === undefined) return false; // `manual`: a data slot
    for (let p = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, name);
        if (d !== undefined) return d.get === installed.get && d.set === installed.set;
    }
    return false;
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
