<div align="center">
  <img src="logo.png?raw=true" width="50%" />
  <br>
  <p>
    <b>Automatic state replication for multiplayer games.</b><br>
    Define your state once and mutate it like plain objects. Every client holds a live, typed mirror. Only the changes are sent, filtered per client.<br>
    Made for <a href="https://github.com/colyseus/colyseus">Colyseus</a>, yet can be used standalone.
  </p>
</div>

# Features

- **Plain Objects, Synced**: Assign a property, `push` to an array, or `set` on a map. Change tracking, encoding and decoding happen for you.
- **Delta Encoding**: Only the properties that changed are sent, in a compact binary format.
- **Trigger Callbacks at Decoding**: [Bring your own](https://docs.colyseus.io/state/callbacks/custom) callback system at decoding, or use the built-in one.
- **Instance Reference Tracking**: Share references of the same instance across the state.
- **State Views**: Per-client visibility. Decide which properties and instances each client receives.
- **Reflection**: Encode/Decode schema definitions.
- **Schema Generation**: Generate client-side schema files for strictly typed languages.
- **Type Safety**: Strictly typed schema definitions.
- **Multiple Language Support**: Decoders available for multiple languages ([C#](https://github.com/colyseus/colyseus-unity-sdk/tree/master/Assets/Colyseus/Runtime/Colyseus/Serializer/Schema), [Lua](https://github.com/colyseus/colyseus-defold/tree/master/colyseus/serializer/schema), [Haxe](https://github.com/colyseus/colyseus-haxe/tree/master/src/io/colyseus/serializer/schema)).

## Schema definition

Define synchronizable structures with `schema()` and `t.*` field builders:

```typescript
import { schema, t, type SchemaType } from '@colyseus/schema';

export const Player = schema({
  name: t.string(),
  x: t.number(),
  y: t.number(),
}, "Player");
export type Player = SchemaType<typeof Player>;

export const MyState = schema({
  fieldString: t.string(),
  fieldNumber: t.number(),
  player: Player,
  arrayOfPlayers: t.array(Player),
  mapOfPlayers: t.map(Player),
}, "MyState");
export type MyState = SchemaType<typeof MyState>;
```

`schema()` returns a real class (`instanceof` works) and runs in plain JavaScript and TypeScript alike, with no compiler configuration. The `type` aliases are TypeScript-only sugar — omit them in plain JS.

### Decorators (still supported)

The classic `@type()` decorator style remains fully supported, and both styles produce the identical wire format:

```typescript
import { Schema, type, ArraySchema, MapSchema } from '@colyseus/schema';

export class Player extends Schema {
  @type("string") name: string;
  @type("number") x: number;
  @type("number") y: number;
}
```

We are moving away from decorators due to ecosystem compatibility issues: they depend on the legacy `experimentalDecorators` implementation and `useDefineForClassFields: false`, which conflict with modern toolchain defaults (esbuild, SWC, Vite), diverge from the TC39 decorators specification, and aren't available in plain JavaScript. See the [Decorators reference](https://docs.colyseus.io/state/schema/decorators) for setup and the full decorator documentation.

## TypeScript support

Compatible with TypeScript **5.x**, **6.x** and **7.x**.

The `@type()` decorator uses legacy decorators — enable them in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "useDefineForClassFields": false
  }
}
```

> **Note:** `schema-codegen` requires TypeScript 5.x or 6.x installed in your
> project — TypeScript 7's native compiler no longer ships the JS compiler API
> that codegen uses to parse your schema files. The runtime and your build are
> not affected by this.

## Supported types

### Primitive Types

| Type | Description | Limitation |
|------|-------------|------------|
| string | utf8 strings | maximum byte size of `4294967295` |
| number | auto-detects `int` or `float` type. (extra byte on output) | `0` to `18446744073709551615` |
| boolean | `true` or `false` | `0` or `1` |
| int8 | signed 8-bit integer | `-128` to `127` |
| uint8 | unsigned 8-bit integer | `0` to `255` |
| int16 | signed 16-bit integer | `-32768` to `32767` |
| uint16 | unsigned 16-bit integer | `0` to `65535` |
| int32 | signed 32-bit integer | `-2147483648` to `2147483647` |
| uint32 | unsigned 32-bit integer | `0` to `4294967295` |
| int64 | signed 64-bit integer | `-9223372036854775808` to `9223372036854775807` |
| uint64 | unsigned 64-bit integer | `0` to `18446744073709551615` |
| float32 | single-precision floating-point number | `-3.40282347e+38` to `3.40282347e+38`|
| float64 | double-precision floating-point number | `-1.7976931348623157e+308` to `1.7976931348623157e+308` |

### Declaration:

Each primitive type is declared through its `t.*` factory (`t.string()`, `t.uint8()`, …). Collection elements take the type **name**, not a builder: `t.array("string")`, never `t.array(t.string())`.

#### Primitive types (`string`, `number`, `boolean`, etc)

```typescript
name: t.string(),
health: t.int32(),
```

#### Child `Schema` structures

```typescript
player: Player,   // shorthand for t.ref(Player)
```

#### Array of `Schema` structure

```typescript
arrayOfPlayers: t.array(Player),
```

#### Array of a primitive type

You can't mix types inside arrays.

```typescript
arrayOfNumbers: t.array("number"),
arrayOfStrings: t.array("string"),
```

#### Map of `Schema` structure

```typescript
mapOfPlayers: t.map(Player),
```

#### Map of a primitive type

You can't mix primitive types inside maps.

```typescript
mapOfNumbers: t.map("number"),
mapOfStrings: t.map("string"),
```

### Reflection

The Schema definitions can encode itself through `Reflection`. You can have the
definition implementation in the server-side, and just send the encoded
reflection to the client-side, for example:

```typescript
import { schema, t, Encoder, Reflection } from "@colyseus/schema";

const MyState = schema({
  currentTurn: t.string(),
  // ... more definitions
}, "MyState");

// server-side: encode the schema definition itself
const encoder = new Encoder(new MyState());
const encodedStateSchema = Reflection.encode(encoder);
// ... send `encodedStateSchema` across the network

// client-side: rebuild the state without having its definition
const decoder = Reflection.decode(encodedStateSchema);
const myState = decoder.state;
```

### `StateView` / `.view()`

You can use the `.view()` field modifier to filter properties that should be sent only to `StateView`'s that have access to it.

```typescript
import { schema, t } from "@colyseus/schema";

const Player = schema({
  secret: t.string().view(),
  notSecret: t.string(),
}, "Player");

const MyState = schema({
  players: t.map(Player),
}, "MyState");
```

Using the `StateView`

```typescript
const view = new StateView();
view.add(player);
```

## Encoder

There are 3 major features of the `Encoder` class:

- Encoding the full state
- Encoding the state changes
- Encoding state with filters (properties tagged with `.view()`)

```typescript
import { Encoder } from "@colyseus/schema";

const state = new MyState();
const encoder = new Encoder(state);
```

New clients must receive the full state on their first connection:

```typescript
const fullEncode = encoder.encodeAll();
// ... send "fullEncode" to client and decode it
```

Further state changes must be sent in order:

```typescript
const changesBuffer = encoder.encode();
// ... send "changesBuffer" to client and decode it
```

### Encoding with views

When using `.view()` and `StateView`'s, a single "full encode" must be used for multiple views. Each view also must add its own changes.

```typescript
// shared buffer iterator
const it = { offset: 0 };

// shared full encode
encoder.encodeAll(it);
const sharedOffset = it.offset;

// view 1
const fullEncode1 = encoder.encodeAllView(view1, sharedOffset, it);
// ... send "fullEncode1" to client1 and decode it

// view 2
const fullEncode2 = encoder.encodeAllView(view2, sharedOffset, it);
// ... send "fullEncode" to client2 and decode it
```

Encoding changes per views:

```typescript
// shared buffer iterator
const it = { offset: 0 };

// shared changes encode
encoder.encode(it);
const sharedOffset = it.offset;

// view 1
const view1Encoded = this.encoder.encodeView(view1, sharedOffset, it);
// ... send "view1Encoded" to client1 and decode it

// view 2
const view2Encoded = this.encoder.encodeView(view2, sharedOffset, it);
// ... send "view2Encoded" to client2 and decode it

// discard all changes after encoding is done.
encoder.discardChanges();
```

## Decoder

The `Decoder` class is used to decode the binary data received from the server.

```typescript
import { Decoder } from "@colyseus/schema";

const state = new MyState();
const decoder = new Decoder(state);
decoder.decode(encodedBytes);
```

### Backwards/forwards compatibility

Backwards/forwards compatibility is possible by declaring new fields at the
end of existing structures, and earlier declarations to not be removed, but
be marked `.deprecated()` when needed.

This is particularly useful for native-compiled targets, such as C#, C++,
Haxe, etc - where the client-side can potentially not have the most
up-to-date version of the schema definitions.


## Limitations and best practices

- Each `Schema` structure can hold up to `64` fields. If you need more fields, use nested structures.
- Fields tagged with `.view()`, `.unreliable()`, or `.fullStateOnly()` at field indexes `≥ 32` use a slower per-mutation classification path (linear scan over the tagged-field list instead of a single bitwise op). For schemas with more than 32 fields, declare frequently-mutated tagged fields earlier so they fall in the bitmask fast path.
- Schemas with `≤ 8` fields store per-field operation bytes inline in two numbers (no allocation per instance). Schemas with `> 8` fields allocate a small `Uint8Array` per instance for op storage. The difference is only material when allocating thousands of instances per tick — prefer narrower nested structures in that regime.
- `NaN` or `null` numbers are encoded as `0`
- `null` strings are encoded as `""`
- `Infinity` numbers are encoded as `Number.MAX_SAFE_INTEGER`
- Multi-dimensional arrays are not supported.
- Items inside Arrays and Maps must be all instance of the same type.
- `@colyseus/schema` encodes only field values in the specified order.
  - Both encoder (server) and decoder (client) must have same schema definition.
  - The order of the fields must be the same.

## Generating client-side schema files (for strictly typed languages)

> If you're using JavaScript or LUA, there's no need to bother about this.
> Interpreted programming languages are able to re-build the Schema locally through the use of `Reflection`.

You can generate the client-side schema files based on your server-side schema definitions automatically — both `schema()` and decorator styles are supported.

> `schema-codegen` requires TypeScript 5.x or 6.x installed in your project
> (TypeScript 7+ no longer ships the JS compiler API it uses for parsing).

```
# C#/Unity
schema-codegen ./schemas/State.ts --output ./unity-project/ --csharp

# C/C++
schema-codegen ./schemas/State.ts --output ./cpp-project/ --cpp

# Haxe
schema-codegen ./schemas/State.ts --output ./haxe-project/ --haxe
```

### Code Generation Options

| Option | Description |
|--------|-------------|
| `--output` | The output directory for generated client-side schema files (required) |
| `--bundle` | Bundle all generated files into a single file |
| `--namespace` | Generate namespace/package on output code |
| `--decorator` | Custom name for `@type` decorator to scan for |
| `--tsconfig` | `tsconfig.json` to resolve import path aliases with (default: the nearest `tsconfig.json`/`jsconfig.json` above each source file) |

Imports are followed to discover related schemas, including bare specifiers
mapped by `compilerOptions.paths`/`baseUrl` and barrel files that re-export
them. Imports of installed packages are not followed.

### Bundle Mode

By default, the code generator creates one file per schema class. Use the `--bundle` option to combine all generated classes into a single file:

```
# Generate a single bundled file
schema-codegen ./schemas/State.ts --output ./unity-project/ --csharp --bundle

# With namespace
schema-codegen ./schemas/State.ts --output ./unity-project/ --csharp --bundle --namespace MyGame.Schema
```

Bundle mode output filenames:
- **TypeScript**: `schema.ts` (or `{namespace}.ts`)
- **JavaScript**: `schema.js` (or `{namespace}.js`)
- **C#**: `Schema.cs` (or `{namespace}.cs`)
- **C++**: `schema.hpp` (or `{namespace}.hpp`)
- **Haxe**: `Schema.hx` (or `{namespace}.hx`)
- **Java**: `Schema.java`
- **Lua**: `schema.lua` (or `{namespace}.lua`)
- **C**: `schema.h` (or `{namespace}.h`)

## Benchmarks:

| Scenario | `@colyseus/schema` | `msgpack` + `fossil-delta` |
|---|---|---|
| Initial state size (100 entities) | 2671 | 3283 |
| Updating x/y of 1 entity after initial state | 9 | 26 |
| Updating x/y of 50 entities after initial state | 342 | 684 |
| Updating x/y of 100 entities after initial state | 668 | 1529 |

## Decoder implementation in other languages

Each Colyseus SDK has its own decoder implementation of the `@colyseus/schema` protocol:

- [C#](https://github.com/colyseus/colyseus-unity-sdk)
- [Haxe](https://github.com/colyseus/colyseus-haxe)
- [Lua](https://github.com/colyseus/colyseus-defold)
- [C++](https://github.com/colyseus/colyseus-cocos2d-x) _(Not up-to-date)_

## Why

Initial thoughts/assumptions, for Colyseus:
- little to no bottleneck for detecting state changes.
- have a schema definition on both the server and the client
- better experience on statically-typed languages (C#, C++)
- mutations should be cheap.

Practical Colyseus issues this should solve:
- Avoid decoding large objects that haven't been patched
- Allow to send different patches for each client
- Better developer experience on statically-typed languages

## Inspiration:

- [Protocol Buffers](https://developers.google.com/protocol-buffers)
- [flatbuffers](https://google.github.io/flatbuffers/flatbuffers_white_paper.html)
- [schemapack](https://github.com/phretaddin/schemapack/)
- [avro](https://avro.apache.org/docs/current/spec.html)


## License

MIT
