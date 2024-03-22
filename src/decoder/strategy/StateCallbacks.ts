import { Schema } from "../../Schema";
import { Metadata } from "../../Metadata";
import { Collection, NonFunctionNonPrimitivePropNames, NonFunctionPropNames } from "../../types/HelperTypes";
import { Ref } from "../../encoder/ChangeTree";
import { Decoder } from "../Decoder";
import { ArraySchema, CollectionSchema, MapSchema, SetSchema } from "../..";
import { Z_UNKNOWN } from "zlib";
import { DataChange } from "../DecodeOperation";

//
// Discussion: https://github.com/colyseus/schema/issues/155
//
// Main points:
// - Decouple structures from their callbacks.
// - Registering deep callbacks can be confusing.
// - Avoid closures by allowing to pass a context. (https://github.com/colyseus/schema/issues/155#issuecomment-1804694081)
//

type AnyProxyType = CollectionCallback<unknown, unknown> & InstanceCallback<any>

// type GetProxyType<T> = T extends Collection<infer K, infer V, infer _>
//     ? CollectionCallback<K, V>
//     : InstanceCallback<T>;

type GetProxyType<T> = T extends Collection<infer K, infer V, infer _>
    ? (
        K extends unknown // T is "any"
            ? CollectionCallback<K, V> & InstanceCallback<unknown>
            : CollectionCallback<K, V>
    )
    : InstanceCallback<T>;

// type PrimitiveCallback<T> = {
//     listen(callback: (value: T, previousValue: T) => void, immediate?: boolean): void;
// };

type InstanceCallback<T> = {
    listen<K extends NonFunctionPropNames<T>>(
        prop: K,
        callback: (value: T[K], previousValue: T[K]) => void,
        immediate?: boolean,
    )
    onChange(callback: () => void): void;
    bindTo(targetObject: any, properties?: Array<NonFunctionPropNames<T>>): void;
} & {
    [K in NonFunctionNonPrimitivePropNames<T>]: GetProxyType<T[K]>;
}

type CollectionCallback<K, V> = {
    onAdd(callback: (item: V, index: K) => void): void;
    onRemove(callback: (item: V, index: K) => void): void;
};

export function getStateCallbacks(decoder: Decoder) {
    const $root = decoder.$root;

    function $<T>(instance: T): GetProxyType<T> {
        const metadata: Metadata = instance.constructor[Symbol.metadata];

        console.log("$ ->", { instance, metadata });

        if (metadata) {
            // schema instance
            return new Proxy({
                listen: function listen<K extends NonFunctionPropNames<T>>(prop: K, callback: (value: T[K], previousValue: T[K]) => void, immediate?: boolean) {
                    console.log("listen", prop, callback, immediate);
                },
                onChange: function onChange(callback: () => void) {
                    console.log("onChange", callback);
                },
                bindTo: function bindTo(targetObject: any, properties?: Array<NonFunctionPropNames<T>>) {
                    console.log("bindTo", targetObject, properties);
                }
            } as GetProxyType<T>, {
                get(target, prop) {
                    console.log("get", prop, instance[prop]);
                    return (target[prop])
                        ? target[prop]
                        : $(instance[prop]);
                },
                set(target, prop, value) { throw new Error("not allowed"); },
                has(target, prop) { return instance[prop] !== undefined; },
                deleteProperty(target, p) { throw new Error("not allowed"); },
            });

        } else {
            // collection instance
            return new Proxy({
                onAdd: function onAdd(callback) {
                    console.log("onAdd", callback);
                },
                onRemove: function onRemove(callback) {
                    console.log("onRemove", callback);
                },
            } as GetProxyType<T>, {
                get(target, prop) {
                    return (target[prop])
                        ? target[prop]
                        : $(instance[prop]);
                },
                set(target, prop, value) { throw new Error("not allowed"); },
                has(target, prop) { return target[prop] !== undefined; },
                deleteProperty(target, prop) { throw new Error("not allowed"); },
            });
        }
    }

    return {
        $,
        trigger: function trigger(changes: DataChange[]) {
            for (let i = 0, l = changes.length; i < l; i++) {
                const change = changes[i];

                change.op
                change.ref
            }
        }
    }

}