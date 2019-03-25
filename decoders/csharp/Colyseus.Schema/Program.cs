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


      Console.WriteLine("Program ended!");
    }
  }
}
