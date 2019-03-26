using System;
using System.Collections;
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

  public class DataChange
  {
    public string Field;
    public object Value;
    public object PreviousValue;
  }

  public class OnChangeEventArgs : EventArgs
  {
    public List<DataChange> Changes;
    public OnChangeEventArgs(List<DataChange> changes)
    {
      Changes = changes;
    }
  }

  public class CollectionEventArgs<T, K> : EventArgs
  {
    public T Value;
    public K Key;

    public CollectionEventArgs(T value, K key)
    {
      Value = value;
      Key = key;
    }
  }

  public interface ISchemaCollection
  {
    void InvokeOnAdd(object item, object index);
    void InvokeOnChange(object item, object index);
    void InvokeOnRemove(object item, object index);

    object CreateItemInstance();

    bool HasSchemaChild { get; }
    int Count { get; }
    object this[object key] { get; set; }
  }

  public class ArraySchema<T> : ISchemaCollection
  {
    public List<T> Items;
    public event EventHandler<CollectionEventArgs<T, int>> OnAdd;
    public event EventHandler<CollectionEventArgs<T, int>> OnChange;
    public event EventHandler<CollectionEventArgs<T, int>> OnRemove;

    public ArraySchema()
    {
      Items = new List<T>();
    }

    public ArraySchema(List<T> items = null)
    {
      Items = items ?? new List<T>();
    }

    public object CreateItemInstance()
    {
      return (T) Activator.CreateInstance(typeof(T));
    }

    public bool HasSchemaChild
    {
      get { return typeof(T).BaseType == typeof(Schema); }
    }

    public int Count
    {
      get { return Items.Count; }
    }

    public T this[int index]
    {
      get {
        return (Items.Count > index) ? (T)Items[index] : default(T);
      }
      set { Items.Insert(index, value); }
    }

    public object this[object key]
    {
      get {
        int k = (int)key;
        return (Items.Count > k) ? (T)Items[k] : default(T);
      }
      set { Items.Insert((int)key, (T)value); }
    }

    public void InvokeOnAdd(object item, object index)
    {
      if (OnAdd != null) { OnAdd.Invoke(this, new CollectionEventArgs<T, int>((T) item, (int) index)); }
    }

    public void InvokeOnChange(object item, object index)
    {
      if (OnChange != null) { OnChange.Invoke(this, new CollectionEventArgs<T, int>((T) item, (int) index)); }
    }

    public void InvokeOnRemove(object item, object index)
    {
      if (OnRemove != null) { OnRemove.Invoke(this, new CollectionEventArgs<T, int>((T) item, (int) index)); }
    }
  }

  public class MapSchema<T> : ISchemaCollection
  {
    public Dictionary<string, T> Items;
    public event EventHandler<CollectionEventArgs<T, string>> OnAdd;
    public event EventHandler<CollectionEventArgs<T, string>> OnChange;
    public event EventHandler<CollectionEventArgs<T, string>> OnRemove;

    public MapSchema(Dictionary<string, T> items = null)
    {
      Items = items ?? new Dictionary<string, T>();
    }

    public object CreateItemInstance()
    {
      return (T) Activator.CreateInstance(typeof(T));
    }

    public bool HasSchemaChild
    {
      get { return typeof(T) == typeof(Schema); }
    }

    public T this[string key]
    {
      get { return Items[key]; }
      set { Items[key] = value; }
    }

    public object this[object key]
    {
      get { return (T) Items[(string) key]; }
      set { Items[(string) key] = (T) value; }
    }

    public int Count
    {
      get { return Items.Count; }
    }

    public void InvokeOnAdd(object item, object index)
    {
      if (OnAdd != null) { OnAdd.Invoke(this, new CollectionEventArgs<T, string>((T)item, (string)index)); }
    }

    public void InvokeOnChange(object item, object index)
    {
      if (OnChange != null) { OnChange.Invoke(this, new CollectionEventArgs<T, string>((T)item, (string)index)); }
    }

    public void InvokeOnRemove(object item, object index)
    {
      if (OnRemove != null) { OnRemove.Invoke(this, new CollectionEventArgs<T, string>((T)item, (string)index)); }
    }
  }

  public class Schema
  {
    protected Dictionary<int, string> fieldsByIndex = new Dictionary<int, string>();
    protected Dictionary<string, string> fieldTypes = new Dictionary<string, string>();
    protected Dictionary<string, System.Type> fieldChildTypes = new Dictionary<string, System.Type>();

    public event EventHandler<OnChangeEventArgs> OnChange;
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
      get { 
        return GetType().GetField(propertyName).GetValue(this); 
      }
      set {
        var field = GetType().GetField(propertyName);
        field.SetValue(this, Convert.ChangeType(value, field.FieldType)); 
      }
    }

    public void Decode(byte[] bytes, Iterator it = null)
    {
      var decode = Decoder.GetInstance();

      if (it == null) { it = new Iterator(); }

      var changes = new List<DataChange>();
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
        System.Type childType;
        fieldChildTypes.TryGetValue(field, out childType);

        object value = null;

        object change = null;
        bool hasChange = false;

        if (fieldType == "ref")
        {
          // child schema type
          if (decode.NilCheck(bytes, it))
          {
            it.Offset++;
            value = null;

          }
          else
          {
            value = this[field] ?? Activator.CreateInstance(childType);
            (value as Schema).Decode(bytes, it);
          }

          hasChange = true;
        }
        else if (fieldType == "array")
        {
          change = new List<object>();

          // array type
          ISchemaCollection valueRef = (ISchemaCollection) (this[field] ?? Activator.CreateInstance(childType));
          ISchemaCollection currentValue = valueRef as ISchemaCollection;
          //value = valueRef;// TODO: clone

          int newLength = Convert.ToInt32(decode.DecodeNumber(bytes, it));
          int numChanges = Convert.ToInt32(decode.DecodeNumber(bytes, it));

          hasChange = (numChanges > 0);

          bool hasIndexChange = false;

          // ensure current array has the same length as encoded one
          if (currentValue.Count > newLength)
          {
            for (var i=newLength; i<currentValue.Count; i++)
            {
              var item = currentValue[i];
              if (item is Schema && (item as Schema).OnRemove != null)
              {
                (item as Schema).OnRemove.Invoke(this, new EventArgs());
              }
              currentValue.InvokeOnRemove(item, i);
            }

            // reduce items length
            (currentValue as ArraySchema<object>).Items = (currentValue as ArraySchema<object>).Items.GetRange(0, newLength);
          }

          for (var i=0; i<numChanges; i++)
          {
            var newIndex = Convert.ToInt32(decode.DecodeNumber(bytes, it));

            int indexChangedFrom = -1;
            if (decode.IndexChangeCheck(bytes, it))
            {
              decode.DecodeUint8(bytes, it);
              indexChangedFrom = Convert.ToInt32(decode.DecodeNumber(bytes, it));
              hasIndexChange = true;
            }

            var isNew = (!hasIndexChange && currentValue[newIndex] == null) || (hasIndexChange && indexChangedFrom != -1);

            if (currentValue.HasSchemaChild)
            {
              Schema item = null;

              if (isNew)
              {
                item = (Schema) currentValue.CreateItemInstance();

              } else if (indexChangedFrom != -1)
              {
                item = (Schema) valueRef[indexChangedFrom];
              }
              else
              {
                item = (Schema) valueRef[newIndex];
              }

              if (item == null)
              {
                item = (Schema) currentValue.CreateItemInstance();
                isNew = true;
              }

              if (decode.NilCheck(bytes, it))
              {
                it.Offset++;
                valueRef.InvokeOnRemove(item, newIndex);
                continue;
              }

              item.Decode(bytes, it);
              currentValue[newIndex] = item;
            }
            else
            {
              currentValue[newIndex] = decode.DecodePrimitiveType(fieldType, bytes, it);
            }

            if (isNew)
            {
              currentValue.InvokeOnAdd(currentValue[newIndex], newIndex);
            }
            else
            {
              currentValue.InvokeOnChange(currentValue[newIndex], newIndex);
            }

            (change as List<object>).Add(currentValue[newIndex]);
          }

          value = currentValue;
        }
        else if (fieldType == "map")
        {
          // map type
        }
        else
        {
          // primitive type
          value = decode.DecodePrimitiveType(fieldType, bytes, it);
          hasChange = true;
        }

        if (hasChange)
        {
          changes.Add(new DataChange
          {
            Field = field,
            Value = (change != null) ? change : value,
            PreviousValue = this[field]
          });
        }

        this[field] = value;
      }

      if (changes.Count > 0 && OnChange != null)
      {
        // TODO: provide 'changes' list to onChange event.
        OnChange.Invoke(this, new OnChangeEventArgs(changes));
      }
    }
  }
}
