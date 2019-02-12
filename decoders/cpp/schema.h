/**
 * @colyseus/schema decoder for C/C++
 * Do not modify this file unless you know exactly what you're doing.
 * 
 * This file is part of Colyseus: https://github.com/colyseus/colyseus
 */
#ifndef __COLYSEUS_SCHEMA_H__
#define __COLYSEUS_SCHEMA_H__ 1

#include <vector>
#include <string>
#include <map>

namespace Colyseus
{
    struct Iterator {
        int offset = 0;
    };

    template <typename T>
    struct DataChange {
        std::string field;
        T value;
        T previousValue;
    };

    struct Schema {
        static const std::vector<std::string> _order;
        static const std::map<int, std::string> _indexes;

        void decode(const int bytes[], int length, Iterator* it = new Iterator()) {
            for(size_t i = 0; i < length; i++) {
                printf("%d\n", bytes[i]);
            }
        }
    };

}

#endif 