import * as assert from "assert";

import { ChangeTree } from "../src/ChangeTree";

describe("ChangeTree", () => {

    it("simple relationship", () => {
        const root = new ChangeTree();

        const child = new ChangeTree("child");
        child.parent = root;

        child.change("x");

        assert.equal(root.changed, true);
        assert.equal(child.changed, true);

        assert.deepEqual(root.changes, ['child'])
        assert.deepEqual(child.changes, ['x'])
    });

});
