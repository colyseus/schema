import { schema, t } from "../../../src";

const IDLE = 2;

export const HxItem = schema({
    n: t.number(),
});

export const HxState = schema({
    num: t.number(),
    f32: t.float32(),
    small: t.uint8(),
    tick: t.uint32(),
    big: t.int64(),
    alive: t.boolean().default(true),
    campId: t.int8().default(-1),
    radius: t.float32().default(0.5),
    label: t.string().default("say \"hi\"\n"),
    mode: t.uint8().default(IDLE),
    floats: t.array("number"),
    counts: t.map("uint16"),
    items: t.array(HxItem),
    cast: t.uint8(),
    class: t.string(),
});
