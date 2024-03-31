import { Metadata } from "../../Metadata";
import { Collection, NonFunctionNonPrimitivePropNames, NonFunctionPropNames } from "../../types/HelperTypes";
import { Ref } from "../../encoder/ChangeTree";
import { Decoder } from "../Decoder";
import { DataChange } from "../DecodeOperation";
import { OPERATION } from "../../encoding/spec";
import { DefinitionType } from "../../annotations";
import { Schema } from "../../Schema";
import type { ArraySchema } from "../../types/ArraySchema";

//
// Discussion: https://github.com/colyseus/schema/issues/155
//
// Main points:
// - Decouple structures from their callbacks.
// - Registering deep callbacks can be confusing.
// - Avoid closures by allowing to pass a context. (https://github.com/colyseus/schema/issues/155#issuecomment-1804694081)
//

type GetProxyType<T> = unknown extends T // is "any"?
    ? InstanceCallback<T> & CollectionCallback<any, any>
    : T extends Collection<infer K, infer V, infer _>
        ? CollectionCallback<K, V>
        : InstanceCallback<T>

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

type OnInstanceAvailableCallback = (callback: (ref: Ref) => void) => void;

type CallContext = {
    instance?: any,
    parentInstance?: any,
    onInstanceAvailable?: OnInstanceAvailableCallback,
}

export function getStateCallbacks(decoder: Decoder) {
    const $root = decoder.$root;
    const callbacks = $root.callbacks;

    let isTriggeringOnAdd = false;

    decoder.triggerChanges = function (allChanges: DataChange[]) {
        const uniqueRefIds = new Set<number>();

        for (let i = 0, l = allChanges.length; i < l; i++) {
            const change = allChanges[i];
            const refId = change.refId;
            const ref = change.ref;
            const $callbacks = callbacks[refId];

            if (!$callbacks) { continue; }

            //
            // trigger onRemove on child structure.
            //
            if (
                (change.op & OPERATION.DELETE) === OPERATION.DELETE &&
                change.previousValue instanceof Schema
            ) {
                callbacks[$root.refIds.get(change.previousValue)]?.[OPERATION.DELETE]?.forEach(callback =>
                    callback());
            }

            if (ref instanceof Schema) {
                if (!uniqueRefIds.has(refId)) {
                    try {
                        // trigger onChange
                        $callbacks?.[OPERATION.REPLACE]?.forEach(callback => callback());

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

                    isTriggeringOnAdd = true;
                    $callbacks[OPERATION.ADD]?.forEach(callback =>
                        callback(change.value, change.dynamicIndex ?? change.field));
                    isTriggeringOnAdd = false;

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

    function getProxy(metadataOrType: Metadata | DefinitionType, context: CallContext) {
        let metadata: Metadata = context.instance?.constructor[Symbol.metadata];
        let isCollection = (
            (context.instance && typeof (context.instance['forEach']) === "function") ||
            (metadataOrType && Object.keys(metadataOrType)[0] !== "ref")
        );

        if (metadata && !isCollection) {
            /**
             * Schema instances
             */
            return new Proxy({
                listen: function listen(prop: string, callback: (value: any, previousValue: any) => void, immediate: boolean = true) {
                    // immediate trigger
                    if (
                        immediate &&
                        context.instance[prop] !== undefined &&
                        !isTriggeringOnAdd // FIXME: This is a workaround
                                           // (https://github.com/colyseus/schema/issues/147)
                    ) {
                        callback(context.instance[prop], undefined);
                    }
                    return $root.addCallback(
                        $root.refIds.get(context.instance),
                        prop,
                        callback
                    );
                },
                onChange: function onChange(callback: () => void) {
                    return $root.addCallback(
                        $root.refIds.get(context.instance),
                        OPERATION.REPLACE,
                        callback
                    );

                },
                bindTo: function bindTo(targetObject: any, properties?: string[]) {
                    console.log("bindTo", targetObject, properties);
                }
            }, {
                get(target, prop: string) {
                    if (metadata[prop]) {
                        const instance = context.instance?.[prop];
                        const onInstanceAvailable: OnInstanceAvailableCallback = (
                            !instance &&
                            ((callback: (ref: Ref) => void) => {
                                // @ts-ignore
                                const dettach = $(context.instance).listen(prop, (value, previousValue) => {
                                    dettach();
                                    callback(value);
                                });
                            }) || undefined
                        );
                        return getProxy(metadata[prop].type, {
                            instance,
                            parentInstance: context.instance,
                            onInstanceAvailable,
                        });

                    } else {
                        // accessing the function
                        return target[prop];
                    }
                },
                has(target, prop: string) { return metadata[prop] !== undefined; },
                set(_, _1, _2) { throw new Error("not allowed"); },
                deleteProperty(_, _1) { throw new Error("not allowed"); },
            });

        } else {
            const onAdd = function (ref: Ref, callback: (value: any, key: any) => void, immediate: boolean) {
                // Trigger callback on existing items
                if (immediate) {
                    (ref as ArraySchema).forEach((v, k) => callback(v, k));
                }
                return $root.addCallback($root.refIds.get(ref), OPERATION.ADD, callback);
            };

            const onRemove = function (ref: Ref, callback: (value: any, key: any) => void) {
                return $root.addCallback($root.refIds.get(ref), OPERATION.DELETE, callback);
            };

            /**
             * Collection instances
             */
            return new Proxy({
                onAdd: function(callback: (value, key) => void, immediate: boolean = true) {
                    if (context.instance) {
                        //
                        // https://github.com/colyseus/schema/issues/147
                        // If parent instance has "onAdd" registered, avoid triggering immediate callback.
                        //
                        // FIXME: This is a workaround. We should find a better way to handle this.
                        //
                        onAdd(context.instance, callback, immediate && !isTriggeringOnAdd);

                    } else if (context.onInstanceAvailable) {
                        // collection instance not received yet
                        context.onInstanceAvailable((ref: Ref) =>
                            onAdd(ref, callback, false));
                    }
                },
                onRemove: function(callback: (value, key) => void) {
                    if (context.instance) {
                        onRemove(context.instance, callback);

                    } else if (context.onInstanceAvailable) {
                        // collection instance not received yet
                        context.onInstanceAvailable((ref: Ref) =>
                            onRemove(ref, callback));
                    }
                },
            }, {
                get(target, prop: string) {
                    if (!target[prop]) {
                        throw new Error(`Can't access '${prop}' through callback proxy. access the instance directly.`);
                    }
                    return target[prop];
                },
                has(target, prop) { return target[prop] !== undefined; },
                set(_, _1, _2) { throw new Error("not allowed"); },
                deleteProperty(_, _1) { throw new Error("not allowed"); },
            });
        }
    }

    function $<T>(instance: T): GetProxyType<T> {
        return getProxy(undefined, { instance }) as GetProxyType<T>;
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