import { Class, Property, File, getCommentHeader, getInheritanceTree, Context } from "../types";
import { GenerateOptions } from "../api";

/**
    TODO:
    - Support inheritance
    - Support importing Schema dependencies
*/

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

export function generate (context: Context, options: GenerateOptions): File[] {
    return context.classes.map(klass => ({
        name: klass.name + ".lua",
        content: generateClass(klass, options.namespace, context.classes)
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

    // Inheritance support
    const inherits = (klass.extends !== "Schema")
        ? `, ${klass.extends}`
        : "";

    return `${getCommentHeader().replace(/\/\//mg, "--")}

local schema = require 'colyseus.serializer.schema.schema'
${allRefs.
    filter(ref => ref.childType && typeMaps[ref.childType] === undefined).
    map(ref => ref.childType).
    concat(getInheritanceTree(klass, allClasses, false).map(klass => klass.name)).
    filter(distinct).
    map(childType => `local ${childType} = require '${(namespace ? `${namespace}.` : '')}${childType}'`).
    join("\n")}

---@class ${klass.name}: ${klass.extends}
${klass.properties.map(prop => `---@field ${prop.name} ${getLUATypeAnnotation(prop)}`).join("\n")}
local ${klass.name} = schema.define({
${klass.properties.map(prop => generatePropertyDeclaration(prop)).join(",\n")},
    ["_fields_by_index"] = { ${klass.properties.map(prop => `"${prop.name}"`).join(", ")} },
}${inherits})

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
            typeArgs = (isUpcaseFirst)
                ? `${prop.childType}`
                : `"${prop.childType}"`;

        } else {
            typeArgs = (isUpcaseFirst)
                ? `{ ${prop.type} = ${prop.childType} }`
                : `{ ${prop.type} = "${prop.childType}" }`;
        }

    } else {
        typeArgs = `"${prop.type}"`;
    }

    return `    ["${prop.name}"] = ${typeArgs}`;
}

function getLUATypeAnnotation(prop: Property) {
    if (prop.type === "ref") {
        return prop.childType;

    } else if (prop.type === "array") {
        return "ArraySchema";

    } else if (prop.type === "map") {
        return "MapSchema";

    } else {
        return typeMaps[prop.type];
    }
}