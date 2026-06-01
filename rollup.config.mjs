import typescript from '@rollup/plugin-typescript';

/**
 * Build config for the `@colyseus/schema/input` subpath. The input source
 * imports `Encoder`, `Decoder`, symbols, encoding helpers, etc. via relative
 * paths (`../encoder/Encoder.js`, ...) — we externalize those at bundle time
 * and rewrite them to `@colyseus/schema` so the resulting bundle is a thin
 * wrapper. At runtime, both `import "@colyseus/schema"` and
 * `import "@colyseus/schema/input"` resolve those classes to the SAME module
 * instance, preserving class identity across the two subpaths.
 */
function inputBundleConfig({ format, outputDir, entryFileExt, tsconfig, sourcemap }) {
    return {
        input: ['src/input/index.ts'],
        output: [{
            dir: outputDir,
            format,
            entryFileNames: `[name].${entryFileExt}`,
            sourcemap,
            preserveModules: false,
        }],
        // Treat the relative `../...` imports as externals so rollup emits
        // them as runtime `import` statements rather than inlining the
        // implementations.
        external: (id) => id.startsWith('../') || id === '@colyseus/schema',
        plugins: [
            typescript({ tsconfig }),
            {
                name: 'rewrite-input-imports-to-main-bundle',
                renderChunk(code) {
                    // Map every relative parent import the input source uses
                    // to the package name. The main bundle re-exports
                    // everything the input bundle needs from its public
                    // surface, so the named imports keep working.
                    return code.replace(
                        /from\s*(['"])\.\.\/[^'"]+\1/g,
                        'from "@colyseus/schema"',
                    );
                },
            },
        ],
    };
}

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

    // `@colyseus/schema/input` — InputEncoder/InputDecoder.
    //
    // The previous build bundled this entry standalone, which dragged in a
    // second copy of `Schema`/`Metadata`/`TypeContext`/`Encoder`/`Decoder`.
    // Consumers that imported both `@colyseus/schema` AND
    // `@colyseus/schema/input` (i.e. any colyseus server) ended up with two
    // `Schema` class identities; `TypeContext.discoverTypes`'s
    // `parent !== Schema` walk crossed bundle boundaries and ran
    // `Metadata.initialize(theOtherSchema)`, polluting its metadata slot.
    // With HMR, fields then accumulated across reloads until the 64-field
    // cap threw.
    //
    // Fix: externalize every `../...` import in the input source to
    // `@colyseus/schema` so this bundle is a small wrapper that resolves the
    // identity-bearing classes from the main bundle at runtime — one Schema
    // per process. The main bundle (`./index.mjs`) does NOT include
    // InputEncoder/InputDecoder, so SDK / browser consumers don't pay for it.
    inputBundleConfig({
        format: 'esm',
        outputDir: 'build/input',
        entryFileExt: 'mjs',
        tsconfig: './tsconfig/tsconfig.esm.json',
        sourcemap: true,
    }),
    inputBundleConfig({
        format: 'cjs',
        outputDir: 'build/input',
        entryFileExt: 'cjs',
        tsconfig: './tsconfig/tsconfig.cjs.json',
        sourcemap: true,
    }),

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
