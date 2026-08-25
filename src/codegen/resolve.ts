import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";

import { PACKAGE_ROOT } from "./types.js";

export interface ResolveOptions {
    /** Explicit `--tsconfig`. When set, nearest-config discovery is skipped. */
    tsconfig?: string;
}

interface ResolvedConfig {
    configFilePath: string;
    options: ts.CompilerOptions;
    cache?: ts.ModuleResolutionCache;
}

interface MatchedPattern {
    substitutions: string[];
    /** What `*` captured, so substitutions can splice it back in. */
    matchedStar: string;
}

const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];

/** `No inputs were found in config file` — expected, since readDirectory is stubbed. */
const NO_INPUTS_FOUND = 18003;

let configByDir: Map<string, ResolvedConfig | null>;
let override: ResolvedConfig | null | undefined;
let resolveOptions: ResolveOptions;
let warned: Set<string>;

reset();

function reset() {
    configByDir = new Map();
    override = undefined;
    resolveOptions = {};
    warned = new Set();
}

/**
 * Drop every cached tsconfig lookup. Called once per top-level `parseFiles()`
 * run so a long-lived process can generate for two different projects.
 */
export function resetResolver(options: ResolveOptions = {}) {
    reset();
    resolveOptions = options;

    if (options.tsconfig && !fs.existsSync(options.tsconfig)) {
        throw new Error(`--tsconfig: file not found: ${options.tsconfig}`);
    }
}

function warnOnce(key: string, message: string) {
    if (warned.has(key)) { return; }
    warned.add(key);
    console.warn(message);
}

/**
 * `readDirectory` is stubbed on purpose: only `compilerOptions` is wanted here,
 * and letting TypeScript glob the config's `include` set would stat the user's
 * whole project on every config discovered.
 */
const parseConfigHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys?.useCaseSensitiveFileNames ?? true,
    readDirectory: () => [],
    fileExists: (fileName) => fs.existsSync(fileName),
    readFile: (fileName) => {
        try {
            return fs.readFileSync(fileName, "utf8");
        } catch (e) {
            if (!(e as any)?.code) { throw e; }
            return undefined;
        }
    },
};

function loadConfig(configFilePath: string): ResolvedConfig | null {
    const { config, error } = ts.readConfigFile(configFilePath, parseConfigHost.readFile);
    if (error) {
        warnOnce(configFilePath,
            `schema-codegen: could not read "${configFilePath}" ` +
            `(${ts.flattenDiagnosticMessageText(error.messageText, " ")}) — ` +
            `its import path aliases will be ignored.`);
        return null;
    }

    // parseJsonConfigFileContent (not convertCompilerOptionsFromJson) is what
    // applies `extends` chains, `${configDir}` templates, and `pathsBasePath` —
    // the directory of the config that DECLARED `paths`, which in a monorepo is
    // not the directory of the config being loaded.
    const parsed = ts.parseJsonConfigFileContent(
        config,
        parseConfigHost,
        path.dirname(configFilePath),
        undefined,
        configFilePath,
    );

    const errors = parsed.errors.filter((d) =>
        d.code !== NO_INPUTS_FOUND && d.category === ts.DiagnosticCategory.Error);

    if (errors.length > 0) {
        warnOnce(configFilePath,
            `schema-codegen: "${configFilePath}" has errors — ` +
            errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; "));
    }

    const options = parsed.options;
    if (!options.paths && !options.baseUrl) { return null; }

    const getCanonicalFileName = parseConfigHost.useCaseSensitiveFileNames
        ? (f: string) => f
        : (f: string) => f.toLowerCase();

    return {
        configFilePath,
        options,
        cache: ts.createModuleResolutionCache(
            path.dirname(configFilePath), getCanonicalFileName, options),
    };
}

function getOverrideConfig(): ResolvedConfig | null {
    if (override === undefined) {
        override = loadConfig(path.resolve(resolveOptions.tsconfig));
        if (override === null) {
            warnOnce(`no-aliases:${resolveOptions.tsconfig}`,
                `schema-codegen: "${resolveOptions.tsconfig}" declares no "paths" or ` +
                `"baseUrl" — there are no import aliases to resolve.`);
        }
    }
    return override;
}

/**
 * Nearest `tsconfig.json`/`jsconfig.json` above `containingFile`. Both names are
 * checked at every level: a distant tsconfig.json must not win over an adjacent
 * jsconfig.json. Stops at the first config found even when it declares no
 * aliases — matching `tsc`, a parent project's `paths` do not leak into a child
 * that does not `extends` it.
 */
function getConfigFor(containingFile: string): ResolvedConfig | null {
    if (resolveOptions.tsconfig) { return getOverrideConfig(); }

    const dir = path.dirname(containingFile);
    if (configByDir.has(dir)) { return configByDir.get(dir); }

    let config: ResolvedConfig | null = null;
    const visited: string[] = [];

    for (let current = dir, parent: string; ; current = parent) {
        visited.push(current);

        const found = CONFIG_NAMES
            .map((name) => path.join(current, name))
            .find((candidate) => fs.existsSync(candidate));

        if (found) {
            config = loadConfig(found);
            break;
        }

        parent = path.dirname(current);
        if (parent === current) { break; }
    }

    // memoize the whole walk, negatives included
    visited.forEach((visitedDir) => configByDir.set(visitedDir, config));

    return config;
}

/** Exact patterns win outright; among wildcards the longest prefix wins. */
function findBestPathPattern(specifier: string, paths: ts.MapLike<string[]>): MatchedPattern | undefined {
    let best: MatchedPattern | undefined;
    let bestPrefixLength = -1;

    for (const pattern in paths) {
        const star = pattern.indexOf("*");

        if (star === -1) {
            if (pattern === specifier) {
                return { substitutions: paths[pattern], matchedStar: "" };
            }
            continue;
        }

        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);

        if (
            specifier.length >= prefix.length + suffix.length &&
            specifier.startsWith(prefix) &&
            specifier.endsWith(suffix) &&
            prefix.length > bestPrefixLength
        ) {
            bestPrefixLength = prefix.length;
            best = {
                substitutions: paths[pattern],
                matchedStar: specifier.slice(prefix.length, specifier.length - suffix.length),
            };
        }
    }

    return best;
}

