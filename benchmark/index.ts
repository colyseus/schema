import * as Benchmark from "benchmark";

import * as json from "./json/usage";
import * as msgpack from "./msgpack/usage";
import * as protobuf from "./protobuf/usage";
import * as schema from "./schema/usage";

const implementations = { schema, msgpack, json, protobuf, };

const suites: Benchmark.Suite[] = [];

for (let method in schema) {
    const suite = new Benchmark.Suite();
    suites.push(suite);

    for (let libName in implementations) {
        suite.add(`${libName}: ${method}`, implementations[libName][method]);
    }

    suite.on('cycle', (event) => console.log(String(event.target)));
    suite.on('complete', function () { console.log('Fastest is ' + this.filter('fastest').map('name')); });

}

suites.forEach(suite => suite.run());