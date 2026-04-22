/**
 * Demo driving a fake deterministic clock: server snapshots at 20Hz, client
 * renders at 60Hz with a 75ms interpolation delay. Asserts that the lerp
 * output tracks the expected per-frame position between snapshots, and that
 * extrapolate is "live but clamps past the max overshoot".
 *
 * Run:
 *     npx tsx --tsconfig tsconfig.test.json predictor/demo.ts
 */

import * as assert from "assert";
import { Encoder, Decoder, Schema, type } from "../src";
import { Predictor } from "./Predictor";

class Position extends Schema {
    @type("number") x: number = 0;
    @type("number") y: number = 0;
}
class State extends Schema {
    @type(Position) player = new Position();
}

// ---- Setup server + client ----
const server = new State();
const encoder = new Encoder(server);

const client = new Decoder(new State());

// Controlled clock — the Predictor uses it for both sample timestamps and
// render time, so results are reproducible.
let clock = 0;
function advanceTo(t: number) { clock = t; }

const predictor = new Predictor(client, { mode: "lerp", delay: 75 });
predictor.clock = () => clock;

// ---- Drive the simulation ----

// Helper: push a server snapshot at simulated time t to the client.
function tickServer(t: number, x: number, y: number) {
    advanceTo(t);
    server.player.x = x;
    server.player.y = y;
    const bytes = encoder.encode();
    encoder.discardChanges();
    client.decode(bytes);
}

// Seed initial state so the client Position instance is registered with
// the decoder's refId tracker — a precondition for `predictor.track`. In
// production, users would call `track` from inside an `onAdd` callback
// when the entity first arrives.
tickServer(0, 0, 0);
const clientPlayer = (client.state as State).player;
predictor.track(clientPlayer, "x");
predictor.track(clientPlayer, "y");

// t=100 → (10, 20)
tickServer(100, 10, 20);
// t=200 → (30, 40)
tickServer(200, 30, 40);

// ---- Assert interpolation between 100 and 200 ----

// With delay=75, renderTime=175 should display the server state at t=100.
advanceTo(175);
predictor.setRenderTime(175);
{
    const x = predictor.get(clientPlayer, "x");
    const y = predictor.get(clientPlayer, "y");
    console.log(`t=175 (display ~t=100): x=${x.toFixed(2)} y=${y.toFixed(2)}`);
    assert.strictEqual(x, 10);
    assert.strictEqual(y, 20);
}

// renderTime=225 → display t=150 → half between (10,20) and (30,40) = (20,30)
advanceTo(225);
predictor.setRenderTime(225);
{
    const x = predictor.get(clientPlayer, "x");
    const y = predictor.get(clientPlayer, "y");
    console.log(`t=225 (display ~t=150): x=${x.toFixed(2)} y=${y.toFixed(2)}`);
    assert.strictEqual(x, 20);
    assert.strictEqual(y, 30);
}

// renderTime=275 → display t=200 → latest known = (30,40)
advanceTo(275);
predictor.setRenderTime(275);
{
    const x = predictor.get(clientPlayer, "x");
    const y = predictor.get(clientPlayer, "y");
    console.log(`t=275 (display ~t=200): x=${x.toFixed(2)} y=${y.toFixed(2)}`);
    assert.strictEqual(x, 30);
    assert.strictEqual(y, 40);
}

// renderTime=400 past the latest sample → lerp clamps to latest
advanceTo(400);
predictor.setRenderTime(400);
{
    const x = predictor.get(clientPlayer, "x");
    console.log(`t=400 past-latest: x=${x.toFixed(2)} (clamped to 30)`);
    assert.strictEqual(x, 30);
}

// ---- Extrapolate mode ----
// Retrack with extrapolate. Same samples so far (t=0, t=100, t=200 → (30,40)).
predictor.untrack(clientPlayer, "x");
predictor.track(clientPlayer, "x", { mode: "extrapolate", maxExtrapolate: 200 });
// Seed the ring buffer manually with the last two samples (track() alone
// gets only the current value; in production the listener fills it as
// snapshots arrive. Here we fake the latest two by replaying one).
advanceTo(100);
server.player.x = 10; client.decode(encoder.encode()); encoder.discardChanges();
advanceTo(200);
server.player.x = 30; client.decode(encoder.encode()); encoder.discardChanges();

