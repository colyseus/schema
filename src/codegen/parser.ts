import * as ts from "typescript";
import { readFileSync } from "fs";
import { Class, Property, Context } from "./types";

let currentClass: Class;

function inspectNode(node: ts.Node, context: Context, decoratorName: string) {
    switch (node.kind) {
        case ts.SyntaxKind.ClassDeclaration:
            currentClass = new Class();

            const heritageClauses = (node as ts.ClassLikeDeclarationBase).heritageClauses;
            if (heritageClauses && heritageClauses.length > 0) {
                currentClass.extends = heritageClauses[0].types[0].getText();
            }

            context.addClass(currentClass);
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

                const property = new Property();
                property.name = prop.name.escapedText;
                currentClass.addProperty(property);

                const typeArgument = typeDecorator.arguments[0];
                if(ts.isIdentifier(typeArgument)) {
                    property.type = "ref";
                    property.childType = typeArgument.text;

                } else if (typeArgument.kind == ts.SyntaxKind.ObjectLiteralExpression) {
                    property.type = "map";
                    property.childType = typeArgument.properties[0].initializer.text;

                } else if (typeArgument.kind == ts.SyntaxKind.ArrayLiteralExpression) {
                    property.type = "array";
                    property.childType = typeArgument.elements[0].text;

                } else {
                    property.type = typeArgument.text;
                }
            }
            if (node.parent.kind === ts.SyntaxKind.ClassDeclaration) {
                currentClass.name = node.getText();
            }
            break;
    }

    ts.forEachChild(node, (n) => inspectNode(n, context, decoratorName));
}

export function parseFiles(fileNames: string[], decoratorName: string = "type"): Class[] {
    const context = new Context();

    fileNames.forEach((fileName) => {
        let sourceFile = ts.createSourceFile(fileName, readFileSync(fileName).toString(), ts.ScriptTarget.ES2018, true);
        inspectNode(sourceFile, context, decoratorName);
    });

    return context.classes.filter(klass => klass.properties.length > 0);
}