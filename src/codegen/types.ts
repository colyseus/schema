const COMMENT_HEADER = `
THIS FILE HAS BEEN GENERATED AUTOMATICALLY
DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
`;

export function getCommentHeader(singleLineComment: string = "//") {
    return `${COMMENT_HEADER.split("\n").map(line => `${singleLineComment} ${line}`).join("\n")}`;
}

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