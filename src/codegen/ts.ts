import { Class, Property, File, getCommentHeader, getInheritanceTree } from "./types";

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
        name: klass.name + ".ts",
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

    return `${getCommentHeader()}

import { Schema, type, ArraySchema, MapSchema, DataChange } from "@colyseus/schema";
${allRefs.
    filter(ref => ref.childType && typeMaps[ref.childType] === undefined).
    map(ref => ref.childType).
    concat(getInheritanceTree(klass, allClasses, false).map(klass => klass.name)).
    filter(distinct).
    map(childType => `import { ${childType} } from "./${childType}"`).
    join("\n")}

export class ${klass.name} extends ${klass.extends} {
${klass.properties.map(prop => `    ${generateProperty(prop)}`).join("\n")}

    constructor () {
        super();

        // initialization logic here.
    }

    onChange (changes: DataChange[]) {
        // onChange logic here.
    }

    onAdd () {
        // onAdd logic here.
    }

    onRemove () {
        // onRemove logic here.
    }

}
`;
}

function generateProperty(prop: Property) {
    let langType: string;
    let initializer = "";
    let typeArgs: string;

    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        if (isUpcaseFirst) {
            typeArgs += `, ${prop.childType}`;

        } else {
            typeArgs += `, "${prop.childType}"`;
        }

        if(prop.type === "ref") {
            langType = `${prop.childType}`;
            initializer = `new ${prop.childType}()`;
            typeArgs = `${prop.childType}`;

        } else if(prop.type === "array") {
            langType = (isUpcaseFirst)
                ? `ArraySchema<${prop.childType}>`
                : `ArraySchema<${typeMaps[prop.childType]}>`;
            initializer = `new ${langType}()`;
            typeArgs = `[ ${prop.childType} ]`;

        } else if(prop.type === "map") {
            langType = (isUpcaseFirst)
                ? `MapSchema<${prop.childType}>`
                : `MapSchema<${typeMaps[prop.childType]}>`;
            initializer = `new ${langType}()`;
            typeArgs = `{ map: ${prop.childType} }`;
        }

    } else {
        langType = typeMaps[prop.type];
        typeArgs = `"${prop.type}"`;
    }

    return `@type(${typeArgs}) public ${prop.name}: ${langType}${(initializer) ? ` = ${initializer}` : ""};`
}
