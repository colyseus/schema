import { Schema, type } from "../../../src";

export class BaseSchema<T=any> extends Schema {
    @type("number") id: number;

    protected $$behaviours: any[] = [];

    protected handleEvent(type: string, args: any) {
        for (let i = 0; i < this.$$behaviours.length; i++) {
            let behaviour = this.$$behaviours[i];
            if (behaviour.type == type) {
                behaviour.handleEvent(args);
            }
        }
    }


}
