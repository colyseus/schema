// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.19
// 



class State extends Schema {
	public var myString: String = "";
	public var myNumber: Dynamic = 0;
	public var player: Player = new Player();

  
	public function new () {
		super();
		this._indexes = [0 => "myString", 1 => "myNumber", 2 => "player"];
		this._types = [0 => "string", 1 => "number", 2 => "ref"];
		this._childPrimitiveTypes = [];
		this._childSchemaTypes = [2 => Player];
	}

}

