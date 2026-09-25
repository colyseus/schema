import { schema, t } from "../../../src";

// local-only fields in the MIDDLE of both the parent and the child
export const NoSyncParent = schema({
    x: t.number(),
    cache: t.uint16().default(0).noSync(),
    y: t.number(),
});

export const NoSyncChild = NoSyncParent.extend({
    hp: t.uint8(),
    scratch: t.array("string").noSync(),
    name: t.string(),
});

// function values take no field index at runtime
export const FunctionMembers = schema({
    a: t.number(),
    arrow: () => 1,
    fn: function () { return 2; },
    method() { return 3; },
    b: t.string(),
});
