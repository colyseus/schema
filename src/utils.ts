import { Schema } from "./Schema";
import { ReflectionField } from "./Reflection";
import { ChangeTree } from "./changes/ChangeTree";

export function dumpChanges(schema: Schema) {
    const changeTrees: ChangeTree[] = [schema['$changes']];
    let numChangeTrees = 1;

    const dump = {};
    let currentStructure = dump;

    for (let i = 0; i < numChangeTrees; i++) {
        const changeTree = changeTrees[i];

        changeTree.changes.forEach((change) => {
            const ref = changeTree.ref;
            const fieldIndex = change.index;

            const field = ((ref as Schema)['_definition'])
                ? ref['_definition'].fieldsByIndex[fieldIndex]
                : ref['$indexes'].get(fieldIndex);

            currentStructure[field] = changeTree.getValue(fieldIndex);
        });

    }

    return dump;
}

export function checkTypeScriptConfig() {
    const r = new ReflectionField();
    const descriptor = Object.getOwnPropertyDescriptor(r, "name");
    if (descriptor.get === undefined || descriptor.set === undefined) {
        console.error(`
‼️  Please check your tsconfig.json ‼️

@colyseus/schema requires the following settings:
-------------------------------------------------

  "compilerOptions": {
    // ...
    "useDefineForClassFields": false,
    "experimentalDecorators": true,
    // ...
  }

-------------------------------------------------
More info → https://github.com/colyseus/colyseus/issues/510#issuecomment-1507828422
`);
        process.exit(1);
    }
}
