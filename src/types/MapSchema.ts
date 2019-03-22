import { ChangeTree } from "../ChangeTree";

export class MapSchema<T=any> {
    protected $changes: ChangeTree;

    constructor (obj: any = {}) {
        for (let key in obj) {
            this[key] = obj[key];
        }

        Object.defineProperties(this, {
            $changes:     { value: new ChangeTree(), enumerable: false, writable: true },

            onAdd:        { value: undefined, enumerable: false, writable: true },
            onRemove:     { value: undefined, enumerable: false, writable: true },
            onChange:     { value: undefined, enumerable: false, writable: true },

            clone: {
                value: () => {
                    const map = Object.assign(new MapSchema(), this);
                    map.onAdd = this.onAdd;
                    map.onRemove = this.onRemove;
                    return map;
                }
            },

            _indexes: { value: {},        enumerable: false, writable: true },
            _updateIndexes: {
                value: () => {
                    let index: number = 0;

                    let indexes: any = {};
                    for (let key in this) {
                        indexes[key] = index++;
                    }

                    this._indexes = indexes;
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
    _updateIndexes: () => void;
}
