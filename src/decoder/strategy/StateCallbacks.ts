import { Metadata } from "../../Metadata";
import { Collection, NonFunctionNonPrimitivePropNames, NonFunctionPropNames } from "../../types/HelperTypes";
import { Ref } from "../../encoder/ChangeTree";
import { Decoder } from "../Decoder";
import { DataChange } from "../DecodeOperation";
import { OPERATION } from "../../encoding/spec";
import { Schema } from "../../Schema";
import type { DefinitionType } from "../../annotations";
import type { CollectionSchema } from "../../types/custom/CollectionSchema";

//
// Discussion: https://github.com/colyseus/schema/issues/155
//
// Main points:
// - Decouple structures from their callbacks.
// - Registering deep callbacks can be confusing.
// - Avoid closures by allowing to pass a context. (https://github.com/colyseus/schema/issues/155#issuecomment-1804694081)
//

export type SchemaCallbackProxy<RoomState> = (<T extends Schema>(instance: T) => CallbackProxy<T>);
export type GetCallbackProxy = SchemaCallbackProxy<any>; // workaround for compatibility for < colyseus.js0.16.6. Remove me on next major release.

export type CallbackProxy<T> = unknown extends T // is "any"?
    ? SchemaCallback<T> & CollectionCallback<any, any>
    : T extends Collection<infer K, infer V, infer _>
        ? CollectionCallback<K, V>
        : SchemaCallback<T>;

export type SchemaCallback<T> = {
    /**
     * Trigger callback when value of a property changes.
     *
     * @param prop name of the property
     * @param callback callback to be triggered on property change
     * @param immediate trigger immediatelly if property has been already set.
     * @return callback to detach the listener
     */
    listen<K extends NonFunctionPropNames<T>>(
        prop: K,
        callback: (value: T[K], previousValue: T[K]) => void,
        immediate?: boolean,
    ): () => void;

    /**
     * Trigger callback whenever any property changed within this instance.
     *
     * @param prop name of the property
     * @param callback callback to be triggered on property change
     * @param immediate trigger immediatelly if property has been already set.
     * @return callback to detach the listener
     */
    onChange(callback: () => void): () => void;

    /**
     * Bind properties to another object. Changes on the properties will be reflected on the target object.
     *
     * @param targetObject object to bind properties to
     * @param properties list of properties to bind. If not provided, all properties will be bound.
     */
    bindTo(targetObject: any, properties?: Array<NonFunctionPropNames<T>>): void;
} & {
    [K in NonFunctionNonPrimitivePropNames<T>]: CallbackProxy<T[K]>;
}

export type CollectionCallback<K, V> = {
    /**
     * Trigger callback when an item has been added to the collection.
     *
     * @param callback
     * @param immediate
     * @return callback to detach the onAdd listener
     */
    onAdd(callback: (item: V, index: K) => void, immediate?: boolean): () => void;

    /**
     * Trigger callback when an item has been removed to the collection.
     *
     * @param callback
     * @return callback to detach the onRemove listener
     */
    onRemove(callback: (item: V, index: K) => void): () => void;

    /**
     * Trigger callback when the value on a key has changed.
     *
     * THIS METHOD IS NOT RECURSIVE!
     * If you want to listen to changes on individual items, you need to attach callbacks to the them directly inside the `onAdd` callback.
     *
     * @param callback
     */
    onChange(callback: (item: V, index: K) => void): void;
};

type OnInstanceAvailableCallback = (callback: (ref: Ref, existing: boolean) => void) => void;

type CallContext = {
    instance?: any,
    parentInstance?: any,
    onInstanceAvailable?: OnInstanceAvailableCallback,
}


