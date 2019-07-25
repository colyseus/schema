import { ChangeTree } from "../../src/ChangeTree";

export const logChangeTree = (tree: ChangeTree) => {
    if (!tree) return '{empty}'
    const logMap = (map: Map<any, string | number | symbol>) => {
        return [...map.entries()]
            .map(([key, value]) => `Item"${key.name}".${key.x} => ${String(value)}`)
    }
    return `
{
  changes:  [${tree.changes}]
  indexMap: {
    ${logMap(tree.indexMap).join(`\n    `)}
  }
  indexChange: {
    ${logMap(tree.indexChange).join(`\n    `)}
  }
}\n`
}
