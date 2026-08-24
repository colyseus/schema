import { Schema, type } from "../../../../src";
import { nanoid } from "nanoid";              // npm package: must NOT be followed
import { AliasedPlayer } from "@schemas";     // `paths` alias pointing at a barrel
import { AliasedEnemy } from "schemas/Enemy"; // `baseUrl`, no alias

export class AliasedRoomState extends Schema {
    @type("string") id: string = nanoid();
    @type(AliasedPlayer) player: AliasedPlayer;
    @type(AliasedEnemy) enemy: AliasedEnemy;
}
