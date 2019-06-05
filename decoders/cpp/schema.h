/**
 * @colyseus/schema decoder for C/C++
 * Do not modify this file unless you know exactly what you're doing.
 *
 * This file is part of Colyseus: https://github.com/colyseus/colyseus
 */
#ifndef __COLYSEUS_SCHEMA_H__
#define __COLYSEUS_SCHEMA_H__ 1

#include <iostream>
#include <stdint.h>

#include <cstring>
#include <functional>
#include <vector>
#include <string>
#include <map>

#include <typeinfo>
#include <typeindex>

namespace colyseus
{
namespace schema
{

using varint_t = float; // "number"
using string = std::string;
using float32_t = float;
using float64_t = double;

enum class SPEC : unsigned char
{
    END_OF_STRUCTURE = 0xc1, // (msgpack spec: never used)
    NIL = 0xc0,
    INDEX_CHANGE = 0xd4,
};

struct Iterator
{
    int offset = 0;
};

// template <typename T>
struct DataChange
{
    string field;
    // T value;
    // T previousValue;
};

bool IsLittleEndian()
{
    int i = 1;
    return (int)*((unsigned char *)&i) == 1;
}

string decodeString(const unsigned char bytes[], Iterator *it)
{
    auto str_size = (bytes[it->offset] & 0x1f) + 1;
    char *str = new char[str_size];
    std::memcpy(str, bytes + it->offset + 1, str_size);
    str[str_size - 1] = '\0'; // endl
    it->offset += str_size;

    string value(str);
    delete[] str;
    return value;
}


int8_t decodeInt8(const unsigned char bytes[], Iterator *it)
{
    return (int8_t)(bytes[it->offset++] << 24 >> 24);
}

uint8_t decodeUint8(const unsigned char bytes[], Iterator *it)
{
    return (uint8_t)bytes[it->offset++];
}

int16_t decodeInt16(const unsigned char bytes[], Iterator *it)
{
    int16_t value = *(int16_t *)&bytes[it->offset];
    it->offset += 2;
    return value;
}

uint16_t decodeUint16(const unsigned char bytes[], Iterator *it)
{
    uint16_t value = *(uint16_t *)&bytes[it->offset];
    it->offset += 2;
    return value;
}

int32_t decodeInt32(const unsigned char bytes[], Iterator *it)
{
    int32_t value = *(int32_t *)&bytes[it->offset];
    it->offset += 4;
    return value;
}

uint32_t decodeUint32(const unsigned char bytes[], Iterator *it)
{
    uint32_t value = *(uint32_t *)&bytes[it->offset];
    it->offset += 4;
    return value;
}

int64_t decodeInt64(const unsigned char bytes[], Iterator *it)
{
    int64_t value = *(int64_t *)&bytes[it->offset];
    it->offset += 8;
    return value;
}

uint64_t decodeUint64(const unsigned char bytes[], Iterator *it)
{
    uint64_t value = *(uint64_t *)&bytes[it->offset];
    it->offset += 8;
    return value;
}

float32_t decodeFloat32(const unsigned char bytes[], Iterator *it)
{
    float32_t value = *(float32_t *)&bytes[it->offset];
    it->offset += 4;
    return value;
}

float64_t decodeFloat64(const unsigned char bytes[], Iterator *it)
{
    float64_t value = *(float64_t *)&bytes[it->offset];
    it->offset += 8;
    return value;
}

varint_t decodeNumber(const unsigned char bytes[], Iterator *it)
{
    auto prefix = bytes[it->offset++];
    std::cout << "decodeNumber, prefix => " << ((int)prefix) << std::endl;

    if (prefix < 0x80)
    {
        // positive fixint
        return (varint_t)prefix;
    }
    else if (prefix == 0xca)
    {
        // float 32
        return decodeFloat32(bytes, it);
    }
    else if (prefix == 0xcb)
    {
        // float 64
        return (varint_t) decodeFloat64(bytes, it);
    }
    else if (prefix == 0xcc)
    {
        // uint 8
        return (varint_t)decodeUint8(bytes, it);
    }
    else if (prefix == 0xcd)
    {
        // uint 16
        return (varint_t) decodeUint16(bytes, it);
    }
    else if (prefix == 0xce)
    {
        // uint 32
        return (varint_t) decodeUint32(bytes, it);
    }
    else if (prefix == 0xcf)
    {
        // uint 64
        return (varint_t) decodeUint64(bytes, it);
    }
    else if (prefix == 0xd0)
    {
        // int 8
        return (varint_t) decodeInt8(bytes, it);
    }
    else if (prefix == 0xd1)
    {
        // int 16
        return (varint_t) decodeInt16(bytes, it);
    }
    else if (prefix == 0xd2)
    {
        // int 32
        return (varint_t) decodeInt32(bytes, it);
    }
    else if (prefix == 0xd3)
    {
        // int 64
        return (varint_t) decodeInt64(bytes, it);
    }
    else if (prefix > 0xdf)
    {
        // negative fixint
        return (varint_t) ((0xff - prefix + 1) * -1);
    }
    else
    {
        return 0;
    }
}

bool decodeBoolean(const unsigned char bytes[], Iterator *it)
{
    return decodeUint8(bytes, it) > 0;
}

bool numberCheck(const unsigned char bytes[], Iterator *it)
{
    auto prefix = bytes[it->offset];
    return (prefix < 0x80 || (prefix >= 0xca && prefix <= 0xd3));
}

bool arrayCheck (const unsigned char bytes[], Iterator *it) {
  return bytes[it->offset] < 0xa0;
}

bool nilCheck(const unsigned char bytes[], Iterator *it) {
  return bytes[it->offset] == (unsigned char) SPEC::NIL;
}

bool indexChangeCheck(const unsigned char bytes[], Iterator *it) {
  return bytes[it->offset] == (unsigned char) SPEC::INDEX_CHANGE;
}

template <typename T>
class ArraySchema
{
  public:
    ArraySchema() {}
    ~ArraySchema() {
        std::cout << "ArraySchema destructor!" << std::endl;
    }