function resolveViaPathsSubstitution(matched: MatchedPattern, options: ts.CompilerOptions): string | undefined {
    // mirrors ts.getPathsBasePath(): `paths` may be declared without a baseUrl,
    // in which case it anchors on the config that declared it
    const base = options.baseUrl ?? (options as any).pathsBasePath ?? process.cwd();

    for (const substitution of matched.substitutions) {
        const resolved = resolveSourceFile(
            path.resolve(base, substitution.replace("*", matched.matchedStar)));
        if (resolved) { return resolved; }
    }

    return undefined;
}

const isDeclaration = (fileName: string) => /\.d\.[cm]?ts$/.test(fileName);
const isInNodeModules = (fileName: string) => fileName.replace(/\\/g, "/").includes("/node_modules/");

/**
 * Resolve a non-relative import (`@schemas/Player`, `shared/Player`) to a
 * first-party source file through the tsconfig governing `containingFile`.
 * Returns undefined for npm packages, declaration files, and specifiers no
 * alias covers.
 */
export function resolveNonRelativeImport(specifier: string, containingFile: string): string | undefined {
    const config = getConfigFor(containingFile);
    if (!config) { return undefined; }

    const { options } = config;
    const matched = options.paths && findBestPathPattern(specifier, options.paths);

    // no alias hit and no baseUrl: TypeScript could only find this under
    // node_modules, which costs ~130 failed lookups to prove
    if (!matched && !options.baseUrl) { return undefined; }

    const resolved = ts.resolveModuleName(
        specifier, containingFile, options, ts.sys, config.cache).resolvedModule;

    if (resolved) {
        // a deliberate package/typings hit — not ours to parse, and the
        // substitution fallback must not second-guess it
        return (
            resolved.isExternalLibraryImport ||
            isDeclaration(resolved.resolvedFileName) ||
            isInNodeModules(resolved.resolvedFileName)
        ) ? undefined
          : path.resolve(resolved.resolvedFileName);
    }

    // `.mjs` targets are unresolvable by ts.resolveModuleName in every
    // moduleResolution mode, but schema-codegen parses them
    const viaSubstitution = matched && resolveViaPathsSubstitution(matched, options);
    if (viaSubstitution) { return viaSubstitution; }

    if (matched) {
        warnOnce(`unresolved:${specifier}`,
            `schema-codegen: '${specifier}' matches a "paths" alias in ` +
            `${config.configFilePath}, but no source file was found for it — ` +
            `schemas it exports will be missing from the generated output.`);
    }

    return undefined;
}

/** The extension alternatives parseFiles() probes, in order. Pure — no fs. */
export function sourceFileCandidates(fileName: string): string[] {
    if (
        !fileName.endsWith(".ts") &&
        !fileName.endsWith(".js") &&
        !fileName.endsWith(".mjs")
    ) {
        return [`${fileName}.ts`, `${fileName}/index.ts`];

    } else if (fileName.endsWith(".js")) {
        // ESM imports often spell a .ts source with a .js extension
        return [fileName, fileName.replace(/\.js$/, ".ts")];

    } else {
        return [fileName];
    }
}

/** Same probing as parseFiles(), answering "which candidate exists?". */
export function resolveSourceFile(fileName: string): string | undefined {
    const candidates = sourceFileCandidates(fileName);

    for (let i = 0; i < candidates.length; i++) {
        const candidate = path.resolve(candidates[i]);
        try {
            // statSync, not existsSync: a directory must fall through to the
            // next candidate, the way readFileSync's EISDIR does
            if (fs.statSync(candidate).isFile()) { return candidate; }
        } catch (e) {
            if (!(e as any)?.code) { throw e; }
        }
    }

    return undefined;
}

/**
 * The serializer's own source declares wire-internal schemas (`Reflection`,
 * `ReflectionField`, …) that must never reach generated client code.
 */
export function isOwnPackageSource(fileName: string): boolean {
    const relative = path.relative(PACKAGE_ROOT, fileName);
    return (
        !relative.startsWith("..") &&
        !path.isAbsolute(relative) &&
        (relative.startsWith(`src${path.sep}`) || relative.startsWith(`build${path.sep}`))
    );
}
