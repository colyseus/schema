The benchmarks here should provide guidance towards which areas of `@colyseus/schema` encoder and decoder can be improved:

> Benchmarks ran using Macbook Pro (Apple M1, 8GB RAM)

```
schema: encodePrimitiveTypes x 1,321,911 ops/sec ±0.25% (96 runs sampled)
msgpack: encodePrimitiveTypes x 1,339,846 ops/sec ±0.15% (98 runs sampled)
json: encodePrimitiveTypes x 1,549,275 ops/sec ±0.22% (98 runs sampled)
protobuf: encodePrimitiveTypes x 2,111,548 ops/sec ±0.12% (96 runs sampled)
```

```
schema: decodePrimitiveTypes x 813,205 ops/sec ±0.88% (96 runs sampled)
msgpack: decodePrimitiveTypes x 1,746,009 ops/sec ±0.50% (97 runs sampled)
json: decodePrimitiveTypes x 1,706,857 ops/sec ±0.32% (96 runs sampled)
protobuf: decodePrimitiveTypes x 4,404,247 ops/sec ±0.55% (99 runs sampled)
```