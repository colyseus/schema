import { schema, t } from "@colyseus/schema";

export const Player = schema({
    x: t.number(),
    y: t.number(),
}, "Player");

export const MyRoomState = schema({
    mapWidth: t.number(),
    mapHeight: t.number(),
    players: t.map(Player),
}, "MyRoomState");
