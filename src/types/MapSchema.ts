export class MapSchema<T=any> {
    constructor (obj: any = {}) {
        for (let key in obj) {
            this[key] = obj[key];
        }

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
                    const map = Object.assign(new MapSchema(), this);;
                    map.onAdd = this.onAdd;
                    map.onRemove = this.onRemove;
                    return map;
                }
            }
        });
    }

    [key: string]: T | any;

    clone: () => MapSchema<T>;
    onAdd: (item: T, key: string) => void;
    onRemove: (item: T, key: string) => void;
}
