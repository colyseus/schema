import { ChangeTree } from "../ChangeTree";

export class ArraySchema<T=any> extends Array<T> {
    static get [Symbol.species](): ArrayConstructor { return Array; }

    protected $changes: ChangeTree;

    constructor (...items: T[]) {
        super(...items);

        Object.setPrototypeOf(this, Object.create(ArraySchema.prototype));
        Object.defineProperties(this, {
            $changes:     { value: undefined, enumerable: false, writable: true },

            onAdd:        { value: undefined, enumerable: false, writable: true },
            onRemove:     { value: undefined, enumerable: false, writable: true },
            onChange:     { value: undefined, enumerable: false, writable: true },

            triggerAll: {
                value: () => {
                    if (!this.onAdd) {
                        return;
                    }

                    for (let i = 0; i < this.length; i++) {
                        this.onAdd(this[i], i);
                    }
                }
            },

            clone: {
                value: () => {
                    const arr = new ArraySchema(...this);
                    arr.onAdd = this.onAdd;
                    arr.onRemove = this.onRemove;
                    arr.onChange = this.onChange;
                    return arr;
                }
            }
        });
    }

    clone: () => ArraySchema<T>;

    onAdd: (item: T, index: number) => void;
    onRemove: (item: T, index: number) => void;
    onChange: (item: T, index: number) => void;

    triggerAll: () => void;
}
