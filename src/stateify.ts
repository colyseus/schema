import * as ts from "typescript";
import { readFileSync } from "fs";

class Property {
    name: string;
    type: string;
}

class Class {
    name: string;
    properties: Property[] = [];
}

const classes: Class[] = [];
let currentClass: Class;
let currentProperty: Property;

function inspectNode(node: ts.Node) {
    switch (node.kind) {
        case ts.SyntaxKind.ClassDeclaration:
            currentClass = new Class();;
            classes.push(currentClass);
            break;
        case ts.SyntaxKind.PropertyDeclaration:
            break;

        case ts.SyntaxKind.Identifier:
            if (node.parent.kind === ts.SyntaxKind.ClassDeclaration) {
                currentClass.name = node.getText();

            } else if (node.parent.kind === ts.SyntaxKind.PropertyDeclaration) {
                currentProperty = new Property();
                currentProperty.name = node.getText();
                currentClass.properties.push(currentProperty);
            }
            break;

        case ts.SyntaxKind.NumberKeyword:
        case ts.SyntaxKind.StringKeyword:
            currentProperty.type = node.getText();
            break;
    }

    ts.forEachChild(node, inspectNode);
}

const fileNames = process.argv.slice(2);
fileNames.forEach((fileName) => {
    let sourceFile = ts.createSourceFile(fileName, readFileSync(fileName).toString(), ts.ScriptTarget.ES2018, true);
    inspectNode(sourceFile);
});

classes.forEach(klass => {
    console.log(">>", klass.name)
    klass.properties.forEach(prop => console.log("-", prop.name, prop.type));
    console.log("")
})