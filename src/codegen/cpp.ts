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
const distinct = (value, index, self) => self.indexOf(value) === index;

export function generate (classes: Class[], args: any): File[] {
    return classes.map(klass => ({
        name: klass.name + ".hpp",
        content: generateClass(klass, args.namespace, classes)
    }));
}

function generateClass(klass: Class, namespace: string, allClasses: Class[]) {
    const propertiesPerType: {[type: string]: Property[]} = {};
    const allRefs: Property[] = [];
    klass.properties.forEach(property => {
        let type = property.type;

        if (!propertiesPerType[type]) {
            propertiesPerType[type] = [];
        }

        propertiesPerType[type].push(property);

        // keep all refs list
        if ((type === "ref" || type === "array" || type === "map")) {
            allRefs.push(property);
        }
    });

    const allProperties = getAllProperties(klass, allClasses);
    const createInstanceMethod = (allRefs.length === 0) ? "" : 
    `\tSchema* createInstance(std::type_index type) {
\t\t${generateFieldIfElseChain(allRefs, 
    (property) => `type == typeof(${property.childType})`,
    (property) => `return new ${property.childType}();`,
    (property) => typeMaps[property.childType] === undefined)}
\t\treturn ${klass.extends}::createInstance(field);
\t}`;

    return `${getCommentHeader()}
#ifndef __SCHEMA_CODEGEN_${klass.name.toUpperCase()}_H__
#define __SCHEMA_CODEGEN_${klass.name.toUpperCase()}_H__ 1

${allRefs.
    map(ref => ref.childType).
    filter(distinct).
    map(childType => `#include "${childType}.hpp"`).
    join("\n")}

using namespace colyseus::schema;

${namespace ? `namespace ${namespace} {` : ""}
class ${klass.name} : public ${klass.extends} {
public:
${klass.properties.map(prop => generateProperty(prop)).join("\n")}

\t${klass.name}() {
\t\tthis->_indexes = ${generateAllIndexes(allProperties)};
\t\tthis->_types = ${generateAllTypes(allProperties)};
\t\tthis->_childPrimitiveTypes = ${generateAllChildPrimitiveTypes(allProperties)};
\t\tthis->_childSchemaTypes = ${generateAllChildSchemaTypes(allProperties)};
\t}

protected:
${Object.keys(propertiesPerType).map(type => 
    generateGettersAndSetters(klass, type, propertiesPerType[type])).
    join("\n")}

${createInstanceMethod}
}
${namespace ? "}" : ""}

#endif
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

function generateGettersAndSetters(klass: Class, type: string, properties: Property[]) {
    let langType = typeMaps[type];
    let typeCast = "";
    const methodName = `get${capitalize(type)}`;

    if (type === "ref") {
        langType = "Schema*";

    } else if (type === "array") {
        langType = `ArraySchema<T>*`;

    } else if (type === "map") {
        langType = `MapSchema<T>*`;
        typeCast = `*(MapSchema<Player*> *)&`;
    }

    return `\t${langType} ${methodName}(string field)
\t{
\t\t${generateFieldIfElseChain(properties, 
    (property) => `field == "${property.name}"`,
    (property) => `return this->${property.name};`)}
\t\treturn ${klass.extends}::${methodName}(field);
\t}

\tvoid set${capitalize(type)}(string field, ${langType} value)
\t{
\t\t${generateFieldIfElseChain(properties,
    (property) => `field == "${property.name}"`,
    (property) => `this->${property.name} = ${typeCast}value;`)}
\t}`;
}

function generateFieldIfElseChain(
    properties: Property[],
    ifCallback: (property: Property) => string,
    callback: (property: Property) => string,
    filter: (property: Property) => boolean = (_) => true,
) {
    let chain = "";

    const uniqueChecks: string[] = [];
    properties.filter(filter).forEach((property, i) => {
        const check = ifCallback(property);
        if (uniqueChecks.indexOf(check) === -1) {
            uniqueChecks.push(check);

        } else {
            return;
        }

        if (i === 0) { chain += "if " } else { chain += " else if " }
        chain += `(${check})
\t\t{
\t\t\t${callback(property)}\n
\t\t}`
    });

    return chain;
}

function generateAllIndexes(properties: Property[]) {
    return `{${properties.map((property, i) => `{${i}, "${property.name}"}`).join(", ")}}`

}

function generateAllTypes(properties: Property[]) {
    return `{${properties.map((property, i) => `{${i}, "${property.type}"}`).join(", ")}}`
}

function generateAllChildSchemaTypes(properties: Property[]) {
    return `{${properties.map((property, i) => {
        if (property.childType && typeMaps[property.childType] === undefined) {
            return `{${i}, typeid(${property.childType})}`
        } else {
            return null;
        }
    }).filter(r => r !== null).join(", ")}}`
}

function generateAllChildPrimitiveTypes(properties: Property[]) {
    return `{${properties.map((property, i) => {
        if (typeMaps[property.childType] !== undefined) {
            return `{${i}, "${property.childType}"}`
        } else {
            return null;
        }
    }).filter(r => r !== null).join(", ")}}`
}

function getAllProperties (klass: Class, allClasses: Class[]) {
    let properties: Property[] = [];

    let currentClass = klass;
    let inheritanceTree = [currentClass];
    while (currentClass.extends !== "Schema") {
        currentClass = allClasses.find(klass => klass.name == currentClass.extends);
        inheritanceTree.push(currentClass);
    }

    inheritanceTree.reverse().forEach((klass) => {
        properties = properties.concat(klass.properties);
    });

    return properties;
}