    std::vector<T> items;

    std::function<void(ArraySchema<T>*, T, int)> onAdd;
    std::function<void(ArraySchema<T>*, T, int)> onChange;
    std::function<void(ArraySchema<T>*, T, int)> onRemove;

    T &operator[](const int &index) { return items[index]; }
    T at(const int &index) { return items[index]; }

    ArraySchema<T> clone()
    {
        ArraySchema<T> cloned;
        cloned.items = this->items;
        cloned.onAdd = this->onAdd;
        cloned.onRemove = this->onRemove;
        cloned.onChange = this->onChange;
        return cloned;
    }

    void setAt(int index, const T& value) {
        if (items.size() == index) {
            items.push_back(value);
        }
        else {
            items[index] = value;
        }
    }

    bool has(int index)
    {
        return items.size() > index;
    }

    int size()
    {
        return items.size();
    }
};

template <typename T>
class MapSchema
{
  public:
    MapSchema() {}
    ~MapSchema() {}

    std::map<string, T> items;

    std::function<void(MapSchema<T> *, T, string)> onAdd;
    std::function<void(MapSchema<T> *, T, string)> onChange;
    std::function<void(MapSchema<T> *, T, string)> onRemove;

    T &operator[](const char index[])
    {
        return items[index];
    }

    MapSchema<T> clone()
    {
        MapSchema<T> cloned;
        cloned.items = this->items;
        cloned.onAdd = this->onAdd;
        cloned.onRemove = this->onRemove;
        cloned.onChange = this->onChange;
        return cloned;
    }

    T at(string key)
    {
        return items.at(key);
    }

    bool has(string field)
    {
        return items.find(field) != items.end();
    }

    int size()
    {
        return items.size();
    }
};

class Schema
{
  public:
    std::function<void(Schema*, std::vector<DataChange>)> onChange;
    std::function<void()> onRemove;

    Schema() {}
    ~Schema() {}

