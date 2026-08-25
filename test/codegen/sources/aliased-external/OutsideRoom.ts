import { Schema, type } from "../../../../src";
import { AliasedPlayer } from "@schemas"; // only resolvable via an explicit --tsconfig

export class OutsideRoomState extends Schema {
    @type(AliasedPlayer) player: AliasedPlayer;
}
