# Predictor — real-world usage cheat sheet

Companion to `Predictor.portable.ts`. Drop the file into any Colyseus 0.15+
client, import `Predictor` from it, and follow the notes below.

## 60-second setup

```ts
import { Client } from "colyseus.js";
import { Predictor } from "./Predictor";

const room = await client.joinOrCreate("arena");
const predictor = new Predictor(room, { mode: "lerp", delay: 100 });

// Track AFTER onAdd — the instance needs a server-assigned refId.
room.state.players.onAdd((player, sessionId) => {
    predictor.track(player, "x");
    predictor.track(player, "y");
    predictor.track(player, "rotation");
});
room.state.players.onRemove((player) => {
    predictor.untrack(player, "x");
    predictor.untrack(player, "y");
    predictor.untrack(player, "rotation");
});

// Once per frame, before drawing:
function render(t: number) {
    predictor.setRenderTime(t);
    room.state.players.forEach((p) => {
        drawPlayer(predictor.get(p, "x"), predictor.get(p, "y"), predictor.get(p, "rotation"));
    });
    requestAnimationFrame(render);
}
requestAnimationFrame(render);
```

## Mode picker

| you want | use | typical config |
|---|---|---|
| Smooth remote players / NPCs / projectiles | `lerp` | `delay: 75–150ms` |
| Responsive aim / crosshair / cursor | `extrapolate` | `maxExtrapolate: 80–150ms` |
| Post-teleport / rubber-band / server correction catch-up | `damped` | `damping: 10–20` |
| Local player controlled by user input | **don't** — see "Local player" below | — |

## Tuning

**`lerp` delay**: buffer enough to survive network jitter without feeling laggy.

- 20Hz server tick (50ms interval) → start with `delay: 100` (2× interval).
- 30Hz server tick (33ms interval) → `delay: 75`.
- 60Hz server tick (16ms interval) → `delay: 50`.
- High-jitter networks (mobile, crowded Wi-Fi): +50ms.
- Rule of thumb: `delay ≈ 1.5–2.5 × server_tick_interval`.

**`extrapolate` maxExtrapolate**: how far past the last sample you're willing
to guess before clamping. Set to ~1× server tick interval for safe overshoot.

**`damped` damping**: spring constant. `damping = 10` = ~100ms half-life,
`damping = 20` = ~50ms. Pick by how snappy the catch-up should feel.

## Gotchas (the things that will bite you)

1. **Track timing**: `track()` needs the instance to have a decoded `refId`.
   Always call it from inside `onAdd` or later. Calling it on freshly
   `new`d local instances throws `Can't addCallback (refId is undefined)`.

2. **Display ≠ authoritative**: `predictor.get(p, "x")` is for rendering.
   For hit detection, physics, or game-rule decisions, use `p.x` directly
   (the raw last-known value). Never feed predicted values back into
   gameplay logic — they'll drift.

3. **Wall-clock freezes**: `mode: "damped"` uses `performance.now()`
   deltas. If the tab loses focus or the page hangs, the first resumed
   frame will close most of the remaining distance in one step. `lerp`
   and `extrapolate` use sample timestamps so they're immune.

4. **Sample churn on re-encodes**: `listen` fires on every decoded
   mutation, including same-value re-encodes (they're rare but happen
   with `@unreliable` or full-sync encodes). Usually harmless; only
   notice if you're tracking thousands of fields and see unexpected
   listener CPU.

5. **Schema replacement**: if the server replaces a whole `Position`
   instance (not just its fields), the *instance identity* changes. Your
   old tracked instance is gone from the state. Re-track the new one
   inside the parent's `onChange` / `listen` on the reference field. For
   this reason, prefer *field-level* predictable values (`@type("number")
   x`) over whole replaceable sub-schemas.

6. **Initial snap**: the first rendered frame after `track()` returns
   the current value (no history yet). You'll see a one-frame snap to
   the right position, then smooth interpolation kicks in. Rarely
   perceptible; if it matters, hide entities until the second decode.

