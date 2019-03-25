using System;
using System.Collections.Generic;
using System.Reflection;

/***
  Allowed primitive types:
    "string"
    "number"
    "boolean"
    "int8"
    "uint8"
    "int16"
    "uint16"
    "int32"
    "uint32"
    "int64"
    "uint64"
    "float32"
    "float64"
       
  Allowed reference types:   
    "ref"
    "array"
    "map"
***/

namespace Colyseus.Schema
{
  [AttributeUsage(AttributeTargets.Field)]
  public class Type : Attribute
  {

    public string FieldType;
    public System.Type ChildType;

    public Type(string type, System.Type childType = null)
    {
      FieldType = type;
      ChildType = childType;
    }
  }

  public class Iterator { 
    public int Offset = 0;
  }

  public enum SPEC: byte
  {
    END_OF_STRUCTURE = 0xc1, // (msgpack spec: never used)
    NIL = 0xc0,
    INDEX_CHANGE = 0xd4,
  }

  public class DataChange<T>
  {
    public string Field;
    public T Value;
    public T PreviousValue;
  }

  public class Schema
  {
    protected Dictionary<int, string> fieldsByIndex = new Dictionary<int, string>();
    protected Dictionary<string, string> fieldTypes = new Dictionary<string, string>();
    protected Dictionary<string, System.Type> fieldChildTypes = new Dictionary<string, System.Type>();

    public event EventHandler OnChange;
    public event EventHandler OnRemove;

    public Schema()
    {
      int index = 0;

      FieldInfo[] fields = GetType().GetFields();
      foreach (FieldInfo field in fields)
      {
        Type t = field.GetCustomAttribute<Type>();
        if (t != null)
        {
          fieldsByIndex.Add(index++, field.Name);
          fieldTypes.Add(field.Name, t.FieldType);
          if (t.FieldType == "ref" || t.FieldType == "array" || t.FieldType == "map")
          {
            fieldChildTypes.Add(field.Name, t.ChildType);
          }
        }
      }
    }

    /* allow to retrieve property values by its string name */   
    public object this[string propertyName]
    {
      get { return GetType().GetProperty(propertyName).GetValue(this, null); }
      set { GetType().GetProperty(propertyName).SetValue(this, value, null); }
    }

    public void Decode(byte[] bytes, Iterator it = null)
    {
      if (it == null) { it = new Iterator(); }

      var changes = new List<DataChange<object>>();
      var totalBytes = bytes.Length;

      while (it.Offset < totalBytes)
      {
        var index = bytes[it.Offset++];

        if (index == (byte) SPEC.END_OF_STRUCTURE)
        {
          break;
        }

        var field = fieldsByIndex[index];
        var fieldType = fieldTypes[field];
        object value;

        object change = null;
        bool hasChange = false;

        if (fieldType == "ref")
        {
          // child schema type
        }
        else if (fieldType == "array")
        {
          // array type
        }
        else if (fieldType == "map")
        {
          // map type
        }
        else
        {
          // primitive type
          value = Decoder.GetInstance().DecodePrimitiveType(fieldType, bytes, it);
          hasChange = true;
        }

        if (hasChange)
        {
          changes.Add(new DataChange<object>
          {
            Field = field,
            Value = (change != null) ? change : value,
            PreviousValue = this[field]
          });
        }

      }
    }
  }
}
