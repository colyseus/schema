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
      else if (type == "number")
      {
        return DecodeNumber(bytes, it);
      }
      else if (type == "int8")
      {
        return DecodeInt8(bytes, it);
      }
      else if (type == "uint8")
      {
        return DecodeUint8(bytes, it);
      }
      else if (type == "int16")
      {
        return DecodeInt16(bytes, it);
      }
      else if (type == "uint16")
      {
        return DecodeUint16(bytes, it);
      }
      else if (type == "int32")
      {
        return DecodeInt32(bytes, it);
      }
      else if (type == "uint32")
      {
        return DecodeUint32(bytes, it);
      }
      else if (type == "float32")
      {
        return DecodeFloat32(bytes, it);
      }
      else if (type == "float64")
      {
        return DecodeFloat64(bytes, it);
      }
      else if (type == "boolean")
      {
        return DecodeBoolean(bytes, it);
      }
      return null;
    }

    public object DecodeNumber (byte[] bytes, Iterator it)
    {
      byte prefix = bytes[it.Offset++];

      if (prefix < 0x80)
      {
        // positive fixint
        return prefix;

      }
      else if (prefix == 0xca)
      {
        // float 32
        return DecodeFloat32(bytes, it);

      }
      else if (prefix == 0xcb)
      {
        // float 64
        return DecodeFloat64(bytes, it);

      }
      else if (prefix == 0xcc)
      {
        // uint 8
        return DecodeUint8(bytes, it);

      }
      else if (prefix == 0xcd)
      {
        // uint 16
        return DecodeUint16(bytes, it);

      }
      else if (prefix == 0xce)
      {
        // uint 32
        return DecodeUint32(bytes, it);

      }
      else if (prefix == 0xcf)
      {
        //// uint 64
        //const hi = bytes[it.offset] * Math.pow(2, 32);
        //const lo = bytes[it.offset + 4];
        //it.offset += 8;
        //return hi + lo;

        throw new Exception("uint64 not implemented");
        //return double.NaN;
      }
      else if (prefix == 0xd0)
      {
        // int 8
        return DecodeInt8(bytes, it);

      }
      else if (prefix == 0xd1)
      {
        // int 16
        return DecodeInt16(bytes, it);

      }
      else if (prefix == 0xd2)
      {
        // int 32
        return DecodeInt32(bytes, it);

      }
      else if (prefix == 0xd3)
      {
        //// int 64
        //const hi = bytes[it.offset] * Math.pow(2, 32);
        //const lo = bytes[it.offset + 4];
        //it.offset += 8;
        //return hi + lo;

        throw new Exception("int64 not implemented");
        //return double.NaN;

      }
      else if (prefix > 0xdf)
      {
        // negative fixint
        return (0xff - prefix + 1) * -1;
      }

      return double.NaN;
    }

    public int DecodeInt8(byte[] bytes, Iterator it)
    {
      return ((int)DecodeUint8(bytes, it)) << 24 >> 24;
    }

    public uint DecodeUint8 (byte[] bytes, Iterator it)
    {
      return bytes[it.Offset++];
    }

    public int DecodeInt16(byte[] bytes, Iterator it)
    {
      return ((int)DecodeUint16(bytes, it)) << 16 >> 16;
    }

    public uint DecodeUint16(byte[] bytes, Iterator it)
    {
      return (uint)(bytes[it.Offset++] | bytes[it.Offset++] << 8);
    }

    public int DecodeInt32(byte[] bytes, Iterator it)
    {
      return bytes[it.Offset++] | bytes[it.Offset++] << 8 | bytes[it.Offset++] << 16 | bytes[it.Offset++] << 24;
    }

    public uint DecodeUint32(byte[] bytes, Iterator it)
    {
      return (uint) (DecodeInt32(bytes, it));
    }

    public double DecodeFloat32(byte[] bytes, Iterator it)
    {
      byte b1 = bytes[it.Offset];
      byte b2 = bytes[it.Offset + 1];
      byte b3 = bytes[it.Offset + 2];
      byte b4 = bytes[it.Offset + 3];
      int sign = (b1 > 0x7F) ? -1 : 1;
      int expo = (b1 % 0x80) * 0x2 + (int)Math.Floor((double)(b2 / 0x80));
      int mant = ((b2 % 0x80) * 0x100 + b3) * 0x100 + b4;

      double n;
      if (mant == 0 && expo == 0) {
        n = sign * 0.0;
      } else if (expo == 0xFF) {
        if (mant == 0) {
          n = sign * double.MaxValue;
        } else {
          n = double.NaN;
        }
      } else {
        n = sign * (1.0 + mant / 0x800000 * Math.Pow(2, expo - 0x7F));
      }

      it.Offset += 4;
      return n;
    }

    public double DecodeFloat64(byte[] bytes, Iterator it)
    {
      byte b1 = bytes[it.Offset + 7];
      byte b2 = bytes[it.Offset + 6];
      byte b3 = bytes[it.Offset + 5];
      byte b4 = bytes[it.Offset + 4];
      byte b5 = bytes[it.Offset + 3];
      byte b6 = bytes[it.Offset + 2];
      byte b7 = bytes[it.Offset + 1];
      byte b8 = bytes[it.Offset];

      int sign = (b1 > 0x7F) ? -1 : 1;
      int expo = (b1 % 0x80) * 0x10 + (int)Math.Floor((double)(b2 / 0x10));
      int mant = ((((((b2 % 0x10) * 0x100 + b3) * 0x100 + b4) * 0x100 + b5) * 0x100 + b6) * 0x100 + b7) * 0x100 + b8;

      double n;
      if (mant == 0 && expo == 0) {
        n = sign * 0.0;
      } else if (expo == 0x7FF) {
        if (mant == 0) {
          n = sign * double.MaxValue;
        } else {
          n = double.NaN;
        }
      } else {
        n = sign * (1.0 + mant / 4503599627370496.0 * Math.Pow(2, expo - 0x3FF));
      }

      it.Offset += 8;
      return n;
    }

    public bool DecodeBoolean(byte[] bytes, Iterator it)
    {
      return DecodeUint8(bytes, it) > 0;
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
