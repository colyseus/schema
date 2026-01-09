import typescript from '@rollup/plugin-typescript';

export default [
    // https://github.com/microsoft/TypeScript/issues/18442#issuecomment-749896695

    {
        input: ['src/index.ts'],
        output: [{ dir: 'build/esm', format: 'esm', entryFileNames: '[name].mjs', sourcemap: true, preserveModules: false }],
        plugins: [typescript({ tsconfig: './tsconfig/tsconfig.esm.json' })],
    },

    {
        input: ['src/index.ts'],
        output: [{ dir: 'build/cjs', format: 'cjs', entryFileNames: '[name].cjs', sourcemap: true, preserveModules: false}],
        plugins: [typescript({ tsconfig: './tsconfig/tsconfig.cjs.json' })],
    },

    {
        input: ['src/index.ts'],
        output: [{ dir: 'build/umd', name: "schema", format: 'umd', entryFileNames: '[name].js', preserveModules: false }],
        plugins: [typescript({ tsconfig: './tsconfig/tsconfig.cjs.json' })],
    },
];
