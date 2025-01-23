import { DefinitionType, type } from "../annotations";
import { BufferLike, encode } from "../encoding/encode";
import { decode, Iterator } from "../encoding/decode";

export interface TypeDefinition {
    constructor?: any,
    encode?: (bytes: BufferLike, value: any, it: Iterator) => any;
    decode?: (bytes: BufferLike, it: Iterator) => any;
}

const registeredTypes: {[identifier: string] : TypeDefinition} = {};
const identifiers = new Map<any, string>();

export function registerType(identifier: string, definition: TypeDefinition) {
    if (definition.constructor) {
        identifiers.set(definition.constructor, identifier);
        registeredTypes[identifier] = definition;
    }

    if (definition.encode) { encode[identifier] = definition.encode; }
    if (definition.decode) { decode[identifier] = definition.decode; }
}

export function getIdentifier(klass: any): string {
    return identifiers.get(klass);
}

export function getType(identifier: string): TypeDefinition {
    return registeredTypes[identifier];
}

export function defineCustomTypes<T extends {[key: string]: TypeDefinition}>(types: T) {
    for (const identifier in types) {
        registerType(identifier, types[identifier]);
    }

    return (t: keyof T) => type(t as DefinitionType);
}