import { nonenumerable } from "nonenumerable";

export class ArraySchema<T=any> extends Array<T> {
    constructor (...items: T[]) {
        super(...items);

        Object.setPrototypeOf(this, Object.create(ArraySchema.prototype));
        Object.defineProperties(this, {
            onAdd: {
                value: undefined,
                enumerable: false,
                writable: true
            },
            onRemove: {
                value: undefined,
                enumerable: false,
                writable: true
            },
            clone: {
                value: () => {
                    const arr = new ArraySchema(...this);
                    arr.onAdd = this.onAdd;
                    arr.onRemove = this.onRemove;
                    return arr;
                }
            }
        });
    }

    static get [Symbol.species](): ArrayConstructor { return Array; }

    clone: () => ArraySchema<T>;
    onAdd: (item: T) => void;
    onRemove: (item: T) => void;
}
