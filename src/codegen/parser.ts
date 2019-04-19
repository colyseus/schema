import * as ts from "typescript";
import { readFileSync } from "fs";
import { Class, Property } from "./types";

let currentClass: Class;
let currentProperty: Property;

function inspectNode(node: ts.Node, classes: Class[], decoratorName: string) {
    switch (node.kind) {
        case ts.SyntaxKind.ClassDeclaration:
            currentClass = new Class();

            const heritageClauses = (node as ts.ClassLikeDeclarationBase).heritageClauses;
            if (heritageClauses && heritageClauses.length > 0) {
                currentClass.extends = heritageClauses[0].types[0].getText();
            }

            classes.push(currentClass);
            break;

        // case ts.SyntaxKind.PropertyDeclaration:
        //     break;

        case ts.SyntaxKind.ExtendsKeyword:
            console.log(node.getText());
            break;

        case ts.SyntaxKind.Identifier:
            if (node.getText() === decoratorName && node.parent.kind !== ts.SyntaxKind.ImportSpecifier) {
                const prop: any = node.parent.parent.parent;
                const propDecorator = node.parent.parent.parent.decorators;

                // ignore if "type" identifier doesn't have a decorator.
                if (!propDecorator) { break; }

                const typeDecorator: any = propDecorator.find((decorator => {
                    return (decorator.expression as any).expression.escapedText === decoratorName;
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

    ts.forEachChild(node, (n) => inspectNode(n, classes, decoratorName));
}

export function parseFiles(fileNames: string[], decoratorName: string = "type"): Class[] {
    const classes: Class[] = [];

    fileNames.forEach((fileName) => {
        let sourceFile = ts.createSourceFile(fileName, readFileSync(fileName).toString(), ts.ScriptTarget.ES2018, true);
        inspectNode(sourceFile, classes, decoratorName);
    });

    return classes.filter(klass => klass.properties.length > 0);
}