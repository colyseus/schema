import { schema } from "@colyseus/schema";

export const Player = schema({
    x: "number",
    y: "number",
  });

export const MyRoomState = schema({
    mapWidth: "number",
    mapHeight: "number",
    players: { map: Player },
});
