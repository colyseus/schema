import { Message, Type, Field, MapField, OneOf } from "protobufjs/light"; // respectively "./node_modules/protobufjs/light.js"

@Type.d("PrimitiveTypesMessage")
export class PrimitiveTypesMessage extends Message<PrimitiveTypesMessage> {
  @Field.d(1, "string")
  public str: string;

  @Field.d(2, "uint32")
  public uint32: number;

  @Field.d(3, "int32")
  public int32: number;

  @Field.d(4, "bool")
  public bool: boolean;

  @Field.d(5, "double")
  public double: number;

  @Field.d(6, "float")
  public float: number;
}

export class ChildEmbeddedStructure extends Message<ChildEmbeddedStructure> {
  @Field.d(1, "float")
  public x: number;

  @Field.d(2, "float")
  public y: number;
}

@Type.d("SuperAwesomeMessage")
export class MapOfEmbeddedStructures extends Message<MapOfEmbeddedStructures> {

  @MapField.d(1, "string", ChildEmbeddedStructure)
  public mapOfEmbedded: Map<string, ChildEmbeddedStructure>;

}