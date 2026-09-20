// Large AOI room: 10 000 entities, 200 clients. Own file so the scenario-wide
// `warmup` stays small. 200 views × ~900 visible entities per tick exceed the
// fixtures' 4 MB shared buffer (every view slice lands in the same buffer per
// tick, as on the server), so the buffer is raised to 64 MB up front.
import { withCodecs } from "../../lib/realworld.mjs";
import { aoiSetup, aoiRun, aoiTeardown } from "./entities-aoi.mjs";

export default {
    name: "realworld/entities-aoi-large",
    unit: "ms/tick",
    reps: 5,
    warmup: 10,
    variants: withCodecs([
        { name: "n10000-c200", n: 10000, clients: 200, bufferMb: 64, iterations: 30 },
        { name: "n10000-c200-move20", n: 10000, clients: 200, move: 2000, bufferMb: 64, iterations: 30 },
    ]),
    setup: aoiSetup,
    run: aoiRun,
    teardown: aoiTeardown,
};