7. **Server tick timestamps**: the predictor samples use *client arrival
   time* (`performance.now()` at decode time), not *server send time*.
   On jittery networks this means two snapshots that were 50ms apart on
   the server can arrive 20ms / 80ms apart — `lerp` will play them at
   those irregular intervals. Fine for most games; matters for strict
   fixed-tick determinism (which a pure interpolator isn't the right
   tool for anyway).

## Common patterns

### Local player: don't predict with this tool

For the player the user directly controls, do **client-side prediction +
server reconciliation** in userland: simulate locally on input, snapshot
the server's authoritative position when it arrives, rewind+replay if it
disagrees. The `Predictor` is designed for *observed* entities, not
controlled ones. If you want a smoother *correction* for the local
player after a server override, that's where `damped` earns its keep:

```ts
// After server tells us we're at a different position, ease to it:
predictor.track(localPlayer, "x", { mode: "damped", damping: 15 });
```

### Hit detection / physics: use the raw value

```ts
// Rendering — smoothed
drawEnemy(predictor.get(enemy, "x"), predictor.get(enemy, "y"));

// Hit check — authoritative
if (bulletHits(bullet, { x: enemy.x, y: enemy.y })) { ... }
```

If you hit-test against the *displayed* position, players will miss
visible targets (or hit invisible ones) because the display lags behind
the server by `delay` ms.

### Per-field mode

Nothing stops you from using different modes for different fields on
the same entity:

```ts
predictor.track(player, "x", { mode: "lerp", delay: 100 });
predictor.track(player, "y", { mode: "lerp", delay: 100 });
predictor.track(player, "rotation", { mode: "extrapolate" });  // live aim
```

### Collections (ArraySchema / MapSchema)

Only fields on **Schema instances** are predictable — not `ArraySchema`
primitive indices. Wrap primitives in a Schema if you need them
predicted:

```ts
// Not predictable:  @type(["number"]) positions: number[]
// Predictable:
class Point extends Schema { @type("number") x; @type("number") y; }
@type([Point]) positions: Point[];
```

## Debugging

- **"No smoothing"**: confirm `predictor.setRenderTime(t)` is called
  every frame, and `t` is monotonically increasing in ms.
- **"Listener never fires"**: confirm `track()` was called after
  `onAdd`. Add a `console.log` inside `.listen(...)` temporarily.
- **"Values snap instead of interpolate"**: you have fewer than 2
  samples. Check that the server has actually sent 2 updates to that
  field, not just the initial bootstrap.
- **"Drifts ahead of server"**: you're using `extrapolate` with a high
  `maxExtrapolate`. Lower it, or switch to `lerp`.

Handy comparison helper:

```ts
console.log({
    raw: player.x,
    predicted: predictor.get(player, "x"),
    renderTime: performance.now(),
});
```

## Performance

- Storage: `{t, v}` × 2 + a handful of numbers per `(instance, field)`
  pair. 1000 entities × 2 predicted fields ≈ 64 KB.
- Read cost: a few adds + multiplies + one `Math.exp` (damped only) per
  `get()`. Trivial next to a canvas/WebGL draw.
- Uses `WeakMap<instance, …>` so state auto-GCs when the entity leaves
  the room.
- `listen()` detach is handled by `untrack()` and implicitly when the
  instance becomes unreachable — don't leak detach callbacks but also
  don't stress about it.

## Feedback worth capturing

When you come back, things I'd want to know to decide whether this
becomes a built-in `@predict`:

- Which **default** felt right: `lerp` delay, extrapolate max, damping?
- Did you end up mixing modes per-field, or one mode per entity?
- Did the "track after onAdd" rule trip you up? (If yes, the built-in
  should hook in the setter to skip that requirement entirely.)
- Did anyone want **wire-side server timestamps** for `lerp`, or was
  client-arrival-time good enough?
- Did the hit-detection-uses-raw pattern feel natural, or do users
  need an explicit `Predictor.raw(instance, "x")` helper?
- Anywhere the math felt wrong or "jumped"?
