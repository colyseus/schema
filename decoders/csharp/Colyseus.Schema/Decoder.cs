using System;

namespace Colyseus.Schema
{
  public class Decoder
  {
    /**
     * Singleton
     */
    protected static Decoder Instance = new Decoder();
    public static Decoder GetInstance()
    {
      return Instance;
    }

    public Decoder()
    {
    }

    public object DecodePrimitiveType(string type, byte[] bytes, Iterator it)
    {
      return null;
    }

    public bool NilCheck(byte[] bytes, Iterator it)
    {
      return bytes[it.Offset] == (byte)SPEC.NIL;
    }

    public bool IndexChangeCheck (byte[] bytes, Iterator it)
    {
      return bytes[it.Offset] == (byte)SPEC.INDEX_CHANGE;
    }

    public bool NumberCheck(byte[] bytes, Iterator it)
    {
      byte prefix = bytes[it.Offset];
      return prefix < 0x80 || (prefix >= 0xca && prefix <= 0xd3);
    }
  }
}
