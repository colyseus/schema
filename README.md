<div align="center">
  <img src="logo.png?raw=true" width="50%" />
  <br>
  <p>
    An incremental binary state serializer with delta encoding for games.<br>
    Made for <a href="https://github.com/colyseus/colyseus">Colyseus</a>, yet can be used standalone.
  </p>
</div>

# Features

- **Incremental State Synchronization**: Send only the properties that have changed.
- **Trigger Callbacks at Decoding**: [Bring your own](https://docs.colyseus.io/state/callbacks/custom) callback system at decoding, or use the built-in one.
- **Instance Reference Tracking**: Share references of the same instance across the state.
- **State Views**: Filter properties that should be sent only to specific clients.
- **Reflection**: Encode/Decode schema definitions.
- **Schema Generation**: Generate client-side schema files for strictly typed languages.
- **Type Safety**: Strictly typed schema definitions.
- **Multiple Language Support**: Decoders available for multiple languages ([C#](https://github.com/colyseus/colyseus-unity-sdk/tree/master/Assets/Colyseus/Runtime/Colyseus/Serializer/Schema), [Lua](https://github.com/colyseus/colyseus-defold/tree/master/colyseus/serializer/schema), [Haxe](https://github.com/colyseus/colyseus-haxe/tree/master/src/io/colyseus/serializer/schema)).

## Schema definition

`@colyseus/schema` uses type annotations to define types of synchronized properties.

```typescript
import { Schema, type, ArraySchema, MapSchema } from '@colyseus/schema';

export class Player extends Schema {
  @type("string") name: string;
  @type("number") x: number;
  @type("number") y: number;
}

export class MyState extends Schema {
  @type('string') fieldString: string;
  @type('number') fieldNumber: number;
  @type(Player) player: Player;
  @type([ Player ]) arrayOfPlayers: ArraySchema<Player>;
  @type({ map: Player }) mapOfPlayers: MapSchema<Player>;
}
```

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

#### Primitive types (`string`, `number`, `boolean`, etc)

```typescript
@type("string")
name: string;

@type("int32")
name: number;
```

#### Child `Schema` structures

```typescript
@type(Player)
player: Player;
```

#### Array of `Schema` structure

```typescript
@type([ Player ])
arrayOfPlayers: ArraySchema<Player>;
```

#### Array of a primitive type

You can't mix types inside arrays.

```typescript
@type([ "number" ])
arrayOfNumbers: ArraySchema<number>;

@type([ "string" ])
arrayOfStrings: ArraySchema<string>;
```

#### Map of `Schema` structure

```typescript
@type({ map: Player })
mapOfPlayers: MapSchema<Player>;
```

#### Map of a primitive type

You can't mix primitive types inside maps.

```typescript
@type({ map: "number" })
mapOfNumbers: MapSchema<number>;

@type({ map: "string" })
mapOfStrings: MapSchema<string>;
```

### Reflection

The Schema definitions can encode itself through `Reflection`. You can have the
definition implementation in the server-side, and just send the encoded
reflection to the client-side, for example:

```typescript
import { Schema, type, Reflection } from "@colyseus/schema";

class MyState extends Schema {
  @type("string") currentTurn: string;
  // ... more definitions
}

// send `encodedStateSchema` across the network
const encodedStateSchema = Reflection.encode(new MyState());

// instantiate `MyState` in the client-side, without having its definition:
const myState = Reflection.decode(encodedStateSchema);
```

### `StateView` / `@view()`

You can use `@view()` to filter properties that should be sent only to `StateView`'s that have access to it.

```typescript
import { Schema, type, view } from "@colyseus/schema";

class Player extends Schema {
  @view() @type("string") secret: string;
  @type("string") notSecret: string;
}

class MyState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
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
- Encoding state with filters (properties using `@view()` tag)

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

When using `@view()` and `StateView`'s, a single "full encode" must be used for multiple views. Each view also must add its own changes.

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

### Backwards/forwards compability

Backwards/fowards compatibility is possible by declaring new fields at the
end of existing structures, and earlier declarations to not be removed, but
be marked `@deprecated()` when needed.

This is particularly useful for native-compiled targets, such as C#, C++,
Haxe, etc - where the client-side can potentially not have the most
up-to-date version of the schema definitions.


## Limitations and best practices

- Each `Schema` structure can hold up to `64` fields. If you need more fields, use nested structures.
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

You can generate the client-side schema files based on the TypeScript schema definitions automatically.

```
# C#/Unity
schema-codegen ./schemas/State.ts --output ./unity-project/ --csharp

# C/C++
schema-codegen ./schemas/State.ts --output ./cpp-project/ --cpp

# Haxe
schema-codegen ./schemas/State.ts --output ./haxe-project/ --haxe
```

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

Initial thoghts/assumptions, for Colyseus:
- little to no bottleneck for detecting state changes.
- have a schema definition on both server and client
- better experience on staticaly-typed languages (C#, C++)
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
