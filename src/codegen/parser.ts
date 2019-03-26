import * as ts from "typescript";
import { readFileSync } from "fs";
import { Class, Property } from "./types";

let currentClass: Class;
let currentProperty: Property;

function inspectNode(node: ts.Node, classes: Class[]) {
    switch (node.kind) {
        case ts.SyntaxKind.ClassDeclaration:
            currentClass = new Class();
            classes.push(currentClass);
            break;
        case ts.SyntaxKind.PropertyDeclaration:
            break;

        case ts.SyntaxKind.Identifier:
            if (node.getText() === "type" && node.parent.kind !== ts.SyntaxKind.ImportSpecifier) {
                const prop: any = node.parent.parent.parent;
                const typeDecorator: any = node.parent.parent.parent.decorators.find((decorator => {
                    return (decorator.expression as any).expression.escapedText === "type";
                })).expression;

                currentProperty = new Property();
                currentProperty.name = prop.name.escapedText;
                currentClass.properties.push(currentProperty);

                const typeArgument = typeDecorator.arguments[0];
                if(ts.isIdentifier(typeArgument)) {
                    currentProperty.type = "ref";
                    currentProperty.childType = typeArgument.text;

                } else if (typeArgument.kind == ts.SyntaxKind.ObjectLiteralExpression) {
                    currentProperty.type = "map";
                    currentProperty.childType = typeArgument.properties[0].initializer.text;

                } else if (typeArgument.kind == ts.SyntaxKind.ArrayLiteralExpression) {
                    currentProperty.type = "array";
                    currentProperty.childType = typeArgument.elements[0].text;

                } else {
                    currentProperty.type = typeArgument.text;
                }
            }
            if (node.parent.kind === ts.SyntaxKind.ClassDeclaration) {
                currentClass.name = node.getText();
            }
            break;
    }

    ts.forEachChild(node, (n) => inspectNode(n, classes));
}

export function parseFiles(fileNames: string[]): Class[] {
    const classes: Class[] = [];

    fileNames.forEach((fileName) => {
        let sourceFile = ts.createSourceFile(fileName, readFileSync(fileName).toString(), ts.ScriptTarget.ES2018, true);
        inspectNode(sourceFile, classes);
    });

    return classes.filter(klass => klass.properties.length > 0);
}