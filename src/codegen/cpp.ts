import { Class, Property, File } from "./types";

/**
 * C++ Code Generator
 */

export function generate (classes: Class[], args: any): File[] {
    throw new Error("C++ code generator not implemented.");
    return [];
}

function generateClass(klass: Class, namespace: string) {
}

function generateProperty(prop: Property, indent: string = "") {
}