export function getDecoderStateCallbacks<T extends Schema>(decoder: Decoder<T>): SchemaCallbackProxy<T> {
    const $root = decoder.root;
    const callbacks = $root.callbacks;

    const onAddCalls: WeakMap<Function, boolean> = new WeakMap();
    let currentOnAddCallback: Function | undefined;

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
                const deleteCallbacks = callbacks[$root.refIds.get(change.previousValue)]?.[OPERATION.DELETE];
                for (let i = deleteCallbacks?.length - 1; i >= 0; i--) {
                    deleteCallbacks[i]();
                }
            }

            if (ref instanceof Schema) {
                //
                // Handle schema instance
                //

                if (!uniqueRefIds.has(refId)) {
                    // trigger onChange
                    const replaceCallbacks = $callbacks?.[OPERATION.REPLACE];
                    for (let i = replaceCallbacks?.length - 1; i >= 0; i--) {
                        replaceCallbacks[i]();
                        // try {
                        // } catch (e) {
                        //     console.error(e);
                        // }
                    }
                }

                if ($callbacks.hasOwnProperty(change.field)) {
                    const fieldCallbacks = $callbacks[change.field];
                    for (let i = fieldCallbacks?.length - 1; i >= 0; i--) {
                        fieldCallbacks[i](change.value, change.previousValue);
                        // try {
                        // } catch (e) {
                        //     console.error(e);
                        // }
                    }
                }


            } else {
                //
                // Handle collection of items
                //

                if ((change.op & OPERATION.DELETE) === OPERATION.DELETE) {
                    //
                    // FIXME: `previousValue` should always be available.
                    //
                    if (change.previousValue !== undefined) {
                        // triger onRemove
                        const deleteCallbacks = $callbacks[OPERATION.DELETE];
                        for (let i = deleteCallbacks?.length - 1; i >= 0; i--) {
                            deleteCallbacks[i](change.previousValue, change.dynamicIndex ?? change.field);
                        }
                    }

                    // Handle DELETE_AND_ADD operations
                    if ((change.op & OPERATION.ADD) === OPERATION.ADD) {
                        const addCallbacks = $callbacks[OPERATION.ADD];
                        for (let i = addCallbacks?.length - 1; i >= 0; i--) {
                            addCallbacks[i](change.value, change.dynamicIndex ?? change.field);
                        }
                    }

                } else if ((change.op & OPERATION.ADD) === OPERATION.ADD && change.previousValue === undefined) {
                    // triger onAdd
                    const addCallbacks = $callbacks[OPERATION.ADD];
                    for (let i = addCallbacks?.length - 1; i >= 0; i--) {
                        addCallbacks[i](change.value, change.dynamicIndex ?? change.field);
                    }
                }

                // trigger onChange
                if (
                    change.value !== change.previousValue &&
                    // FIXME: see "should not encode item if added and removed at the same patch" test case.
                    // some "ADD" + "DELETE" operations on same patch are being encoded as "DELETE"
                    (change.value !== undefined || change.previousValue !== undefined)
                ) {
                    const replaceCallbacks = $callbacks[OPERATION.REPLACE];
                    for (let i = replaceCallbacks?.length - 1; i >= 0; i--) {
                        replaceCallbacks[i](change.value, change.dynamicIndex ?? change.field);
                    }
                }
            }

            uniqueRefIds.add(refId);
        }
    };

    function getProxy(
        metadataOrType: Metadata | DefinitionType,
        context: CallContext
    ) {
        let metadata: Metadata = context.instance?.constructor[Symbol.metadata] || metadataOrType;
        let isCollection = (
            (context.instance && typeof (context.instance['forEach']) === "function") ||
            (metadataOrType && typeof (metadataOrType[Symbol.metadata]) === "undefined")
        );

        if (metadata && !isCollection) {

            const onAddListen = function (
                ref: Ref,
                prop: string,
                callback: (value: any, previousValue: any) => void, immediate: boolean
            ) {
                // immediate trigger
                if (
                    immediate &&
                    context.instance[prop] !== undefined &&
                    !onAddCalls.has(currentOnAddCallback) // Workaround for https://github.com/colyseus/schema/issues/147
                ) {
                    callback(context.instance[prop], undefined);
                }
                return $root.addCallback($root.refIds.get(ref), prop, callback);
            }

            /**
             * Schema instances
             */
            return new Proxy({
                listen: function listen(prop: string, callback: (value: any, previousValue: any) => void, immediate: boolean = true) {
                    if (context.instance) {
                        return onAddListen(context.instance, prop, callback, immediate);

                    } else {
                        // collection instance not received yet
                        let detachCallback = () => {};

                        context.onInstanceAvailable((ref: Ref, existing: boolean) => {
                            detachCallback = onAddListen(ref, prop, callback, immediate && existing && !onAddCalls.has(currentOnAddCallback))
                        });

                        return () => detachCallback();
                    }
                },

                onChange: function onChange(callback: () => void) {
                    return $root.addCallback(
                        $root.refIds.get(context.instance),
                        OPERATION.REPLACE,
                        callback
                    );
                },

                //
                // TODO: refactor `bindTo()` implementation.
                // There is room for improvement.
                //
                bindTo: function bindTo(targetObject: any, properties?: string[]) {
                    if (!properties) {
                        properties = Object.keys(metadata).map((index) => metadata[index as any as number].name);
                    }
                    return $root.addCallback(
                        $root.refIds.get(context.instance),
                        OPERATION.REPLACE,
                        () => {
                            properties.forEach((prop) =>
                                targetObject[prop] = context.instance[prop])
                        }
                    );
                }
            }, {
                get(target, prop: string) {
                    const metadataField = metadata[metadata[prop]];
                    if (metadataField) {
                        const instance = context.instance?.[prop];
                        const onInstanceAvailable: OnInstanceAvailableCallback = (
                            (callback: (ref: Ref, existing: boolean) => void) => {
                                const unbind = $(context.instance).listen(prop, (value, _) => {
                                    callback(value, false);

                                    // FIXME: by "unbinding" the callback here,
                                    // it will not support when the server
                                    // re-instantiates the instance.
                                    //
                                    unbind?.();
                                }, false);

                                // has existing value
                                if ($root.refIds.get(instance) !== undefined) {
                                    callback(instance, true);
                                }
                            }
                        );

                        return getProxy(metadataField.type, {
                            // make sure refId is available, otherwise need to wait for the instance to be available.
                            instance: ($root.refIds.get(instance) && instance),
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
            /**
             * Collection instances
             */

            const onAdd = function (ref: Ref, callback: (value: any, key: any) => void, immediate: boolean) {
                // Trigger callback on existing items
                if (immediate) {
                    (ref as CollectionSchema).forEach((v, k) => callback(v, k));
                }

                return $root.addCallback($root.refIds.get(ref), OPERATION.ADD, (value, key) => {
                    onAddCalls.set(callback, true);
                    currentOnAddCallback = callback;
                    callback(value, key);
                    onAddCalls.delete(callback)
                    currentOnAddCallback = undefined;
                });
            };

            const onRemove = function (ref: Ref, callback: (value: any, key: any) => void) {
                return $root.addCallback($root.refIds.get(ref), OPERATION.DELETE, callback);
            };

            const onChange = function (ref: Ref, callback: (value: any, key: any) => void) {
                return $root.addCallback($root.refIds.get(ref), OPERATION.REPLACE, callback);
            };

            return new Proxy({
                onAdd: function(callback: (value, key) => void, immediate: boolean = true) {
                    //
                    // https://github.com/colyseus/schema/issues/147
                    // If parent instance has "onAdd" registered, avoid triggering immediate callback.
                    //

                    if (context.instance) {
                        return onAdd(context.instance, callback, immediate && !onAddCalls.has(currentOnAddCallback));

                    } else if (context.onInstanceAvailable) {
                        // collection instance not received yet
                        let detachCallback = () => {};

                        context.onInstanceAvailable((ref: Ref, existing: boolean) => {
                            detachCallback = onAdd(ref, callback, immediate && existing && !onAddCalls.has(currentOnAddCallback));
                        });

                        return () => detachCallback();
                    }
                },
                onRemove: function(callback: (value, key) => void) {
                    if (context.instance) {
                        return onRemove(context.instance, callback);

                    } else if (context.onInstanceAvailable) {
                        // collection instance not received yet
                        let detachCallback = () => {};

                        context.onInstanceAvailable((ref: Ref) => {
                            detachCallback = onRemove(ref, callback)
                        });

                        return () => detachCallback();
                    }
                },
                onChange: function(callback: (value, key) => void) {
                    if (context.instance) {
                        return onChange(context.instance, callback);

                    } else if (context.onInstanceAvailable) {
                        // collection instance not received yet
                        let detachCallback = () => {};

                        context.onInstanceAvailable((ref: Ref) => {
                            detachCallback = onChange(ref, callback)
                        });

                        return () => detachCallback();
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

    function $<T>(instance: T): CallbackProxy<T> {
        return getProxy(undefined, { instance }) as unknown as CallbackProxy<T>;
    }

    return $;
}