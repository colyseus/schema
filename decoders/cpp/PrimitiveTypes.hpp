// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 0.4.48
// 
#ifndef __SCHEMA_CODEGEN_PRIMITIVETYPES_H__
#define __SCHEMA_CODEGEN_PRIMITIVETYPES_H__ 1

#include "schema.h"
#include <typeinfo>
#include <typeindex>



using namespace colyseus::schema;


class PrimitiveTypes : public Schema {
public:
	 int8_t int8 = 0;
	 uint8_t uint8 = 0;
	 int16_t int16 = 0;
	 uint16_t uint16 = 0;
	 int32_t int32 = 0;
	 uint32_t uint32 = 0;
	 int64_t int64 = 0;
	 uint64_t uint64 = 0;
	 float32_t float32 = 0;
	 float64_t float64 = 0;
	 varint_t varint_int8 = 0;
	 varint_t varint_uint8 = 0;
	 varint_t varint_int16 = 0;
	 varint_t varint_uint16 = 0;
	 varint_t varint_int32 = 0;
	 varint_t varint_uint32 = 0;
	 varint_t varint_int64 = 0;
	 varint_t varint_uint64 = 0;
	 varint_t varint_float32 = 0;
	 varint_t varint_float64 = 0;
	 string str = "";
	 bool boolean = false;

	PrimitiveTypes() {
		this->_indexes = {{0, "int8"}, {1, "uint8"}, {2, "int16"}, {3, "uint16"}, {4, "int32"}, {5, "uint32"}, {6, "int64"}, {7, "uint64"}, {8, "float32"}, {9, "float64"}, {10, "varint_int8"}, {11, "varint_uint8"}, {12, "varint_int16"}, {13, "varint_uint16"}, {14, "varint_int32"}, {15, "varint_uint32"}, {16, "varint_int64"}, {17, "varint_uint64"}, {18, "varint_float32"}, {19, "varint_float64"}, {20, "str"}, {21, "boolean"}};
		this->_types = {{0, "int8"}, {1, "uint8"}, {2, "int16"}, {3, "uint16"}, {4, "int32"}, {5, "uint32"}, {6, "int64"}, {7, "uint64"}, {8, "float32"}, {9, "float64"}, {10, "number"}, {11, "number"}, {12, "number"}, {13, "number"}, {14, "number"}, {15, "number"}, {16, "number"}, {17, "number"}, {18, "number"}, {19, "number"}, {20, "string"}, {21, "boolean"}};
		this->_childPrimitiveTypes = {};
		this->_childSchemaTypes = {};
	}

	~PrimitiveTypes() {
		
	}

protected:
	int8_t getInt8(string field)
	{
		if (field == "int8")
		{
			return this->int8;

		}
		return Schema::getInt8(field);
	}

	void setInt8(string field, int8_t value)
	{
		if (field == "int8")
		{
			this->int8 = value;
			return;

		}
		return Schema::setInt8(field, value);
	}
	uint8_t getUint8(string field)
	{
		if (field == "uint8")
		{
			return this->uint8;

		}
		return Schema::getUint8(field);
	}

	void setUint8(string field, uint8_t value)
	{
		if (field == "uint8")
		{
			this->uint8 = value;
			return;

		}
		return Schema::setUint8(field, value);
	}
	int16_t getInt16(string field)
	{
		if (field == "int16")
		{
			return this->int16;

		}
		return Schema::getInt16(field);
	}

	void setInt16(string field, int16_t value)
	{
		if (field == "int16")
		{
			this->int16 = value;
			return;

		}
		return Schema::setInt16(field, value);
	}
	uint16_t getUint16(string field)
	{
		if (field == "uint16")
		{
			return this->uint16;

		}
		return Schema::getUint16(field);
	}

	void setUint16(string field, uint16_t value)
	{
		if (field == "uint16")
		{
			this->uint16 = value;
			return;

		}
		return Schema::setUint16(field, value);
	}
	int32_t getInt32(string field)
	{
		if (field == "int32")
		{
			return this->int32;

		}
		return Schema::getInt32(field);
	}

