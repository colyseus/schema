/**
 * @colyseus/schema decoder for C/C++
 * Do not modify this file unless you know exactly what you're doing.
 * 
 * This file is part of Colyseus: https://github.com/colyseus/colyseus
 */
#ifndef __COLYSEUS_SCHEMA_H__
#define __COLYSEUS_SCHEMA_H__ 1

#include <vector>

namespace Colyseus
{
    struct Schema {
        // Schema();
        // virtual ~Schema();

        static const std::vector<std::string> _fields;

        void decode(char* bytes) {
        }
    };

}

#endif 