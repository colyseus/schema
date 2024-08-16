export interface TypeDefinition {
    constructor: any,
}

const registeredTypes: {[identifier: string] : TypeDefinition} = {};
const identifiers = new Map<any, string>();

export function registerType(identifier: string, definition: TypeDefinition) {
    identifiers.set(definition.constructor, identifier);
    registeredTypes[identifier] = definition;
}

export function getIdentifier(klass: any): string {
    return identifiers.get(klass);
}

export function getType(identifier: string): TypeDefinition {
    return registeredTypes[identifier];
}
