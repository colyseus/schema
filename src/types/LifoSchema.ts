import { ArraySchema } from "./ArraySchema";

export class LifoSchema<V=any> extends ArraySchema{
    stackSize: number;

    constructor (stackSize: number) {
        super();
        this.stackSize = stackSize;
    }

    push(...values: V[]) {
        let lastIndex: number;
        values.forEach((v) => {
            if(this.stackSize && this.length >= this.stackSize){
                super.shift();
            }
            lastIndex = super.push(v);
        }, this);
        return lastIndex;
    }

}