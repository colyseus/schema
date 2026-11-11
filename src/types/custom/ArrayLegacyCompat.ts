import { ArraySchema, setArrayWrapper } from "./ArraySchema.js";
import { refTreeOf, setTree, stampTree, treeOf } from "../../encoder/ChangeTree.js";
import { $changes } from "../symbols.js";

/**
 * 5.x compatibility: tracked `arr[i] = v`, `arr.length = n` and
 * `arr[i] = null` on `ArraySchema`, and `slice()` / `concat()` / `with()`
 * returning an `ArraySchema`.
 *
 * `enableLegacyCompat()` makes `new ArraySchema()` hand out a Proxy over
 * the instance. Its `set` trap routes index and `length` writes through
 * `set()` / `splice()` / `clear()`; methods run on the instance itself, so
 * only reads and writes made *through the array's own keys* pay for the
 * Proxy. The encoder and the decoder never see it: the tree's `ref` is the
 * instance, and decoded arrays are built without the constructor.
 *
 * The tree is stamped on the Proxy as well (a private slot is not forwarded
 * to the target), so every tree lookup works on either object.
 */

/** Reads the instance behind a wrapped array. */
const RAW: unique symbol = Symbol();

/** Methods whose callback receives the array: it gets the wrapped one. */
const CALLBACK_METHODS = new Set<string | symbol>([
    "forEach", "map", "filter", "find", "findIndex", "findLast", "findLastIndex",
    "some", "every", "reduce", "reduceRight", "flatMap",
]);

/** Methods that returned an `ArraySchema` in 5.x. */
const COPY_METHODS = new Set<string | symbol>(["slice", "concat", "with"]);

/**
 * An `ArraySchema` holding `values`. Most copies are thrown away, so an
 * element that already has a parent keeps no edge to the copy (it would pin
 * every copy ever made); attaching the copy to a state restores the edge.
 */
function trackedCopy(values: any[]): ArraySchema {
    const copy = ArraySchema.from(values);
    const copyTree = treeOf(copy);
    for (let i = 0, len = copy.length; i < len; i++) {
        const tree = refTreeOf(values[i]);
        // the newest parent is the primary one; removing it puts the previous one back
        if (tree !== undefined && tree.parentTree === copyTree && tree.extraParents !== undefined) tree.removeParent(copy);
    }
    return copy;
}

/** A canonical array index ("0", "17"); "01", "-1", "1.5", "" are plain properties. */
function isIndexKey(key: string | symbol): boolean {
    if (typeof key === "symbol") return false;
    let c = key.charCodeAt(0);
    if (!(c >= 48 && c <= 57)) return false; // NaN for ""
    if (c === 48) return key.length === 1;
    for (let i = 1, len = key.length; i < len; i++) {
        c = key.charCodeAt(i);
        if (c < 48 || c > 57) return false;
    }
    return true;
}

/** One wrapper per method, shared by every wrapped array. */
const wrappers = new Map<Function, Function>();

function wrapperOf(method: Function, key: string | symbol): Function {
    let wrapper = wrappers.get(method);
    if (wrapper === undefined) {
        const passesArray = CALLBACK_METHODS.has(key);
        const returnsCopy = COPY_METHODS.has(key);
        wrapper = function (this: any, ...args: any[]) {
            const wrapped = this;
            const target = wrapped[RAW] ?? wrapped;
            if (passesArray && typeof args[0] === "function") {
                const callback = args[0];
                args[0] = function (this: any, ...callbackArgs: any[]) {
                    const last = callbackArgs.length - 1; // the array comes last
                    if (callbackArgs[last] === target) callbackArgs[last] = wrapped;
                    return callback.apply(this, callbackArgs);
                };
            }
            const result = method.apply(target, args);
            if (returnsCopy) return trackedCopy(result);
            return result === target ? wrapped : result;
        };
        wrappers.set(method, wrapper);
    }
    return wrapper;
}

const HANDLER: ProxyHandler<any> = {
    get(target, key) {
        if (key === RAW) return target;
        const value = target[key];
        // methods run on the instance: its own reads and writes skip the traps
        return (typeof value === "function" && key !== "constructor") ? wrapperOf(value, key) : value;
    },

    set(target, key, value, receiver) {
        if (isIndexKey(key)) {
            target.set(Number(key), value);

        } else if (key === "length") {
            const length = target.length;
            if (value === 0) {
                target.clear();
            } else if (value < length) {
                target.splice(value);
            } else if (value > length) {
                console.warn("ArraySchema: can't set .length to a higher value than its length.");
            }

        } else {
            Reflect.set(target, key, value, target);
            if (key === $changes) setTree(receiver, value); // both objects carry the tree
        }
        return true;
    },

    // a hole is not representable: `delete arr[i]` leaves the element, as in 5.x
    deleteProperty(target, key) {
        return isIndexKey(key) || Reflect.deleteProperty(target, key);
    },
};

function wrap(array: ArraySchema): ArraySchema {
    const tree = treeOf(array);
    if ((tree as any).isTracked === false) return array; // no encoder loaded: nothing records
    const wrapped = new Proxy(array, HANDLER);
    stampTree(wrapped, tree);
    return wrapped;
}

/**
 * Track `arr[i] = v`, `arr[i] = null` and `arr.length = n` on every
 * `ArraySchema` constructed from now on, as 5.x did. On those arrays
 * `slice()`, `concat()` and `with()` return an `ArraySchema` again.
 *
 * A migration aid: arrays built while it is on read and write by index
 * about as fast as in 5.x (a Proxy), instead of at plain-array speed.
 * Prefer `set(index, value)`, `splice()` and `clear()` in new code.
 *
 * Call it once, before any state is created. `enableLegacyCompat(false)`
 * stops wrapping new arrays; existing ones keep tracking.
 */
export function enableLegacyCompat(enabled: boolean = true): void {
    setArrayWrapper(enabled ? wrap : undefined);
}