	void setInt32(string field, int32_t value)
	{
		if (field == "int32")
		{
			this->int32 = value;
			return;

		}
		return Schema::setInt32(field, value);
	}
	uint32_t getUint32(string field)
	{
		if (field == "uint32")
		{
			return this->uint32;

		}
		return Schema::getUint32(field);
	}

	void setUint32(string field, uint32_t value)
	{
		if (field == "uint32")
		{
			this->uint32 = value;
			return;

		}
		return Schema::setUint32(field, value);
	}
	int64_t getInt64(string field)
	{
		if (field == "int64")
		{
			return this->int64;

		}
		return Schema::getInt64(field);
	}

	void setInt64(string field, int64_t value)
	{
		if (field == "int64")
		{
			this->int64 = value;
			return;

		}
		return Schema::setInt64(field, value);
	}
	uint64_t getUint64(string field)
	{
		if (field == "uint64")
		{
			return this->uint64;

		}
		return Schema::getUint64(field);
	}

	void setUint64(string field, uint64_t value)
	{
		if (field == "uint64")
		{
			this->uint64 = value;
			return;

		}
		return Schema::setUint64(field, value);
	}
	float32_t getFloat32(string field)
	{
		if (field == "float32")
		{
			return this->float32;

		}
		return Schema::getFloat32(field);
	}

	void setFloat32(string field, float32_t value)
	{
		if (field == "float32")
		{
			this->float32 = value;
			return;

		}
		return Schema::setFloat32(field, value);
	}
	float64_t getFloat64(string field)
	{
		if (field == "float64")
		{
			return this->float64;

		}
		return Schema::getFloat64(field);
	}

	void setFloat64(string field, float64_t value)
	{
		if (field == "float64")
		{
			this->float64 = value;
			return;

		}
		return Schema::setFloat64(field, value);
	}
	varint_t getNumber(string field)
	{
		if (field == "varint_int8")
		{
			return this->varint_int8;

		} else if (field == "varint_uint8")
		{
			return this->varint_uint8;

		} else if (field == "varint_int16")
		{
			return this->varint_int16;

		} else if (field == "varint_uint16")
		{
			return this->varint_uint16;

		} else if (field == "varint_int32")
		{
			return this->varint_int32;

		} else if (field == "varint_uint32")
		{
			return this->varint_uint32;

		} else if (field == "varint_int64")
		{
			return this->varint_int64;

		} else if (field == "varint_uint64")
		{
			return this->varint_uint64;

		} else if (field == "varint_float32")
		{
			return this->varint_float32;

		} else if (field == "varint_float64")
		{
			return this->varint_float64;

		}
		return Schema::getNumber(field);
	}

	void setNumber(string field, varint_t value)
	{
		if (field == "varint_int8")
		{
			this->varint_int8 = value;
			return;

		} else if (field == "varint_uint8")
		{
			this->varint_uint8 = value;
			return;

		} else if (field == "varint_int16")
		{
			this->varint_int16 = value;
			return;

		} else if (field == "varint_uint16")
		{
			this->varint_uint16 = value;
			return;

		} else if (field == "varint_int32")
		{
			this->varint_int32 = value;
			return;

		} else if (field == "varint_uint32")
		{
			this->varint_uint32 = value;
			return;

		} else if (field == "varint_int64")
		{
			this->varint_int64 = value;
			return;

		} else if (field == "varint_uint64")
		{
			this->varint_uint64 = value;
			return;

		} else if (field == "varint_float32")
		{
			this->varint_float32 = value;
			return;

		} else if (field == "varint_float64")
		{
			this->varint_float64 = value;
			return;

		}
		return Schema::setNumber(field, value);
	}
	string getString(string field)
	{
		if (field == "str")
		{
			return this->str;

		}
		return Schema::getString(field);
	}

	void setString(string field, string value)
	{
		if (field == "str")
		{
			this->str = value;
			return;

		}
		return Schema::setString(field, value);
	}
	bool getBoolean(string field)
	{
		if (field == "boolean")
		{
			return this->boolean;

		}
		return Schema::getBoolean(field);
	}

	void setBoolean(string field, bool value)
	{
		if (field == "boolean")
		{
			this->boolean = value;
			return;

		}
		return Schema::setBoolean(field, value);
	}


};


#endif