// At t=250, dt=100, velocity=20/100=0.2 → expect 30 + 0.2*50 = 40
advanceTo(250);
predictor.setRenderTime(250);
{
    const x = predictor.get(clientPlayer, "x");
    console.log(`extrapolate t=250: x=${x.toFixed(2)} (expect 40)`);
    assert.strictEqual(x, 40);
}

// At t=600 (400ms past latest) → clamp at maxExtrapolate=200 → 30 + 0.2*200 = 70
advanceTo(600);
predictor.setRenderTime(600);
{
    const x = predictor.get(clientPlayer, "x");
    console.log(`extrapolate t=600 clamped: x=${x.toFixed(2)} (expect 70)`);
    assert.strictEqual(x, 70);
}

// ---- Damped mode ----
// Lower damping so the ramp is visible on a 60Hz render loop. A 16ms frame
// with damping=5 yields k = 1 - exp(-5*0.016) ≈ 0.077, so each frame closes
// ~7.7% of the remaining distance.
advanceTo(1000);
server.player.x = 100; client.decode(encoder.encode()); encoder.discardChanges();

predictor.untrack(clientPlayer, "x");
predictor.track(clientPlayer, "x", { mode: "damped", damping: 5 });

// Drive a few frames at the initial target so the damped clock is aligned
// with real render time. Without this, `lastDampedTime` still points to
// `track()` time and the first read after the new target collapses the
// accumulated idle interval into a single large damping step.
for (let t = 1000; t < 1100; t += 16) {
    advanceTo(t);
    predictor.setRenderTime(t);
    predictor.get(clientPlayer, "x");
}

advanceTo(1100);
server.player.x = 200; client.decode(encoder.encode()); encoder.discardChanges();

// Render a few frames; damped value should approach 200 exponentially.
const samples: number[] = [];
for (let frame = 1; frame <= 10; frame++) {
    const t = 1100 + frame * 16; // 60Hz
    advanceTo(t);
    predictor.setRenderTime(t);
    samples.push(predictor.get(clientPlayer, "x"));
}
console.log(`damped ramp (target=200, start=100, damping=5): ${samples.map(v => v.toFixed(1)).join(" -> ")}`);
// Monotonic, strictly increasing, bounded above by 200
for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i] > samples[i - 1], `damped not monotonic at frame ${i}`);
    assert.ok(samples[i] <= 200, `damped overshot`);
}
assert.ok(samples[0] > 100 && samples[0] < 120, `damped first frame should be near start, got ${samples[0]}`);
assert.ok(samples[samples.length - 1] < 200, `damped should not reach target in 10 frames`);

// ---- Smooth render frame sequence (60Hz between snapshots) ----
console.log("\n60Hz frame sequence between snapshots (lerp, delay=75):");
predictor.untrack(clientPlayer, "x");
predictor.untrack(clientPlayer, "y");
predictor.track(clientPlayer, "x", { mode: "lerp", delay: 75 });
predictor.track(clientPlayer, "y", { mode: "lerp", delay: 75 });

// Replay: t=0 (0,0), t=100 (10,20), t=200 (30,40)
advanceTo(0);
server.player.x = 0; server.player.y = 0; client.decode(encoder.encode()); encoder.discardChanges();
advanceTo(100);
server.player.x = 10; server.player.y = 20; client.decode(encoder.encode()); encoder.discardChanges();
advanceTo(200);
server.player.x = 30; server.player.y = 40; client.decode(encoder.encode()); encoder.discardChanges();

for (let t = 175; t <= 275; t += 16) {
    advanceTo(t);
    predictor.setRenderTime(t);
    const x = predictor.get(clientPlayer, "x");
    const y = predictor.get(clientPlayer, "y");
    console.log(`  render t=${t.toString().padStart(3)}  x=${x.toFixed(2).padStart(6)}  y=${y.toFixed(2).padStart(6)}`);
}

console.log("\nAll predictor assertions passed.");
