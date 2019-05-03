// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.19
// 


import io.colyseus.serializer.schema.Schema;

class State extends Schema {
	@:type("string")
	public var myString: String = "";

	@:type("number")
	public var myNumber: Dynamic = 0;

	@:type("ref", Player)
	public var player: Player = new Player();

	@:type("array", "string")
	public var arrayOfStrings: ArraySchema<String> = new ArraySchema<String>();

	@:type("array", "number")
	public var arrayOfNumbers: ArraySchema<Dynamic> = new ArraySchema<Dynamic>();

	@:type("array", Player)
	public var arrayOfPlayers: ArraySchema<Player> = new ArraySchema<Player>();

	@:type("map", "string")
	public var mapOfStrings: MapSchema<String> = new MapSchema<String>();

	@:type("map", "number")
	public var mapOfNumbers: MapSchema<Dynamic> = new MapSchema<Dynamic>();

	@:type("map", Player)
	public var mapOfPlayers: MapSchema<Player> = new MapSchema<Player>();

	// public function new () {
	// 	super();
	// 	this._indexes = [0 => "myString", 1 => "myNumber", 2 => "player", 3 => "arrayOfStrings", 4 => "arrayOfNumbers", 5 => "arrayOfPlayers", 6 => "mapOfStrings", 7 => "mapOfNumbers", 8 => "mapOfPlayers"];
	// 	this._types = [0 => "string", 1 => "number", 2 => "ref", 3 => "array", 4 => "array", 5 => "array", 6 => "map", 7 => "map", 8 => "map"];
	// 	this._childPrimitiveTypes = [3 => "string", 4 => "number", 6 => "string", 7 => "number"];
	// 	this._childSchemaTypes = [2 => Player, 5 => Player, 8 => Player];
	// }

}