    template <typename T>
    void decodeArrayPrimitive(ArraySchema<T> &array, int index, const unsigned char bytes[], Iterator *it,
                              T (*decoder)(const unsigned char bytes[], Iterator *it) ) {
        array.setAt(index, decoder(bytes, it));
    }

    void decode(const unsigned char bytes[], int totalBytes, Iterator *it = nullptr) //new Iterator())
    {
        bool doesOwnIterator = it == nullptr;
        if (doesOwnIterator) it = new Iterator();

        std::vector<DataChange> changes;

        while (it->offset < totalBytes)
        {
            unsigned char index = (unsigned char) bytes[it->offset++];
            std::cout << "INDEX: " << ((int)index) << std::endl;

            if (index == (unsigned char) SPEC::END_OF_STRUCTURE)
            {
                break;
            }

            string field = this->_indexes.at(index);
            string type = this->_types.at(index);

            std::cout << "FIELD: " << field << std::endl;
            // std::type_info& fieldType = typeid(this[field]);

            // char *value = nullptr;
            char *change = nullptr;

            bool hasChange = false;

            if (type == "ref")
            {
                auto childType = this->_childSchemaTypes.at(index);

                if (nilCheck(bytes, it)) {
                    it->offset++;
                    this->setRef(field, nullptr);

                } else {
                    Schema* value = this->getRef(field);

                    if (value == nullptr) {
                        value = this->createInstance(childType);
                    }

                    value->decode(bytes, totalBytes, it);
                }

                hasChange = true;
            }
            else if (type == "array")
            {
                ArraySchema<char *> *valueRef = this->getArray(field);
                ArraySchema<char *> *value = valueRef; // valueRef->clone();

                int newLength = decodeNumber(bytes, it);
                int numChanges = decodeNumber(bytes, it);

                hasChange = (numChanges > 0);
                bool isSchemaType = this->_childSchemaTypes.find(index) != this->_childSchemaTypes.end();

                // FIXME: this may not be reliable. possibly need to encode this variable during
                // serializagion
                bool hasIndexChange = false;

                // ensure current array has the same length as encoded one
                if (value->items.size() > newLength) {
                    for (int i = newLength; i < value->items.size(); i++)
                    {
                        if (isSchemaType && ((Schema*)value->items[i])->onRemove)
                        {
                            ((Schema *)value->items[i])->onRemove();
                        }
                        if (valueRef->onRemove)
                        {
                            valueRef->onRemove(valueRef, value->items[i], i);
                        }
                    }
                    value->items.resize(newLength);
                }

                for (int i = 0; i < numChanges; i++)
                {
                    int newIndex = (int) decodeNumber(bytes, it);

                    int indexChangedFrom = -1; // index change check
                    if (indexChangeCheck(bytes, it)) {
                        /*
                        it->offset++;
                        indexChangedFrom = (int) decodeNumber(bytes, it);
                        hasIndexChange = true;*/

                        decodeUint8(bytes, it);
                        indexChangedFrom = (int) decodeNumber(bytes, it);
                        hasIndexChange = true;

                    }

                    bool isNew = (!hasIndexChange && !value->has(newIndex)) || (hasIndexChange && indexChangedFrom == -1);

                    if (isSchemaType)
                    {
                        char* item;

                        if (isNew)
                        {
                            item = (char *)this->createInstance(this->_childSchemaTypes.at(index));
                        }
                        else if (indexChangedFrom != -1)
                        {
                            item = (char*) valueRef->at(indexChangedFrom);
                        }
                        else
                        {
                            item = (char *) valueRef->at(newIndex);
                        }

                        if (!item)
                        {
                            item = (char *)this->createInstance(this->_childSchemaTypes.at(index));
                            isNew = true;
                        }

                        if (nilCheck(bytes, it))
                        {
                            it->offset++;

                            if (valueRef->onRemove) {
                                valueRef->onRemove(valueRef, item, newIndex);
                            }

                            continue;
                        }

                        ((Schema*) item)->decode(bytes, totalBytes, it);
                        value->setAt(newIndex, item);
                    }
                    else
                    {
                        // FIXME: this is ugly and repetitive
                        string primitiveType = this->_childPrimitiveTypes.at(index);

                        if (primitiveType == "string")       { ((ArraySchema<string> *)value)->setAt(newIndex, decodeString(bytes, it)); }
                        else if (primitiveType == "number")  { ((ArraySchema<varint_t> *)value)->setAt(newIndex, decodeNumber(bytes, it)); }
                        else if (primitiveType == "boolean") { ((ArraySchema<bool> *)value)->setAt(newIndex, decodeBoolean(bytes, it)); }
                        else if (primitiveType == "int8")    { ((ArraySchema<int8_t> *)value)->setAt(newIndex, decodeInt8(bytes, it)); }
                        else if (primitiveType == "uint8")   { ((ArraySchema<uint8_t> *)value)->setAt(newIndex, decodeUint8(bytes, it)); }
                        else if (primitiveType == "int16")   { ((ArraySchema<int16_t> *)value)->setAt(newIndex, decodeInt16(bytes, it)); }
                        else if (primitiveType == "uint16")  { ((ArraySchema<uint16_t> *)value)->setAt(newIndex, decodeUint16(bytes, it)); }
                        else if (primitiveType == "int32")   { ((ArraySchema<int32_t> *)value)->setAt(newIndex, decodeInt32(bytes, it)); }
                        else if (primitiveType == "uint32")  { ((ArraySchema<uint32_t> *)value)->setAt(newIndex, decodeUint32(bytes, it)); }
                        else if (primitiveType == "int64")   { ((ArraySchema<int64_t> *)value)->setAt(newIndex, decodeInt64(bytes, it)); }
                        else if (primitiveType == "uint64")  { ((ArraySchema<uint64_t> *)value)->setAt(newIndex, decodeUint64(bytes, it)); }
                        else if (primitiveType == "float32") { ((ArraySchema<float32_t> *)value)->setAt(newIndex, decodeFloat32(bytes, it)); }
                        else if (primitiveType == "float64") { ((ArraySchema<float64_t> *)value)->setAt(newIndex, decodeFloat64(bytes, it)); }
                        else { throw std::invalid_argument("cannot decode invalid type: " + primitiveType); }
                    }

                    if (isNew)
                    {
                        if (valueRef->onAdd)
                        {
                            valueRef->onAdd(valueRef, value->items.at(newIndex), newIndex);
                        }
                    }
                    else if (valueRef->onChange)
                    {
                        valueRef->onChange(valueRef, value->items.at(newIndex), newIndex);
                    }

                }

                this->setArray(field, value);
                std::cout << "array set successfully! size => " << value->size() << std::endl;
            }
            else if (type == "map")
            {
                MapSchema<char *>* valueRef = this->getMap(field);
                MapSchema<char *>* value = valueRef; //valueRef.clone();

                int length = (int) decodeNumber(bytes, it);
                hasChange = (length > 0);

                bool hasIndexChange = false;
                bool isSchemaType = this->_childSchemaTypes.find(index) != this->_childSchemaTypes.end();

                // List of previous keys
                std::vector<string> previousKeys;
                for (std::map<string, char *>::iterator it = valueRef->items.begin(); it != valueRef->items.end(); ++it)
                {
                    previousKeys.push_back(it->first);
                }

                for (int i = 0; i < length; i++)
                {
                    if (it->offset > totalBytes || bytes[it->offset] == (unsigned char)SPEC::END_OF_STRUCTURE)
                    {
                        break;
                    }

                    string previousKey = "";
                    if (indexChangeCheck(bytes, it)) {
                        it->offset++;
                        previousKey = previousKeys[decodeNumber(bytes, it)];
                        hasIndexChange = true;
                    }

                    bool hasMapIndex = numberCheck(bytes, it);
                    string newKey = (hasMapIndex)
                        ? previousKeys[decodeNumber(bytes, it)]
                        : decodeString(bytes, it);

                    char* item = nullptr;
                    bool foundItem = false;
                    bool isNew = (!hasIndexChange && !valueRef->has(newKey)) || (hasIndexChange && previousKey == "" && hasMapIndex);

                    if (isNew && isSchemaType)
                    {
                        item = (char*) this->createInstance(this->_childSchemaTypes.at(index));
                        foundItem = true;

                    } else if (previousKey != "")
                    {
                        item = valueRef->at(previousKey);

                    } else
                    {
                        if (valueRef->has(newKey)) {
                            item = valueRef->at(newKey);
                        }
                        else {
                            foundItem = false;
                        }
                    }

                    if (nilCheck(bytes, it))
                    {
                        it->offset++;

                        if (isSchemaType && item != nullptr && ((Schema*)item)->onRemove) {
                            ((Schema *)item)->onRemove();
                        }

                        if (valueRef->onRemove) {
                            valueRef->onRemove(valueRef, item, newKey);
                        }

                        delete value->items[newKey];
                        value->items[newKey] = nullptr;
                        continue;

                    } else if (!isSchemaType)
                    {
                        string primitiveType = this->_childPrimitiveTypes.at(index);

                        // FIXME: this is ugly and repetitive
                        if (primitiveType == "string")       {((MapSchema<string> *)value)->items[newKey] = decodeString(bytes, it); }
                        else if (primitiveType == "number")  {((MapSchema<varint_t> *)value)->items[newKey] = decodeNumber(bytes, it); }
                        else if (primitiveType == "boolean") { ((MapSchema<bool> *)value)->items[newKey] = decodeBoolean(bytes, it) ; }
                        else if (primitiveType == "int8")    { ((MapSchema<int8_t> *)value)->items[newKey] = decodeInt8(bytes, it) ; }
                        else if (primitiveType == "uint8")   { ((MapSchema<uint8_t> *)value)->items[newKey] = decodeUint8(bytes, it) ; }
                        else if (primitiveType == "int16")   { ((MapSchema<int16_t> *)value)->items[newKey] = decodeInt16(bytes, it) ; }
                        else if (primitiveType == "uint16")  { ((MapSchema<uint16_t> *)value)->items[newKey] = decodeUint16(bytes, it) ; }
                        else if (primitiveType == "int32")   { ((MapSchema<int32_t> *)value)->items[newKey] = decodeInt32(bytes, it) ; }
                        else if (primitiveType == "uint32")  { ((MapSchema<uint32_t> *)value)->items[newKey] = decodeUint32(bytes, it) ; }
                        else if (primitiveType == "int64")   { ((MapSchema<int64_t> *)value)->items[newKey] = decodeInt64(bytes, it) ; }
                        else if (primitiveType == "uint64")  { ((MapSchema<uint64_t> *)value)->items[newKey] = decodeUint64(bytes, it) ; }
                        else if (primitiveType == "float32") { ((MapSchema<float32_t> *)value)->items[newKey] = decodeFloat32(bytes, it) ; }
                        else if (primitiveType == "float64") { ((MapSchema<float64_t> *)value)->items[newKey] = decodeFloat64(bytes, it) ; }
                        else { throw std::invalid_argument("cannot decode invalid type: " + primitiveType); }


                    }
                    else
                    {
                        ((Schema*) item)->decode(bytes, totalBytes, it);
                        value->items[newKey] = item;
                    }

                    if (isNew)
                    {
                        if (valueRef->onAdd)
                        {
                            valueRef->onAdd(valueRef, item, newKey);
                        }
                    }
                    else if (valueRef->onChange)
                    {
                        valueRef->onChange(valueRef, item, newKey);
                    }
                }

                this->setMap(field, value);

            }
            else
            {
                this->decodePrimitiveType(field, type, bytes, it);
                hasChange = true;
            }
            std::cout << "stepped out." << std::endl;

            if (hasChange && this->onChange)
            {
                DataChange dataChange = DataChange();
                dataChange.field = field;
                // dataChange.value = value;

                changes.push_back(dataChange);
            }
        }

        // trigger onChange callback.
        if (this->onChange)
        {
            this->onChange(this, changes);
        }

        if (doesOwnIterator) delete it;
    }

