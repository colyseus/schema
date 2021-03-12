import { nanoid } from "nanoid";
import { Schema, type, MapSchema } from "../../src";
import * as benchmark from "benchmark";

const suite = new benchmark.Suite();

export class PlayerAuto extends Schema {
    @type("number") x: number;
    @type("number") y: number;
}
const playerAuto = new PlayerAuto().assign({ x: 0, y: 0 });
suite.add("automatic mutation tracking", () => {
    for (let i = 0; i < 100; i++) {
        playerAuto.x += 1;
        playerAuto.y += 1;
    }
});


export class PlayerManual extends Schema {
    @type("number", { manual: true }) x: number;
    @type("number", { manual: true }) y: number;
}
const playerManual = new PlayerManual().assign({ x: 0, y: 0 });
suite.add("manual mutation", () => {
    for (let i = 0; i < 100; i++) {
        playerManual.x += 1;
        playerManual.y += 1;
    }
    playerManual.setDirty("x");
    playerManual.setDirty("y");
});

suite.on('cycle', (event) => console.log(String(event.target)));
suite.on('complete', () => console.log('Fastest is ' + suite.filter('fastest').map('name')));

suite.run();