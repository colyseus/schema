import { Metadata } from "../../Metadata.js";
import { Collection, NonFunctionPropNames } from "../../types/HelperTypes.js";
import type { IRef, Ref } from "../../encoder/ChangeTree.js";
import { Decoder } from "../Decoder.js";
import { DataChange } from "../DecodeOperation.js";
import { OPERATION } from "../../encoding/spec.js";
import { Schema } from "../../Schema.js";
import { $refId } from "../../types/symbols.js";
import { MapSchema } from "../../types/custom/MapSchema.js";
import { ArraySchema } from "../../types/custom/ArraySchema.js";
import { getDecoderStateCallbacks, type SchemaCallbackProxy } from "./getDecoderStateCallbacks.js";
import { getRawChangesCallback } from "./RawChanges.js";

//
// C#-style Callbacks API (https://docs.colyseus.io/state/callbacks)
//
// Key features:
// - Uses string property names with TypeScript auto-completion
// - Parameter order (value, key) for onAdd/onRemove callbacks
// - Overloaded methods for nested instance callbacks
//

type PropertyChangeCallback<K> = (currentValue: K, previousValue: K) => void;
type KeyValueCallback<K, V> = (key: K, value: V) => void;
type ValueKeyCallback<V, K> = (value: V, key: K) => void;
type InstanceChangeCallback = () => void;

// Exclude internal properties from valid property names
type PublicPropNames<T> = Exclude<NonFunctionPropNames<T>, typeof $refId> & string;

// Extract only properties that extend Collection
type CollectionPropNames<T> = Exclude<{
    [K in keyof T]: T[K] extends Collection<any, any> ? K : never
}[keyof T] & string, typeof $refId>;

// Infer the value type of a collection property
type CollectionValueType<T, K extends keyof T> =
    T[K] extends MapSchema<infer V, any> ? V :
    T[K] extends ArraySchema<infer V> ? V :
    T[K] extends Collection<any, infer V, any> ? V : never;

// Infer the key type of a collection property
type CollectionKeyType<T, K extends keyof T> =
    T[K] extends MapSchema<any, infer Key> ? Key :
    T[K] extends ArraySchema<any> ? number :
    T[K] extends Collection<infer Key, any, any> ? Key : never;

export class StateCallbackStrategy<TState extends IRef> {
    protected decoder: Decoder<TState>;
    protected uniqueRefIds: Set<number> = new Set();
    protected isTriggering: boolean = false;

    constructor(decoder: Decoder<TState>) {
        this.decoder = decoder;
        this.decoder.triggerChanges = this.triggerChanges.bind(this);
    }

    protected get callbacks() {
        return this.decoder.root.callbacks;
    }

    protected get state() {
        return this.decoder.state;
    }

    protected addCallback(
        refId: number,
        operationOrProperty: OPERATION | string,
        handler: Function
    ): () => void {
        const $root = this.decoder.root;
        return $root.addCallback(refId, operationOrProperty, handler);
    }

    protected addCallbackOrWaitCollectionAvailable<TInstance extends IRef, TReturn extends Ref>(
        instance: TInstance,
        propertyName: string,
        operation: OPERATION,
        handler: Function,
        immediate: boolean = true
    ): () => void {
        let removeHandler: () => void = () => {};
        const removeOnAdd = () => removeHandler();

        const collection = (instance as any)[propertyName] as TReturn;

        // Collection not available yet. Listen for its availability before attaching the handler.
        if (!collection || collection[$refId] === undefined) {
            let removePropertyCallback: () => void;
            removePropertyCallback = this.addCallback(
                instance[$refId],
                propertyName,
                (value: TReturn, _: TReturn) => {
                    if (value !== null && value !== undefined) {
                        // Remove the property listener now that collection is available
                        removePropertyCallback();
                        removeHandler = this.addCallback(value[$refId], operation, handler);
                    }
                }
            );
            removeHandler = removePropertyCallback;
            return removeOnAdd;

        } else {
            //
            // Call immediately if collection is already available, if it's an ADD operation.
            //
            immediate = immediate && this.isTriggering === false;

            if (operation === OPERATION.ADD && immediate) {
                (collection as Collection<any, any>).forEach((value: any, key: any) => {
                    handler(value, key);
                });
            }

            return this.addCallback(collection[$refId], operation, handler);
        }
    }

