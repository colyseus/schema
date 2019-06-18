import { ChangeTree } from "../ChangeTree";

export class ArraySchema<T=any> extends Array<T> {
    protected $sorting: boolean;
    protected $changes: ChangeTree;

    // static get [Symbol.species](): any { return ArraySchema; }

    constructor (...items: T[]) {
        super(...items);

        Object.setPrototypeOf(this, Object.create(ArraySchema.prototype));
        Object.defineProperties(this, {
            $sorting:     { value: undefined, enumerable: false, writable: true },
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
    sort(compareFn?: (a: T, b: T) => number): this {
        this.$sorting = true;
        super.sort(compareFn);

        const changes = this.$changes.changes;
        for (const key of changes) {
            // track index change
            const previousIndex = this.$changes.getIndex(this[key]);
            if (previousIndex !== undefined) {
                this.$changes.mapIndexChange(this[key], previousIndex);
            }
            this.$changes.mapIndex(this[key], key);
        }

        this.$sorting = false;
        return this;
    }

    splice(start: number, deleteCount?: number, ...insert: T[]) {
        const removedItems = Array.prototype.splice.apply(this, arguments);

        removedItems.map(removedItem => {
            delete (removedItem as any).$changes.parent;
        });

        return removedItems;
    }

    onAdd: (item: T, index: number) => void;
    onRemove: (item: T, index: number) => void;
    onChange: (item: T, index: number) => void;

    triggerAll: () => void;
}
