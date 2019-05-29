#include <iostream>
#include "schema.h"
#include "ArraySchemaTypes.hpp"

int main()
{
    const unsigned char encodedState[] = { 0, 2, 2, 0, 0, 100, 1, 208, 156, 193, 1, 0, 100, 1, 208, 156, 193, 1, 4, 4, 0, 0, 1, 10, 2, 20, 3, 30, 2, 3, 3, 0, 163, 111, 110, 101, 1, 163, 116, 119, 111, 2, 165, 116, 104, 114, 101, 101, 3, 3, 3, 0, 232, 3, 0, 0, 1, 208, 7, 0, 0, 2, 72, 244, 255, 255 };

    ArraySchemaTypes *p = new ArraySchemaTypes();
    std::cerr << "============ about to decode\n";
    p->decode(encodedState, sizeof(encodedState) / sizeof(unsigned char));
    std::cerr << "============ decoded ================================================================ \n";

    std::cout << "state.arrayOfNumbers.size() " << p->arrayOfNumbers->size() << std::endl;
    std::cout << "state.arrayOfNumbers[0] " << p->arrayOfNumbers->at(0) << std::endl;
    std::cout << "state.arrayOfNumbers[1] " << p->arrayOfNumbers->at(1) << std::endl;
    std::cout << "state.arrayOfNumbers[2] " << p->arrayOfNumbers->at(2) << std::endl;
    std::cout << "state.arrayOfNumbers[3] " << p->arrayOfNumbers->at(3) << std::endl;

    std::cout << "state.arrayOfSchemas.size() " << p->arrayOfSchemas->size() << std::endl;
    std::cout << "state.arrayOfSchemas[0].x " << p->arrayOfSchemas->at(0)->x << std::endl;
    std::cout << "state.arrayOfSchemas[0].y " << p->arrayOfSchemas->at(0)->y << std::endl;
    std::cout << "state.arrayOfSchemas[1].x " << p->arrayOfSchemas->at(1)->x << std::endl;
    std::cout << "state.arrayOfSchemas[1].y " << p->arrayOfSchemas->at(1)->y << std::endl;

    std::cout << "state.arrayOfStrings.size() " << p->arrayOfStrings->size() << std::endl;
    std::cout << "state.arrayOfStrings[0] " << p->arrayOfStrings->at(0) << std::endl;
    std::cout << "state.arrayOfStrings[1] " << p->arrayOfStrings->at(1) << std::endl;
    std::cout << "state.arrayOfStrings[2] " << p->arrayOfStrings->at(2) << std::endl;

    std::cout << "state.arrayOfInt32.size() " << p->arrayOfInt32->size() << std::endl;
    std::cout << "state.arrayOfInt32[0] " << p->arrayOfInt32->at(0) << std::endl;
    std::cout << "state.arrayOfInt32[1] " << p->arrayOfInt32->at(1) << std::endl;
    std::cout << "state.arrayOfInt32[2] " << p->arrayOfInt32->at(2) << std::endl;

    std::cout << std::endl;

    delete p;
    return 0;
}