    /**
     * Listen to property changes on the root state.
     */
    listen<K extends PublicPropNames<TState>>(
        property: K,
        handler: PropertyChangeCallback<TState[K]>,
        immediate?: boolean
    ): () => void;

    /**
     * Listen to property changes on a nested instance.
     */
    listen<TInstance extends Schema, K extends PublicPropNames<TInstance>>(
        instance: TInstance,
        property: K,
        handler: PropertyChangeCallback<TInstance[K]>,
        immediate?: boolean
    ): () => void;

    listen(...args: any[]): () => void {
        if (typeof args[0] === 'string') {
            // listen(property, handler, immediate?)
            return this.listenInstance(this.state, args[0], args[1], args[2]);
        } else {
            // listen(instance, property, handler, immediate?)
            return this.listenInstance(args[0], args[1], args[2], args[3]);
        }
    }

    protected listenInstance<TInstance extends IRef>(
        instance: TInstance,
        propertyName: string,
        handler: PropertyChangeCallback<any>,
        immediate: boolean = true
    ): () => void {
        immediate = immediate && this.isTriggering === false;

        //
        // Call handler immediately if property is already available.
        //
        const currentValue = (instance as any)[propertyName];
        if (immediate && currentValue !== null && currentValue !== undefined) {
            handler(currentValue, undefined as any);
        }

        return this.addCallback(instance[$refId], propertyName, handler);
    }

    /**
     * Listen to any property change on an instance.
     */
    onChange<TInstance extends Schema>(
        instance: TInstance,
        handler: InstanceChangeCallback
    ): () => void;

    /**
     * Listen to item changes in a collection on root state.
     */
    onChange<K extends CollectionPropNames<TState>>(
        property: K,
        handler: KeyValueCallback<CollectionKeyType<TState, K>, CollectionValueType<TState, K>>
    ): () => void;

    /**
     * Listen to item changes in a nested collection.
     */
    onChange<TInstance extends Schema, K extends CollectionPropNames<TInstance>>(
        instance: TInstance,
        property: K,
        handler: KeyValueCallback<CollectionKeyType<TInstance, K>, CollectionValueType<TInstance, K>>
    ): () => void;

    onChange(...args: any[]): () => void {
        if (args.length === 2 && typeof args[0] !== 'string') {
            // onChange(instance, handler) - instance change
            const instance = args[0] as Schema;
            const handler = args[1] as InstanceChangeCallback;
            return this.addCallback(instance[$refId], OPERATION.REPLACE, handler);
        }

        if (typeof args[0] === 'string') {
            // onChange(property, handler) - collection on root state
            return this.addCallbackOrWaitCollectionAvailable(
                this.state,
                args[0],
                OPERATION.REPLACE,
                args[1]
            );
        } else {
            // onChange(instance, property, handler) - nested collection
            return this.addCallbackOrWaitCollectionAvailable(
                args[0],
                args[1],
                OPERATION.REPLACE,
                args[2]
            );
        }
    }

    /**
     * Listen to items added to a collection on root state.
     */
    onAdd<K extends CollectionPropNames<TState>>(
        property: K,
        handler: ValueKeyCallback<CollectionValueType<TState, K>, CollectionKeyType<TState, K>>,
        immediate?: boolean
    ): () => void;

    /**
     * Listen to items added to a nested collection.
     */
    onAdd<TInstance extends Schema, K extends CollectionPropNames<TInstance>>(
        instance: TInstance,
        property: K,
        handler: ValueKeyCallback<CollectionValueType<TInstance, K>, CollectionKeyType<TInstance, K>>,
        immediate?: boolean
    ): () => void;

    onAdd(...args: any[]): () => void {
        if (typeof args[0] === 'string') {
            // onAdd(property, handler, immediate?) - collection on root state
            return this.addCallbackOrWaitCollectionAvailable(
                this.state,
                args[0],
                OPERATION.ADD,
                args[1],
                args[2] !== false
            );
        } else {
            // onAdd(instance, property, handler, immediate?) - nested collection
            return this.addCallbackOrWaitCollectionAvailable(
                args[0],
                args[1],
                OPERATION.ADD,
                args[2],
                args[3] !== false
            );
        }
    }

