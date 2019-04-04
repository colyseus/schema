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
    memcpy(str, bytes + it->offset + 1, str_size);
    str[str_size - 1] = '\0'; // endl
    it->offset += str_size;
    return string(str);
}

int8_t decodeInt8(const unsigned char bytes[], Iterator *it)
{
    return 0;
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
    std::vector<T*> items;

    std::function<void(ArraySchema<T>*, T *, int)> OnAdd;
    std::function<void(ArraySchema<T>*, T *, int)> onChange;
    std::function<void(ArraySchema<T>*, T *, int)> onRemove;

    T &operator[](const int &index)
    {
        return items[index];
    }
};

template <typename T>
class MapSchema
{
  public:
    std::map<string, T*> items;

    std::function<void(ArraySchema<T> *, T *, string)> OnAdd;
    std::function<void(ArraySchema<T> *, T *, string)> onChange;
    std::function<void(ArraySchema<T> *, T *, string)> onRemove;

    T &operator[](string &index)
    {
        return items[index];
    }
};

class Schema
{
  public:
    std::function<void(Schema*, std::vector<DataChange>)> onChange;
    std::function<void()> onRemove;

    void decode(const unsigned char bytes[], int totalBytes, Iterator *it = new Iterator())
    {
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
                auto childType = this->_childTypes.at(index);

                if (nilCheck(bytes, it)) {
                    it->offset++;
                    this->setSchema(field, nullptr);

                } else {
                    Schema* value = this->getSchema(field);

                    if (value == nullptr) {
                        value = this->createInstance(childType);
                    }

                    value->decode(bytes, totalBytes, it);
                }

                hasChange = true;
            }
            else if (type == "array")
            {

            }
            else if (type == "map")
            {

            }
            else
            {
                this->decodePrimitiveType(field, type, bytes, it);
                hasChange = true;
            }

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
    }

  protected:
    std::vector<string> _order;
    std::map<unsigned char, string> _indexes;

    std::map<unsigned char, string> _types;
    std::map<unsigned char, std::type_index> _childTypes;

    // typed virtual getters by field
    virtual string getString(string field) { return ""; }
    virtual varint_t getNumber(string field) { return 0; }
    virtual bool getBool(string field) { return 0; }
    virtual int8_t getInt8(string field) { return 0; }
    virtual uint8_t getUint8(string field) { return 0; }
    virtual int16_t getInt16(string field) { return 0; }
    virtual uint16_t getUint16(string field) { return 0; }
    virtual int32_t getInt32(string field) { return 0; }
    virtual uint32_t getUint32(string field) { return 0; }
    virtual int64_t getInt64(string field) { return 0; }
    virtual uint64_t getUInt64(string field) { return 0; }
    virtual float32_t getFloat32(string field) { return 0; }
    virtual float64_t getFloat64(string field) { return 0; }
    virtual Schema* getSchema(string field) { return nullptr; }

    // typed virtual setters by field
    virtual void setString(string field, string value) {}
    virtual void setNumber(string field, varint_t value) {}
    virtual void setBool(string field, bool value) {}
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
    virtual void setSchema(string field, Schema* value) {}

    virtual Schema* createInstance(std::type_index type) { return nullptr; }

  private:
    void decodePrimitiveType(string field, string type, const unsigned char bytes[], Iterator *it)
    {
        if (type == "string")
        {
            this->setString(field, decodeString(bytes, it));
        }
        else if (type == "number")
        {
            this->setNumber(field, decodeNumber(bytes, it));
        }
        else if (type == "boolean")
        {
            this->setBool(field, decodeBoolean(bytes, it));
        }
        else if (type == "int8")
        {
            this->setInt8(field, decodeInt8(bytes, it));
        }
        else if (type == "uint8")
        {
            this->setUint8(field, decodeUint8(bytes, it));
        }
        else if (type == "int16")
        {
            this->setInt16(field, decodeInt16(bytes, it));
        }
        else if (type == "uint16")
        {
            this->setUint16(field, decodeUint16(bytes, it));
        }
        else if (type == "int32")
        {
            this->setInt32(field, decodeInt32(bytes, it));
        }
        else if (type == "uint32")
        {
            this->setUint32(field, decodeUint32(bytes, it));
        }
        else if (type == "int64")
        {
            this->setInt64(field, decodeInt64(bytes, it));
        }
        else if (type == "uint64")
        {
            this->setUint64(field, decodeUint64(bytes, it));
        }
        else if (type == "float32")
        {
            this->setFloat32(field, decodeFloat32(bytes, it));
        }
        else if (type == "float64")
        {
            this->setFloat64(field, decodeFloat64(bytes, it));
        }
        else
        {
            throw std::invalid_argument("cannot decode invalid type: " + type);
        }
    }

    void assignPrimitiveType(string type, string field, char* value)
    {
        if (type == "string")
        {
            this->setString(field, static_cast<string>(value));
        }
        else if (type == "number")
        {
            this->setNumber(field, (varint_t) *value);
        }
        else if (type == "boolean")
        {
            this->setBool(field, (bool) *value);
        }
        else if (type == "int8")
        {
            this->setInt8(field, (int8_t) *value);
        }
        else if (type == "uint8")
        {
            this->setUint8(field, (uint8_t) *value);
        }
        else if (type == "int16")
        {
            this->setInt16(field, (int16_t) *value);
        }
        else if (type == "uint16")
        {
            this->setUint16(field, (uint16_t) *value);
        }
        else if (type == "int32")
        {
            this->setInt32(field, (int32_t) *value);
        }
        else if (type == "uint32")
        {
            this->setUint32(field, (uint32_t) *value);
        }
        else if (type == "int64")
        {
            this->setInt64(field, (int64_t) *value);
        }
        else if (type == "uint64")
        {
            this->setUint64(field, (uint64_t) *value);
        }
        else if (type == "float32")
        {
            this->setFloat32(field, (float32_t) *value);
        }
        else if (type == "float64")
        {
            this->setFloat64(field, (float64_t) *value);
        }
        else
        {
            throw std::invalid_argument("cannot decode invalid type: " + type);
        }

    }
};

} // namespace schema
} // namespace colyseus

#endif