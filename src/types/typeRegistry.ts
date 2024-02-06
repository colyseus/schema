export interface TypeDefinition {
    constructor: any,

    // //
    // // TODO: deprecate proxy on next version
    // // the proxy is used for compatibility with versions <1.0.0 of @colyseus/schema
    // //
    // getProxy?: any,
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