    /**
     * Listen to items removed from a collection on root state.
     */
    onRemove<K extends CollectionPropNames<TState>>(
        property: K,
        handler: ValueKeyCallback<CollectionValueType<TState, K>, CollectionKeyType<TState, K>>
    ): () => void;

    /**
     * Listen to items removed from a nested collection.
     */
    onRemove<TInstance extends Schema, K extends CollectionPropNames<TInstance>>(
        instance: TInstance,
        property: K,
        handler: ValueKeyCallback<CollectionValueType<TInstance, K>, CollectionKeyType<TInstance, K>>
    ): () => void;

    onRemove(...args: any[]): () => void {
        if (typeof args[0] === 'string') {
            // onRemove(property, handler) - collection on root state
            return this.addCallbackOrWaitCollectionAvailable(
                this.state,
                args[0],
                OPERATION.DELETE,
                args[1]
            );
        } else {
            // onRemove(instance, property, handler) - nested collection
            return this.addCallbackOrWaitCollectionAvailable(
                args[0],
                args[1],
                OPERATION.DELETE,
                args[2]
            );
        }
    }

    /**
     * Bind properties from a Schema instance to a target object.
     * Changes will be automatically reflected on the target object.
     */
    bindTo<TInstance extends Schema, TTarget>(
        from: TInstance,
        to: TTarget,
        properties?: string[],
        immediate: boolean = true
    ): () => void {
        const metadata: Metadata = (from.constructor as typeof Schema)[Symbol.metadata];

        // If no properties specified, bind all properties
        if (!properties) {
            properties = Object.keys(metadata)
                .filter(key => !isNaN(Number(key)))
                .map((index) => metadata[index as any as number].name);
        }

        const action = () => {
            for (const prop of properties!) {
                const fromValue = (from as any)[prop];
                if (fromValue !== undefined) {
                    (to as any)[prop] = fromValue;
                }
            }
        };

        if (immediate) {
            action();
        }

        return this.addCallback(from[$refId], OPERATION.REPLACE, action);
    }

    protected triggerChanges(allChanges: DataChange[]): void {
        this.uniqueRefIds.clear();

        for (let i = 0, l = allChanges.length; i < l; i++) {
            const change = allChanges[i];
            const refId = change.refId;
            const ref = change.ref;

            const $callbacks = this.callbacks[refId];
            if (!$callbacks) {
                continue;
            }

            //
            // trigger onRemove on child structure.
            //
            if (
                (change.op & OPERATION.DELETE) === OPERATION.DELETE &&
                Schema.isSchema(change.previousValue)
            ) {
                const childRefId = (change.previousValue as Ref)[$refId];
                const deleteCallbacks = this.callbacks[childRefId]?.[OPERATION.DELETE];
                if (deleteCallbacks) {
                    for (let j = deleteCallbacks.length - 1; j >= 0; j--) {
                        deleteCallbacks[j]();
                    }
                }
            }

            if (Schema.isSchema(ref)) {
                //
                // Handle Schema instance
                //

                if (!this.uniqueRefIds.has(refId)) {
                    // trigger onChange
                    const replaceCallbacks = $callbacks[OPERATION.REPLACE];
                    if (replaceCallbacks) {
                        for (let j = replaceCallbacks.length - 1; j >= 0; j--) {
                            try {
                                replaceCallbacks[j]();
                            } catch (e) {
                                console.error(e);
                            }
                        }
                    }
                }

                // trigger field callbacks
                const fieldCallbacks = $callbacks[change.field];
                if (fieldCallbacks) {
                    for (let j = fieldCallbacks.length - 1; j >= 0; j--) {
                        try {
                            this.isTriggering = true;
                            fieldCallbacks[j](change.value, change.previousValue);
                        } catch (e) {
                            console.error(e);
                        } finally {
                            this.isTriggering = false;
                        }
                    }
                }

            } else {
                //
                // Handle collection of items
                //
                const dynamicIndex = change.dynamicIndex ?? change.field;

                if ((change.op & OPERATION.DELETE) === OPERATION.DELETE) {
                    //
                    // FIXME: `previousValue` should always be available.
                    //
                    if (change.previousValue !== undefined) {
                        // trigger onRemove (value, key)
                        const deleteCallbacks = $callbacks[OPERATION.DELETE];
                        if (deleteCallbacks) {
                            for (let j = deleteCallbacks.length - 1; j >= 0; j--) {
                                deleteCallbacks[j](change.previousValue, dynamicIndex);
                            }
                        }
                    }

                    // Handle DELETE_AND_ADD operation
                    if ((change.op & OPERATION.ADD) === OPERATION.ADD) {
                        const addCallbacks = $callbacks[OPERATION.ADD];
                        if (addCallbacks) {
                            this.isTriggering = true;
                            for (let j = addCallbacks.length - 1; j >= 0; j--) {
                                addCallbacks[j](change.value, dynamicIndex);
                            }
                            this.isTriggering = false;
                        }
                    }

                } else if (
                    (change.op & OPERATION.ADD) === OPERATION.ADD &&
                    change.previousValue !== change.value
                ) {
                    // trigger onAdd (value, key)
                    const addCallbacks = $callbacks[OPERATION.ADD];
                    if (addCallbacks) {
                        this.isTriggering = true;
                        for (let j = addCallbacks.length - 1; j >= 0; j--) {
                            addCallbacks[j](change.value, dynamicIndex);
                        }
                        this.isTriggering = false;
                    }
                }

                // trigger onChange (key, value)
                if (change.value !== change.previousValue) {
                    const replaceCallbacks = $callbacks[OPERATION.REPLACE];
                    if (replaceCallbacks) {
                        for (let j = replaceCallbacks.length - 1; j >= 0; j--) {
                            replaceCallbacks[j](dynamicIndex, change.value);
                        }
                    }
                }
            }

            this.uniqueRefIds.add(refId);
        }
    }
}

