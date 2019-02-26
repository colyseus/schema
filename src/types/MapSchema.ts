export class MapSchema<T=any> {
    constructor (obj: any = {}) {
        for (let key in obj) {
            this[key] = obj[key];
        }

        Object.defineProperties(this, {
            onAdd:    { value: undefined, enumerable: false, writable: true },
            onRemove: { value: undefined, enumerable: false, writable: true },
            onChange: { value: undefined, enumerable: false, writable: true },

            clone: {
                value: () => {
                    const map = Object.assign(new MapSchema(), this);;
                    map.onAdd = this.onAdd;
                    map.onRemove = this.onRemove;
                    return map;
                }
            },

            _indexes: { value: {},        enumerable: false, writable: true },
            _removedIndexes: { value: [], enumerable: false, writable: true },
            _removeIndexes: {
                value: () => {
                    for (const index of this._removedIndexes) {
                        for (const field in this._indexes) {
                            if (this._indexes[field] > index) {
                                this._indexes[field]--;
                            }
                        }
                    }
                }
            },
        });
    }

    [key: string]: T | any;

    clone: () => MapSchema<T>;

    onAdd: (item: T, key: string) => void;
    onRemove: (item: T, key: string) => void;
    onChange: (item: T, key: string) => void;

    _indexes: { [id: string]: number };
    _removedIndexes: number[];
    _removeIndexes: () => void;
}
