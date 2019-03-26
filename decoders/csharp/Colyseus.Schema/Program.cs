using System;
using System.Reflection;
using System.Collections.Generic;

namespace Colyseus.Schema
{
  class Player : Schema
  {
    [Type("number")]
    public int x = 0;

    [Type("number")]
    public int y = 0;
  }

  class Block : Schema
  {
    [Type("number")]
    public int x = 0;

    [Type("number")]
    public int y = 0;
  }

  class State : Schema
  {
    [Type("string")]
    public string firstStringField = "";

    [Type("string")]
    public string secondStringField = "";

    [Type("number")]
    public double highNumber = 0;

    [Type("string")]
    public string thirdStringField = "";

    [Type("ref", typeof(Player))]
    public Player player = new Player();

    [Type("array", typeof(ArraySchema<Block>))]
    public ArraySchema<Block> blocks = new ArraySchema<Block>();

    [Type("map", typeof(MapSchema<Player>))]
    public MapSchema<Player> players = new MapSchema<Player>();
  }

  class MainClass
  {
    public static void Main(string[] args)
    {
      State state = new State();

      byte[] bytes = { 0, 165, 70, 105, 114, 115, 116, 1, 166, 83, 101, 99, 111, 110, 100, 3, 165, 84, 104, 105, 114, 100, 2, 204, 255, 4, 0, 10, 1, 20, 193, 5, 2, 2, 0, 0, 50, 1, 60, 193, 1, 0, 70, 1, 80, 193, 6, 3, 163, 111, 110, 101, 0, 100, 1, 120, 193, 163, 116, 119, 111, 0, 204, 140, 1, 204, 160, 193, 165, 116, 104, 114, 101, 101, 0, 204, 180, 1, 204, 200, 193 
      };

      state.OnChange += (object sender, OnChangeEventArgs e) =>
      {
        e.Changes.ForEach((DataChange obj) =>
        {
          if (obj.Field == "highNumber")
          {
            Console.WriteLine("HELLO: " + (50 * (double)state.highNumber));
          }
          Console.WriteLine(obj.Field + ": has changed from '" + obj.PreviousValue + "' to '" + obj.Value + "'");
        });
      };
      state.Decode(bytes);

      Console.WriteLine("firstStringField: " + state.firstStringField);
      Console.WriteLine("secondStringField: " + state.secondStringField);
      Console.WriteLine("thirdStringField: " + state.thirdStringField);

      Console.WriteLine("Player, x => " + state.player.x);
      Console.WriteLine("Player, y => " + state.player.y);

      Console.WriteLine("Blocks, Count => " + state.blocks.Count);
      state.blocks.Items.ForEach((Block obj) =>
      {
        Console.WriteLine("Block: " + obj.x + ", " + obj.y);
      });

      Console.WriteLine("Players, Count => " + state.players.Count);
      foreach (KeyValuePair<string, Player> entry in state.players.Items)
      {
        Console.WriteLine("Player: " + entry.Key + ", " + entry.Value.x + ", " + entry.Value.y);
      }


      Console.WriteLine("Program ended!");
    }
  }
}
