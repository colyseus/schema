
export class Property {
    name: string;
    type: string;
    childType: string;
}

export class Class {
    name: string;
    properties: Property[] = [];
}

export interface File {
    name: string
    content: string;
}