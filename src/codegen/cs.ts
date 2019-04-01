import { Class, Property, File, getCommentHeader } from "./types";

const typeMaps = {
    "string": "string",
    "number": "float",
    "boolean": "bool",
    "int8": "int",
    "uint8": "uint",
    "int16": "short",
    "uint16": "ushort",
    "int32": "int",
    "uint32": "uint",
    "int64": "long",
    "uint64": "ulong",
    "float32": "float",
    "float64": "double",
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

const capitalize = (s) => {
    if (typeof s !== 'string') return ''
    return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * C# Code Generator
 */

export function generate (classes: Class[], args: any): File[] {
    return classes.map(klass => ({
        name: klass.name + ".cs",
        content: generateClass(klass, args.namespace)
    }));
}

function generateClass(klass: Class, namespace: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}

using Colyseus.Schema;
${namespace ? `\nnamespace ${namespace} {` : ""}
${indent}public class ${klass.name} : Schema {
${klass.properties.map(prop => generateProperty(prop, indent)).join("\n\n")}
${generateConstructor(klass.name, indent)}
${klass.properties.map(function (prop) { return generateFieldDelegates(prop, indent); }).join("")}
${generateOnChangeMethodPart1(indent)}
${klass.properties.map(function (prop) { return generateFieldCases(prop, indent); }).join("")}
${generateOnChangeMethodPart2(indent)}
${indent}}
${namespace ? "}" : ""}
`;
}

function generateProperty(prop: Property, indent: string = "") {
    let typeArgs = `"${prop.type}"`;
    let property = "public";
    let langType: string;
    let initializer = "";

    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        if(prop.type === "ref") {
            langType = (isUpcaseFirst)
                ? prop.childType
                : typeMaps[prop.childType];

        } else if(prop.type === "array") {
            langType = (isUpcaseFirst)
                ? `ArraySchema<${prop.childType}>`
                : `ArraySchema<${typeMaps[prop.childType]}>`;

        } else if(prop.type === "map") {
            langType = (isUpcaseFirst)
                ? `MapSchema<${prop.childType}>`
                : `MapSchema<${typeMaps[prop.childType]}>`;
        }

        typeArgs += `, typeof(${langType})`;
        initializer = `new ${langType}()`;

    } else {
        langType = typeMaps[prop.type];
        initializer = typeInitializer[prop.type];
    }

    property += ` ${langType} ${prop.name}`;

    return `\t${indent}[Type(${typeArgs})]
\t${indent}${property} = ${initializer};`
}


function generateFieldCases(prop, indent) {
    if (indent === void 0) { indent = ""; }
    var langType = typeMaps[prop.type];
    
    if(!langType) return null;

    var capitalizedPropName = capitalize(prop.name);
   
    var codeBlock = `
    ${indent}\t\t\tcase "${prop.name}":
    ${indent}\t\t\t    On${capitalizedPropName}Change.Invoke(this, (${langType})obj.Value);
    ${indent}\t\t\t    break;
    ${indent}\t\t\t`;

    return codeBlock;
}

function generateOnChangeMethodPart1(indent) {
   
    var codeBlock = `
    ${indent}private void OnPropertyChange(object sender, OnChangeEventArgs e)
    ${indent}{
    ${indent}    e.Changes.ForEach((DataChange obj) =>
    ${indent}    {
    ${indent}        switch (obj.Field)
    ${indent}        {`

    return codeBlock;
}

function generateOnChangeMethodPart2(indent) {
   
    var codeBlock = `
    ${indent}        }
    ${indent}    });
    ${indent}}`

    return codeBlock;
}

function generateConstructor(className, indent) {
   
    var codeBlock = `
    ${indent}public ${className}() : base()
    ${indent}{
    ${indent}    this.OnChange += OnPropertyChange;
    ${indent}}`

    return codeBlock;
}

function generateFieldDelegates(prop, indent) {
    if (indent === void 0) { indent = ""; }
    var langType = typeMaps[prop.type];
    
    if(!langType) return null;

    var capitalizedPropName = capitalize(prop.name);
   
    var codeBlock = `
    ${indent}public event System.EventHandler<${langType}> On${capitalizedPropName}Change;`

    return codeBlock;
}
