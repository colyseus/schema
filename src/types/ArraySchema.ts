export class ArraySchema<T=any> extends Array<T> {
    static get [Symbol.species](): ArrayConstructor { return Array; }

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

    clone: () => ArraySchema<T>;
    onAdd: (item: T, index: number) => void;
    onRemove: (item: T, index: number) => void;
}
