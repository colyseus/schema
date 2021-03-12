import typescript from '@rollup/plugin-typescript';

export default [
    // https://github.com/microsoft/TypeScript/issues/18442#issuecomment-749896695

    {
        preserveModules: false,
        input: ['src/index.ts'],
        output: [{ dir: 'build/esm', format: 'esm', entryFileNames: '[name].mjs', sourcemap: true }],
        plugins: [typescript({ tsconfig: './tsconfig/tsconfig.esm.json' })],
    },

    {
        preserveModules: false,
        input: ['src/index.ts'],
        output: [{ dir: 'build/cjs', format: 'cjs', entryFileNames: '[name].js', sourcemap: true }],
        plugins: [typescript({ tsconfig: './tsconfig/tsconfig.cjs.json' })],
    },

    {
        preserveModules: false,
        input: ['src/index.ts'],
        output: [{ dir: 'build/umd', name: "schema", format: 'umd', entryFileNames: '[name].js' }],
        plugins: [typescript({ tsconfig: './tsconfig/tsconfig.cjs.json' })],
    },
];
