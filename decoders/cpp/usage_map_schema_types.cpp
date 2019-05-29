#include <iostream>
#include "schema.h"
#include "MapSchemaTypes.hpp"

int main()
{
    const unsigned char encodedState[] = { 0, 2, 163, 111, 110, 101, 0, 100, 1, 204, 200, 193, 163, 116, 119, 111, 0, 205, 44, 1, 1, 205, 144, 1, 193, 1, 3, 163, 111, 110, 101, 1, 163, 116, 119, 111, 2, 165, 116, 104, 114, 101, 101, 3, 2, 2, 163, 111, 110, 101, 163, 79, 110, 101, 163, 116, 119, 111, 163, 84, 119, 111, 3, 2, 163, 111, 110, 101, 232, 3, 0, 0, 163, 116, 119, 111, 24, 252, 255, 255 };

    MapSchemaTypes *p = new MapSchemaTypes();
    std::cerr << "============ about to decode\n";
    p->decode(encodedState, sizeof(encodedState) / sizeof(unsigned char));
    std::cerr << "============ decoded ================================================================ \n";

    std::cout << "state.mapOfNumbers.size() = " << p->mapOfNumbers->size() << std::endl;
    std::cout << "state.mapOfNumbers['one'] = " << p->mapOfNumbers->at("one") << std::endl;
    std::cout << "state.mapOfNumbers['two'] = " << p->mapOfNumbers->at("two") << std::endl;
    std::cout << "state.mapOfNumbers['three'] = " << p->mapOfNumbers->at("three") << std::endl;

    std::cout << "state.mapOfSchemas['one'].x = " << p->mapOfSchemas->at("one")->x << std::endl;
    std::cout << "state.mapOfSchemas['one'].y = " << p->mapOfSchemas->at("one")->y << std::endl;
    std::cout << "state.mapOfSchemas['two'].x = " << p->mapOfSchemas->at("two")->x << std::endl;
    std::cout << "state.mapOfSchemas['two'].y = " << p->mapOfSchemas->at("two")->y << std::endl;

    std::cout << "state.mapOfStrings.size() = " << p->mapOfStrings->size() << std::endl;
    std::cout << "state.mapOfStrings['one'] = " << p->mapOfStrings->at("one") << std::endl;
    std::cout << "state.mapOfStrings['two'] = " << p->mapOfStrings->at("two") << std::endl;

    std::cout << "state.mapOfInt32['one'] = " << p->mapOfInt32->at("one") << std::endl;
    std::cout << "state.mapOfInt32['two'] = " << p->mapOfInt32->at("two") << std::endl;

    std::cout << std::endl;

    delete p;
    return 0;
}
