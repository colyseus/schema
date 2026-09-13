import { Schema, schema, t, type } from "../../../src";

const IDLE = 2;

export class CsDecorated extends Schema {
    @type("string") status: string = "ready";
    @type("uint8") count: number = 3;
    @type("number") seed: number = Math.random();
}

export const CsItem = schema({
    n: t.number(),
});

export const CsState = schema({
    num: t.number(),
    f32: t.float32(),
    alive: t.boolean().default(true),
    campId: t.int8().default(-1),
    radius: t.float32().default(0.5),
    speed: t.number().default(1.25),
    label: t.string().default("say \"hi\"\n"),
    mode: t.uint8().default(IDLE),
    items: t.array(CsItem),
    bytes: t.array("uint8"),
    byId: t.map(CsItem).view(),
    scores: t.map("number"),
    child: t.ref(CsItem),
    class: t.string(),
});
