> This is a rough spec for reference. It is not a complete spec and may not be 100% accurate.

### Change Tracking

- Each `Schema` instance has a `ChangeTree` instance, which tracks changes.
- Whenever a property is changed within a `Schema` instance, that change is cached inside its `ChangeTree`.
- Changes are tracked into separate categories: "all", "changes", and "filtered" (used to encode with `StateView`'s).

### Encoding

There are two main types of encoding: the "encode all" and the "encode changes".

- "encode all" is used when a client joins a room, and the server sends the full state of the room.
- "encode changes" is used to encode all the pending changes.

#### Overview

- Each `Schema` instance holds a reference to its own `ChangeTree` instance, which has a unique `refId`.
- The root structure has `refId` of `0`.
- `Schema` instances are encoded as a sequence of `index` => `value`.
- `MapSchema` instances have a `dynamicIndex` encoded sequentially as its `index`, following by the `value` (`CollectionSchema` and `SetSchema` are encoded in the same way as `MapSchema`)
- When encoding a child `Schema` structure, only its `refId` is encoded.
- `ArraySchema` instances are encoded as a sequence of `index` + `value`, where `index` is the index of the array, and `value` is the encoded value.
    - When using `StateView`:
        - On array of primitive types: Not possible to filter particular items. Either all items are encoded, or none.
        - On array of `Schema` instances: Instead of encoding the `index`, the `refId` is encoded instead.

#### Encoding for a View

-


-----

This is the process of joining the room:

(The length of each message is part of the WebSocket message frame itself. This is not the case on WebTransport, which is currently experimental; C# does not have a solid implementation yet AFAIK)

```
Join Room Message {
  Header (uint8) = 10,

  ReconnectionTokenLength (uint8),
  ReconnectionToken (string),

  SerializerIdLength (uint8),
  SerializerId (string),

  Handshake Payload (...all bytes until the end of the message),
}
```

After receiving this message, the client sends back `JOIN_ROOM` to confirm the connection, and the server sends back the full room state.

```
Room State Message {
  Header (uint8) = 14,
  Encoded State (...all bytes until the end of the message),
}
```

The format of the encoded state depends on the serializer being used. The default serializer is `"schema"`, which is a binary format. The `"schema"` serializer is the most efficient one, but it's not human-readable. The `json` serializer is also available, but it's less efficient.