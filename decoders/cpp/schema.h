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

namespace Colyseus
{

using varint_t = float; // "number"
using string = std::string; // "number"
using float32_t = float;
using float64_t = double;

struct Iterator
{
    int offset = 0;
};

enum class SPEC : unsigned char
{
    END_OF_STRUCTURE = 0xc1, // (msgpack spec: never used)
    NIL = 0xc0,
    INDEX_CHANGE = 0xd4,
};

string* decodeString(const unsigned char bytes[], Iterator *it)
{
    auto str_size = (bytes[it->offset++] & 0x1f) + 1;
    std::cout << "str_size: " << str_size << std::endl; 
    char *str = new char[str_size];
    memcpy(str, bytes + it->offset, str_size);
    str[str_size - 1] = '\0'; // endl
    it->offset += str_size;
    return new string(str);
}

template <typename T>
struct DataChange
{
    string field;
    T value;
    T previousValue;
};

class Schema
{
  public:
    std::function<void(Schema*, std::vector<DataChange<char *>>)> onChange;
    std::function<void()> onRemove;

    void decode(const unsigned char bytes[], int totalBytes, Iterator *it = new Iterator())
    {
        std::vector<DataChange<char *>> changes;

        while (it->offset < totalBytes)
        {
            unsigned char index = (unsigned char) bytes[it->offset++];

            if (index == (unsigned char) SPEC::END_OF_STRUCTURE)
            {
                break;
            }

            std::cout << "INDEX: " << index << std::endl;
            std::cout << "_indexes.length => " << (this->_indexes.size()) << std::endl;

            string field = this->_indexes.at(index);
            string type = this->_types.at(index);

            std::cout << "FIELD: " << field << std::endl;
            // std::type_info& fieldType = typeid(this[field]);

            char *value = nullptr;
            char *change = nullptr;

            bool hasChange = false;

            if (type == "ref")
            {
            }
            else if (type == "array")
            {
            }
            else if (type == "map")
            {
            }
            else
            {
                value = this->decodePrimitiveType(type, bytes, it);
                hasChange = true;
            }

            if (hasChange && this->onChange)
            {
                DataChange<char*> dataChange = DataChange<char*>();
                dataChange.field = field;
                dataChange.value = value;

                changes.push_back(dataChange);
            }

            this->assignPrimitiveType(type, field, value);
            return;
        }

        // trigger onChange callback.
        if (this->onChange)
        {
            this->onChange(this, changes);
        }
    }

  protected:
    std::vector<string> _order;
    std::map<int, string> _indexes;

    std::map<int, string> _types;
    std::map<int, std::type_index> _childTypes;

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
    virtual Schema getSchema(string field) { return Schema(); }

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
    virtual void setSchema(string field, Schema value) {}

  private:
    char* decodePrimitiveType(string type, const unsigned char bytes[], Iterator *it)
    {
        if (type == "string")
        {
            return (char *)decodeString(bytes, it);
        }
        else if (type == "number")
        {
        }
        else if (type == "boolean")
        {
        }
        else if (type == "int8")
        {
        }
        else if (type == "uint8")
        {
        }
        else if (type == "int16")
        {
        }
        else if (type == "uint16")
        {
        }
        else if (type == "int32")
        {
        }
        else if (type == "uint32")
        {
        }
        else if (type == "int64")
        {
        }
        else if (type == "uint64")
        {
        }
        else if (type == "float32")
        {
        }
        else if (type == "float64")
        {
        }
        else
        {
            throw std::invalid_argument("cannot decode invalid type: " + type);
        }

        return nullptr;
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

} // namespace Colyseus

#endif