  protected:
    std::map<unsigned char, string> _indexes;
    std::map<unsigned char, string> _types;
    std::map<unsigned char, string> _childPrimitiveTypes;
    std::map<unsigned char, std::type_index> _childSchemaTypes;

    // typed virtual getters by field
    virtual string getString(string field) { return ""; }
    virtual varint_t getNumber(string field) { return 0; }
    virtual bool getBoolean(string field) { return 0; }
    virtual int8_t getInt8(string field) { return 0; }
    virtual uint8_t getUint8(string field) { return 0; }
    virtual int16_t getInt16(string field) { return 0; }
    virtual uint16_t getUint16(string field) { return 0; }
    virtual int32_t getInt32(string field) { return 0; }
    virtual uint32_t getUint32(string field) { return 0; }
    virtual int64_t getInt64(string field) { return 0; }
    virtual uint64_t getUint64(string field) { return 0; }
    virtual float32_t getFloat32(string field) { return 0; }
    virtual float64_t getFloat64(string field) { return 0; }
    virtual Schema* getRef(string field) { return nullptr; }
    virtual ArraySchema<char *> *getArray(string field) { return new ArraySchema<char *>(); }
    virtual MapSchema<char *> *getMap(string field) { return new MapSchema<char *>(); }

    // typed virtual setters by field
    virtual void setString(string field, string value) {}
    virtual void setNumber(string field, varint_t value) {}
    virtual void setBoolean(string field, bool value) {}
    virtual void setInt8(string field, int8_t value) {}
    virtual void setUint8(string field, uint8_t value) {}
    virtual void setInt16(string field, int16_t value) {}
    virtual void setUint16(string field, uint16_t value) {}
    virtual void setInt32(string field, int32_t value) {}
    virtual void setUint32(string field, uint32_t value) {}
    virtual void setInt64(string field, int64_t value) {}
    virtual void setUint64(string field, uint64_t value) {}
    virtual void setFloat32(string field, float32_t value) {}
    virtual void setFloat64(string field, float64_t value) {}
    virtual void setRef(string field, Schema* value) {}
    virtual void setArray(string field, ArraySchema<char*>*) {}
    virtual void setMap(string field, MapSchema<char*>*) {}

