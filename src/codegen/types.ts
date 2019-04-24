import * as fs from "fs";

const VERSION = JSON.parse(fs.readFileSync(__dirname + "/../../package.json").toString()).version;
const COMMENT_HEADER = `
THIS FILE HAS BEEN GENERATED AUTOMATICALLY
DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING

GENERATED USING @colyseus/schema ${VERSION}
`;

export function getCommentHeader(singleLineComment: string = "//") {
    return `${COMMENT_HEADER.split("\n").map(line => `${singleLineComment} ${line}`).join("\n")}`;
}

export class Context {
    classes: Class[] = [];

    getSchemaClasses() {
        return this.classes.filter(klass => {
            if (this.isSchemaClass(klass)) {
                return true;
            } else {
                let parentClass = klass;
                while (parentClass = this.getParentClass(parentClass)) {
                    if (this.isSchemaClass(parentClass)) {
                        return true;
                    }
                }
            }
            return false;
        });
    }

    addClass(currentClass: Class) {
        currentClass.context = this;
        this.classes.push(currentClass);
    }

    private getParentClass(klass: Class) {
        return this.classes.find(c => c.name === klass.extends);
    }

    private isSchemaClass(klass: Class) {
        return klass.properties.length > 0;
    }
}

export class Class {
    context: Context;
    name: string;
    properties: Property[] = [];
    extends: string;

    addProperty(property: Property) {
        let parentKlass: Class = this;
        property.index = this.properties.length;

        while ((parentKlass = this.context.classes.find(k => k.name === parentKlass.extends))) {
            property.index += parentKlass.properties.length;
        }

        this.properties.push(property);
    }
}

export class Property {
    index: number;
    name: string;
    type: string;
    childType: string;
}

export interface File {
    name: string
    content: string;
}