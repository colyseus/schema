import typescript from '@rollup/plugin-typescript';

export default [
    // https://github.com/microsoft/TypeScript/issues/18442#issuecomment-749896695
    {
        input: ['src/index.ts'],
        output: [{ dir: 'build', format: 'esm', entryFileNames: '[name].mjs', sourcemap: true, preserveModules: false }],
        plugins: [typescript({ tsconfig: './tsconfig/tsconfig.esm.json' })],
    },

    {
        input: ['src/index.ts'],
        output: [{ dir: 'build', format: 'cjs', entryFileNames: '[name].cjs', sourcemap: true, preserveModules: false}],
        plugins: [typescript({ tsconfig: './tsconfig/tsconfig.cjs.json' })],
    },

    {
        input: ['src/index.ts'],
        output: [{ dir: 'build', name: "schema", format: 'umd', entryFileNames: '[name].js', preserveModules: false }],
        plugins: [typescript({ tsconfig: './tsconfig/tsconfig.cjs.json' })],
    },

    // Codegen CLI (CJS for Node.js CLI compatibility)
    {
        input: ['src/codegen/cli.ts'],
        output: [{
            dir: 'build/codegen',
            format: 'cjs',
            entryFileNames: '[name].cjs',
            sourcemap: true,
            banner: '#!/usr/bin/env node'
        }],
        plugins: [typescript({ tsconfig: './tsconfig/tsconfig.cjs.json' })],
        external: ['fs', 'path', 'module', 'typescript']
    },
];
