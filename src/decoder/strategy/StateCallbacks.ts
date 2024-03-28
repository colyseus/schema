import { Metadata } from "../../Metadata";
import { Collection, NonFunctionNonPrimitivePropNames, NonFunctionPropNames } from "../../types/HelperTypes";
import { Ref } from "../../encoder/ChangeTree";
import { Decoder } from "../Decoder";
import { DataChange } from "../DecodeOperation";
import { OPERATION } from "../../encoding/spec";
import { DefinitionType } from "../../annotations";
import { Schema } from "../../Schema";

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
    onAdd(callback: (item: V, index: K) => void, immediate?: boolean): void;
    onRemove(callback: (item: V, index: K) => void): void;
};

export function getStateCallbacks(decoder: Decoder) {
    const $root = decoder.$root;
    const callbacks = $root.callbacks;

    decoder.triggerChanges = function (allChanges: DataChange[]) {
        console.log("Trigger changes!");
        const uniqueRefIds = new Set<number>();

        for (let i = 0, l = allChanges.length; i < l; i++) {
            const change = allChanges[i];
            const refId = change.refId;
            const ref = change.ref;
            const $callbacks = callbacks[refId]

            if (!$callbacks) {
                console.log("no callbacks for", refId,  ref.constructor[Symbol.metadata], ", skip...");
                continue;
            }

            console.log("HAS CALLBACKS!", $callbacks);

            //
            // trigger onRemove on child structure.
            //
            if (
                (change.op & OPERATION.DELETE) === OPERATION.DELETE &&
                change.previousValue instanceof Schema
            ) {
                change.previousValue['$callbacks']?.[OPERATION.DELETE]?.forEach(callback => callback());
            }

            if (ref instanceof Schema) {
                if (!uniqueRefIds.has(refId)) {
                    try {
                        // trigger onChange
                        ($callbacks as Schema['$callbacks'])?.[OPERATION.REPLACE]?.forEach(callback =>
                            callback());

                    } catch (e) {
                        console.error(e);
                    }
                }

                try {
                    if ($callbacks.hasOwnProperty(change.field)) {
                        $callbacks[change.field]?.forEach((callback) =>
                            callback(change.value, change.previousValue));
                    }

                } catch (e) {
                    //
                    console.error(e);
                }

            } else {
                // is a collection of items

                if (change.op === OPERATION.ADD && change.previousValue === undefined) {
                    // triger onAdd
                    $callbacks[OPERATION.ADD]?.forEach(callback =>
                        callback(change.value, change.dynamicIndex ?? change.field));

                } else if (change.op === OPERATION.DELETE) {
                    //
                    // FIXME: `previousValue` should always be available.
                    // ADD + DELETE operations are still encoding DELETE operation.
                    //
                    if (change.previousValue !== undefined) {
                        // triger onRemove
                        $callbacks[OPERATION.DELETE]?.forEach(callback =>
                            callback(change.previousValue, change.dynamicIndex ?? change.field));
                    }

                } else if (change.op === OPERATION.DELETE_AND_ADD) {
                    // triger onRemove
                    if (change.previousValue !== undefined) {
                        $callbacks[OPERATION.DELETE]?.forEach(callback =>
                            callback(change.previousValue, change.dynamicIndex ?? change.field));
                    }

                    // triger onAdd
                    $callbacks[OPERATION.ADD]?.forEach(callback =>
                        callback(change.value, change.dynamicIndex ?? change.field));
                }

                // trigger onChange
                if (change.value !== change.previousValue) {
                    $callbacks[OPERATION.REPLACE]?.forEach(callback =>
                        callback(change.value, change.dynamicIndex ?? change.field));
                }
            }

            uniqueRefIds.add(refId);
        }

    };

    function getProxy(metadataOrType: Metadata | DefinitionType, instance?: Ref, onParentInstanceAvailable?: (ref: Ref) => void) {
        console.log({ metadataOrType });

        let metadata: Metadata;
        let isCollection = false;

        if (onParentInstanceAvailable !== undefined) {
            if (typeof (metadataOrType) === "object") {
                isCollection = (Object.keys(metadataOrType)[0] !== "ref");

            } else {
                throw new Error("invalid path.");
            }

        } else {
            metadata = metadataOrType as Metadata;
        }

        console.log(`->`, { metadata, isCollection });

        if (metadataOrType && !isCollection) {
            return new Proxy({
                listen: function listen(prop: string, callback: (value: any, previousValue: any) => void, immediate?: boolean) {
                    console.log("LISTEN on refId:", $root.refIds.get(instance));
                    $root.addCallback(
                        $root.refIds.get(instance),
                        prop,
                        callback
                    );
                },
                onChange: function onChange(callback: () => void) {
                    // $root.addCallback(tree, OPERATION.REPLACE, callback);
                },
                bindTo: function bindTo(targetObject: any, properties?: Array<NonFunctionPropNames<T>>) {
                    console.log("bindTo", targetObject, properties);
                }
            }, {
                get(target, prop: string) {
                    if (metadataOrType[prop]) {

                        // TODO: instance might not be available yet, due to pending decoding for actual reference (+refId)
                        // .listen("prop", () => {/* attaching more... */});

                        // if (instance) {
                        //     callbacks.set(instance, )
                        // }

                        return getProxy(metadataOrType[prop].type, instance?.[prop], (ref) => {

                        });

                    } else {
                        // accessing the function
                        return target[prop];
                    }
                },
                has(target, prop) { return metadataOrType[prop] !== undefined; },
                set(target, prop, value) { throw new Error("not allowed"); },
                deleteProperty(target, p) { throw new Error("not allowed"); },
            });
        } else {
            // collection instance
            return new Proxy({
                onAdd: function onAdd(callback, immediate) {
                    if (onParentInstanceAvailable) {
                    }

                    // $root.addCallback([...tree], OPERATION.ADD, callback);
                },
                onRemove: function onRemove(callback) {
                    // $root.addCallback([...tree], OPERATION.DELETE, callback);
                },
            }, {
                get(target, prop: string) {
                    if (!target[prop]) {
                        throw new Error(`Can't access '${prop}' through callback proxy. access the instance directly.`);
                    }
                    return target[prop];
                },
                has(target, prop) { return target[prop] !== undefined; },
                set(target, prop, value) { throw new Error("not allowed"); },
                deleteProperty(target, prop) { throw new Error("not allowed"); },
            });
        }
    }

    function $<T extends Ref>(instance: T): GetProxyType<T> {
        return getProxy(instance.constructor[Symbol.metadata], instance) as GetProxyType<T>;
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