# @colyseus/state

Initial thoghts/assumptions:
- no bottleneck to detect state changes.
- better experience on staticaly-typed languages (C#, C++)
- mutations should be cheap.
  (need to check how costful is writing in buffers instead of updating variables directly.)

Practical Colyseus issues this should solve:
- Avoid decoding large objects that haven't been patched
- Allow to send different patches for each client
- Better developer experience on statically-typed languages

## Defining Schema

```
State.fromSchema({
  name: { type: "number",  }
});
```

## Generating Schema from TypeScript file:

```
statefy ./schemas/State.ts > ./objects/State.ts
```

## Usage:

```typescript
const state = new State();
state.map
```

```typescript
onPatch (client, state) {
  const player = state.players[client.sessionId];
  // mutate `state`
  return state;
}

broadcastPatch() {
  if (this.onPatch) {
    for (let i=0; i<this.clients.length; i++) {
      const client = this.clients[i];
      const filteredState = this.onPatch(client, this.state.clone());

      const patch = delta.create(this.statesPerClient[client.sessionId], filteredState.bytes);
      send(client, patch);

      this.statesPerClient[client.sessionId] = filteredState.bytes;
    }

  } else {
    this.broadcast(delta.create(previousBuff, state.bytes));
  }
}
```

## Inspiration:

- [avro](https://avro.apache.org/docs/current/spec.html)
- [msgpack](https://github.com/msgpack/msgpack/blob/master/spec.md)
- [flatbuffers](https://google.github.io/flatbuffers/flatbuffers_white_paper.html)


## License

MIT
