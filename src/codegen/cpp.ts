import { Class, Property, File, getCommentHeader } from "./types";

const typeMaps = {
    "string": "string",
    "number": "varint_t",
    "boolean": "bool",
    "int8": "int8_t",
    "uint8": "uint8_t",
    "int16": "int16_t",
    "uint16": "uint16_t",
    "int32": "int32_t",
    "uint32": "uint32_t",
    "int64": "int64_t",
    "uint64": "uint64_t",
    "float32": "float32_t",
    "float64": "float64_t",
}

const typeInitializer = {
    "string": '""',
    "number": "0",
    "boolean": "false",
    "int8": "0",
    "uint8": "0",
    "int16": "0",
    "uint16": "0",
    "int32": "0",
    "uint32": "0",
    "int64": "0",
    "uint64": "0",
    "float32": "0",
    "float64": "0",
}

/**
 * C++ Code Generator
 */

const capitalize = (s) => {
    if (typeof s !== 'string') return ''
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export function generate (classes: Class[], args: any): File[] {
    return classes.map(klass => ({
        name: klass.name + ".hpp",
        content: generateClass(klass, args.namespace)
    }));
}

function generateClass(klass: Class, namespace: string) {
    const propertiesPerType: {[type: string]: Property[]} = {};
    klass.properties.forEach(property => {
        if (!propertiesPerType[property.type]) {
            propertiesPerType[property.type] = [];
        }
        propertiesPerType[property.type].push(property);
    });

    return `${getCommentHeader()}
using namespace colyseus::schema;

${namespace ? `namespace ${namespace} {` : ""}
class ${klass.name} : public ${klass.extends} {
public:
${klass.properties.map(prop => generateProperty(prop)).join("\n")}

protected:
${Object.keys(propertiesPerType).map(type => 
    generateGettersAndSetters(type, propertiesPerType[type])).
    join("\n")}
}
${namespace ? "}" : ""}
`;
}

function generateProperty(prop: Property) {
    let property = "";
    let langType: string;
    let initializer = "";

    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        if(prop.type === "ref") {
            langType = `${prop.childType}*`;
            initializer = `new ${prop.childType}()`;

        } else if(prop.type === "array") {
            langType = (isUpcaseFirst)
                ? `ArraySchema<${prop.childType}*>`
                : `ArraySchema<${typeMaps[prop.childType]}>`;
            initializer = `new ${langType}()`;

        } else if(prop.type === "map") {
            langType = (isUpcaseFirst)
                ? `MapSchema<${prop.childType}*>`
                : `MapSchema<${typeMaps[prop.childType]}>`;
            initializer = `new ${langType}()`;
        }


    } else {
        langType = typeMaps[prop.type];
        initializer = typeInitializer[prop.type];
    }

    property += ` ${langType} ${prop.name}`;

    return `\t${property} = ${initializer};`
}

function generateGettersAndSetters(type: string, properties: Property[]) {
    if (type === "ref") {

    } else if (type === "array") {

    } else if (type === "map") {

    } else {
        const langType = typeMaps[type];
        return `\t${langType} get${capitalize(type)}(string field)
\t{
\t\t${generateFieldIfElseChain(properties, (currentProperty) => (
    `return this->${currentProperty.name};`
))}
\t\treturn ${typeInitializer[type]};
\t}

\tvoid set${capitalize(type)}(string field, ${langType} value)
\t{
\t\t${generateFieldIfElseChain(properties, (currentProperty) => (
    `this->${currentProperty.name} = value;`
))}
\t}`;
    }
}

function generateFieldIfElseChain(properties: Property[], callback: (currentProperty: Property) => string) {
    let chain = "";

    properties.forEach((property, i) => {
        if (i === 0) { chain += "if " } else { chain += " else if " }
        chain += `(field == "${property.name}")
\t\t{
\t\t\t${callback(property)}\n
\t\t}`
    });

    return chain;
}