    virtual Schema* createInstance(std::type_index type) { return nullptr; }

  private:
    void decodePrimitiveType(string field, string type, const unsigned char bytes[], Iterator *it)
    {
        if (type == "string")       { this->setString(field, decodeString(bytes, it)); }
        else if (type == "number")  { this->setNumber(field, decodeNumber(bytes, it)); }
        else if (type == "boolean") { this->setBoolean(field, decodeBoolean(bytes, it)); }
        else if (type == "int8")    { this->setInt8(field, decodeInt8(bytes, it)); }
        else if (type == "uint8")   { this->setUint8(field, decodeUint8(bytes, it)); }
        else if (type == "int16")   { this->setInt16(field, decodeInt16(bytes, it)); }
        else if (type == "uint16")  { this->setUint16(field, decodeUint16(bytes, it)); }
        else if (type == "int32")   { this->setInt32(field, decodeInt32(bytes, it)); }
        else if (type == "uint32")  { this->setUint32(field, decodeUint32(bytes, it)); }
        else if (type == "int64")   { this->setInt64(field, decodeInt64(bytes, it)); }
        else if (type == "uint64")  { this->setUint64(field, decodeUint64(bytes, it)); }
        else if (type == "float32") { this->setFloat32(field, decodeFloat32(bytes, it)); }
        else if (type == "float64") { this->setFloat64(field, decodeFloat64(bytes, it)); }
        else { throw std::invalid_argument("cannot decode invalid type: " + type); }
    }
};

} // namespace schema
} // namespace colyseus

#endif
