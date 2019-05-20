import { Schema, type, Reflection } from "../src";

class Entity extends Schema {
  @type("number") x: number;
  @type("number") y: number;
}

class Player extends Entity {
  @type("string") name: string;
}

class Bot extends Player {
  @type("number") power: number;
}

class InheritedTypes extends Schema {
  @type(Entity) entity: Entity;
  @type(Player) player: Player;
  @type(Bot) bot: Bot;

  @type(Entity) any: Entity; // can assign `Entity`, `Player` or `Bot`
}

const state = new InheritedTypes();
state.entity = new Entity();
state.entity.x = 500;
state.entity.y = 800;

state.player = new Player()
state.player.x = 200;
state.player.y = 300;
state.player.name = "Player";

state.bot = new Bot()
state.bot.x = 100;
state.bot.y = 150;
state.bot.name = "Bot";
state.bot.power = 200;

state.any = new Bot();
(state.any as Bot).power = 100;

const bytes = Array.from(Uint8Array.from(Buffer.from( state.encode() )));
console.log("InheritedTypes =>");
console.log(`{ ${bytes.join(", ")} }`);

const handshakeBytes = Array.from(Uint8Array.from(Buffer.from( Reflection.encode(state) )));
console.log("Handshake bytes =>", );
console.log(`{ ${handshakeBytes.join(", ")} }`);
