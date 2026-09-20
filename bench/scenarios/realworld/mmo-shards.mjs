// MMO shard: 500 players with public x/y/hp, owner-only `gold` + `inventory`
// (`@view()`), and party-visible `mana` (`@view(1)`); C of them are connected
// clients whose StateView owns its player and tags 4 party mates.
// Per tick: all 500 move, 20 hp, 20 mana, 50 gold, 10 inventory adds, 5 removes.
//   enc-c100 / enc-c500 — server tick (shared encode + per-client encodeView)
//   e2e-c20             — plus 20 clients decoding with onAdd(players)→listen(x, gold)
import { codecOf, withCodecs, defineShard, buildShard, serverTick, makeViewClient, attachCallbacks } from "../../lib/realworld.mjs";

function shardTick(ctx, i) {
    const { players, shapes } = ctx;
    const n = players.length;
    for (let p = 0; p < n; p++) {
        const player = players[p];
        player.x += 0.5;
        player.y -= 0.5;
    }
    for (let k = 0; k < 20; k++) players[(i * 20 + k) % n].hp = 100 - ((i + k) % 90);
    for (let k = 0; k < 20; k++) players[(i * 20 + k + 11) % n].mana = 30 - ((i + k) % 25);
    for (let k = 0; k < 50; k++) players[(i * 50 + k) % n].gold++;
    for (let k = 0; k < 10; k++) {
        const player = players[(i * 10 + k + 3) % n];
        const item = new shapes.Item();
        item.id = 200 + ((i + k) % 50);
        item.qty = 1;
        player.inventory.set(`s${8 + ((i + k) % 8)}`, item);
    }
    for (let k = 0; k < 5; k++) {
        const player = players[(i * 5 + k + 17) % n];
        player.inventory.delete(`s${8 + ((i + k + 3) % 8)}`);
    }
}

export default {
    name: "realworld/mmo-shards",
    unit: "ms/tick",
    variants: withCodecs([
        { name: "enc-c100", clients: 100, iterations: 100, reps: 7 },
        { name: "enc-c500", clients: 500, iterations: 40, reps: 5 },
        { name: "e2e-c20", clients: 20, e2e: true, iterations: 100, reps: 7 },
    ]),
    reps: 7,
    setup(lib, variant) {
        const codec = codecOf(lib, variant);
        const shapes = defineShard(lib);
        const shard = buildShard(lib, codec, shapes, { players: 500, clients: variant.clients });
        serverTick(codec, shard.encoder, shard.views);
        const ctx = { codec, shapes, ...shard, e2e: !!variant.e2e, decoders: null, counters: null };
        if (variant.e2e) {
            ctx.decoders = shard.views.map((view) => makeViewClient(lib, codec, shard.encoder, view));
            ctx.counters = attachCallbacks(lib, ctx.decoders[0], { players: ["x", "gold"] });
        }
        return ctx;
    },
    run(ctx, i) {
        const { codec, encoder, views } = ctx;
        shardTick(ctx, i);
        if (!ctx.e2e) return serverTick(codec, encoder, views);
        const it = { offset: 0 };
        encoder.encode(it);
        const sharedOffset = it.offset;
        let bytes = 0;
        for (let c = 0; c < views.length; c++) {
            const pair = codec.encodeView(encoder, views[c], sharedOffset, it);
            bytes += codec.bytesOf(pair);
            ctx.decoders[c].decode(pair);
        }
        encoder.discardChanges();
        return bytes;
    },
    teardown(ctx) {
        if (ctx.counters && (ctx.counters.onAdd === 0 || ctx.counters.listen === 0)) throw new Error("callbacks never fired");
    },
};
