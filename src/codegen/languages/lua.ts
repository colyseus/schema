import { Class, Property, File, getCommentHeader, getInheritanceTree } from "../types";

const typeMaps = {
    "string": "string",
    "number": "number",
    "boolean": "boolean",
    "int8": "number",
    "uint8": "number",
    "int16": "number",
    "uint16": "number",
    "int32": "number",
    "uint32": "number",
    "int64": "number",
    "uint64": "number",
    "float32": "number",
    "float64": "number",
}

const distinct = (value, index, self) => self.indexOf(value) === index;

export function generate (classes: Class[], args: any): File[] {
    return classes.map(klass => ({
        name: klass.name + ".lua",
        content: generateClass(klass, args.namespace, classes)
    }));
}

function generateClass(klass: Class, namespace: string, allClasses: Class[]) {
    const allRefs: Property[] = [];
    klass.properties.forEach(property => {
        let type = property.type;

        // keep all refs list
        if ((type === "ref" || type === "array" || type === "map")) {
            allRefs.push(property);
        }
    });

// TOOD: inheritance
// ${allRefs.
//     filter(ref => ref.childType && typeMaps[ref.childType] === undefined).
//     map(ref => ref.childType).
//     concat(getInheritanceTree(klass, allClasses, false).map(klass => klass.name)).
//     filter(distinct).
//     map(childType => `const ${childType} = require("./${childType}");`).
//     join("\n")}

    return `${getCommentHeader().replace(/\/\//mg, "--")}

local schema = require 'colyseus.serialization.schema.schema'

local ${klass.name} = schema.define({
${klass.properties.map(prop => generatePropertyDeclaration(prop)).join(",\n")},
    ["_order"] = { ${klass.properties.map(prop => `"${prop.name}"`).join(", ")} },

    ["on_change"] = function(changes)
        -- on change logic here
    end,

    ["on_add"] = function()
        -- on add logic here
     end,

    ["on_remove"] = function()
        -- on remove logic here
    end,
})

return ${klass.name}
`;
}

function generatePropertyDeclaration(prop: Property) {
    let typeArgs: string;

    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        if (isUpcaseFirst) {
            typeArgs += `${prop.childType}`;

        } else {
            typeArgs += `"${prop.childType}"`;
        }

        if(prop.type === "ref") {
            typeArgs = `${prop.childType}`;

        } else if(prop.type === "array") {
            typeArgs = `{ ${prop.childType} }`;

        } else if(prop.type === "map") {
            typeArgs = `{ map = ${prop.childType} }`;
        }

    } else {
        typeArgs = `"${prop.type}"`;
    }

    return `    ["${prop.name}"] = ${typeArgs}`;
}

// function generatePropertyInitializer(prop: Property) {
//     let initializer = "";

//     if(prop.type === "ref") {
//         initializer = `new ${prop.childType}()`;

//     } else if(prop.type === "array") {
//         initializer = `new schema.ArraySchema()`;

//     } else if(prop.type === "map") {
//         initializer = `new schema.MapSchema()`;
//     }

//     return `this.${prop.name} = ${initializer}`;
// }
