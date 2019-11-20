const schema = require("@colyseus/schema");
const Schema = schema.Schema;
const defineTypes = schema.defineTypes;

class DefineTypes extends Schema {
    constructor () {
        super();
    }

    someProblematicMethod(type) {
        switch (type) {
            case 1:
                //logic
                break;
            case 2:
                //logic
                break;
            default:
                throw new Error('Dummy error');
        }
    }
}

schema.defineTypes(DefineTypes, {
    str: "string",
    type: "number"
});

module.DefineTypes = DefineTypes;