/**
 * Factory class for retrieving the callbacks API.
 */
export const Callbacks = {
    /**
     * Get the new callbacks standard API.
     *
     * Usage:
     * ```ts
     * const callbacks = Callbacks.get(roomOrDecoder);
     *
     * // Listen to property changes
     * callbacks.listen("currentTurn", (currentValue, previousValue) => { ... });
     *
     * // Listen to collection additions
     * callbacks.onAdd("entities", (entity, sessionId) => {
     *     // Nested property listening
     *     callbacks.listen(entity, "hp", (currentHp, previousHp) => { ... });
     * });
     *
     * // Listen to collection removals
     * callbacks.onRemove("entities", (entity, sessionId) => { ... });
     *
     * // Listen to any property change on an instance
     * callbacks.onChange(entity, () => { ... });
     *
     * // Bind properties to another object
     * callbacks.bindTo(player, playerVisual);
     * ```
     *
     * @param roomOrDecoder - Room or Decoder instance to get the callbacks for.
     * @returns the new callbacks standard API.
     */
    get<T extends IRef>(
        roomOrDecoder: Decoder<T> | { serializer: { decoder: Decoder<T> } } | { state: T; serializer: object }
    ): StateCallbackStrategy<T> {
        if (roomOrDecoder instanceof Decoder) {
            return new StateCallbackStrategy<T>(roomOrDecoder);

        } else if ('decoder' in roomOrDecoder.serializer) {
            return new StateCallbackStrategy<T>(roomOrDecoder.serializer.decoder);

        } else {
            throw new Error('Invalid room or decoder');
        }
    },

    /**
     * Get the legacy callbacks API.
     *
     * We aim to deprecate this API on 1.0, and iterate on improving Callbacks.get() API.
     *
     * @param roomOrDecoder - Room or Decoder instance to get the legacy callbacks for.
     * @returns the legacy callbacks API.
     */
    getLegacy<T extends Schema>(
        roomOrDecoder: Decoder<T> | { serializer: { decoder: Decoder<T> } } | { state: T; serializer: object }
    ): SchemaCallbackProxy<T> {
        if (roomOrDecoder instanceof Decoder) {
            return getDecoderStateCallbacks(roomOrDecoder);

        } else if ('decoder' in roomOrDecoder.serializer) {
            return getDecoderStateCallbacks(roomOrDecoder.serializer.decoder);
        }
    },

    getRawChanges(decoder: Decoder, callback: (changes: DataChange[]) => void) {
        return getRawChangesCallback(decoder, callback);
    }
};

