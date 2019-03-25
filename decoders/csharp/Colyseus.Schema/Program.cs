using System;
using System.Reflection;

namespace Colyseus.Schema
{
  class State : Schema
  {
    protected int thisIsNotTyped = 0;

    [Type("string")]
    public string firstStringField = "";

    [Type("string")]
    public string secondStringField = "";

    [Type("string")]
    public string thirdStringField = "";

    protected int thisIsNotTypedToo = 0;
  }

  class MainClass
  {
    public static void Main(string[] args)
    {
      State state = new State();

      byte[] bytes = {0,
  165,
  70,
  105,
  114,
  115,
  116,
  1,
  166,
  83,
  101,
  99,
  111,
  110,
  100,
  2,
  165,
  84,
  104,
  105,
  114,
  100 };

      state.Decode(bytes);
      Console.WriteLine("firstStringField: " + state.firstStringField);
      Console.WriteLine("secondStringField: " + state.secondStringField);
      Console.WriteLine("thirdStringField: " + state.thirdStringField);


      Console.WriteLine("Program ended!");
    }
  }
}
