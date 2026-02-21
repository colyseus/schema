import { Class, Property, File, getCommentHeader, getInheritanceTree, Context } from "../types.js";
import { GenerateOptions } from "../api.js";

export const name = "LUA";

/**
    TODO:
    - Support inheritance
    - Support importing Schema dependencies
*/

const typeMaps: { [key: string]: string } = {
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

const COMMON_IMPORTS = `local schema = require 'colyseus.serializer.schema.schema'`;

const distinct = (value: string, index: number, self: string[]) =>
    self.indexOf(value) === index;

/**
 * Generate individual files for each class
 */
export function generate (context: Context, options: GenerateOptions): File[] {
    return context.classes.map(klass => ({
        name: klass.name + ".lua",
        content: generateClass(klass, options.namespace, context.classes)
    }));
}

/**
 * Generate a single bundled file containing all classes
 */
export function renderBundle(context: Context, options: GenerateOptions): File {
    const fileName = options.namespace ? `${options.namespace}.lua` : "schema.lua";

    const classBodies = context.classes.map(klass => generateClassBody(klass));
    const classNames = context.classes.map(klass => `    ${klass.name} = ${klass.name},`).join("\n");

    const content = `${getCommentHeader().replace(/\/\//mg, "--")}

${COMMON_IMPORTS}

${classBodies.join("\n\n")}

return {
${classNames}
}
`;

    return { name: fileName, content };
}

/**
 * Generate just the class body (without requires) for bundling
 */
function generateClassBody(klass: Class): string {
    // Inheritance support
    const inherits = (klass.extends !== "Schema")
        ? `, ${klass.extends}`
        : "";

    return `---@class ${klass.name}: ${klass.extends}
${klass.properties.map(prop => `---@field ${prop.name} ${getLUATypeAnnotation(prop)}`).join("\n")}
local ${klass.name} = schema.define({
${klass.properties.map(prop => generatePropertyDeclaration(prop)).join(",\n")},
    ["_fields_by_index"] = { ${klass.properties.map(prop => `"${prop.name}"`).join(", ")} },
}${inherits})`;
}

/**
 * Generate a complete class file with requires (for individual file mode)
 */
function generateClass(klass: Class, namespace: string, allClasses: Class[]) {
    const allRefs: Property[] = [];
    klass.properties.forEach(property => {
        let type = property.type;

        // keep all refs list
        if ((type === "ref" || type === "array" || type === "map")) {
            allRefs.push(property);
        }
    });

    const localRequires = allRefs.
        filter(ref => ref.childType && typeMaps[ref.childType] === undefined).
        map(ref => ref.childType).
        concat(getInheritanceTree(klass, allClasses, false).map(klass => klass.name)).
        filter(distinct).
        map(childType => `local ${childType} = require '${(namespace ? `${namespace}.` : '')}${childType}'`).
        join("\n");

    return `${getCommentHeader().replace(/\/\//mg, "--")}

${COMMON_IMPORTS}
${localRequires}

${generateClassBody(klass)}

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