using System;

namespace Colyseus.Schema
{
  public class Decoder
  {
    /*   
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
      if (type == "string")
      {
        return DecodeString(bytes, it);
      }
      return null;
    }

    public string DecodeString (byte[] bytes, Iterator it)
    {
      int length = bytes[it.Offset++] & 0x1f;

      string str = System.Text.Encoding.UTF8.GetString(bytes, it.Offset, length);
      it.Offset += length;

      return str;
    }

    /*
     * Bool checks
     */
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
