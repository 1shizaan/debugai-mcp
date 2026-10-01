/**
 * What the editor can SEE about this workspace, sent as facts the engine reads.
 *
 * ## The hole this fills
 *
 * Every wrong answer in the 2026-09-10 production read needed one fact that is
 * not in the traceback and never can be, because it is a property of the
 * machine rather than of the error:
 *
 *     No module named 'ip_connection_monitor'  ->  "pip install ip_connection_monitor"
 *          the fact:  that name is a .py file sitting in their own project
 *
 *     No module named 'numpy'  x3, one user, three days  ->  "pip install numpy"
 *          the fact:  numpy was installed the whole time, under another interpreter
 *
 *     import Flask, jsonify, ...  ->  "pip install Flask"
 *          the fact:  flask is declared in their own requirements.txt
 *
 * The engine is server-side and will never touch a user's disk. The extension
 * is already ON that disk — and has been reading `package.json`,
 * `requirements.txt` and `pyproject.toml` since v2.1, at
 * `detectWorkspaceFramework()`, purely to guess a one-word framework label. It
 * has been reading the right files for the smallest possible purpose.
 *
 * Nothing here executes anything. Every field is a file read or a read-only
 * VS Code API call, which is what an editor extension already is, so there is
 * no new permission, no consent prompt and no new execution path. Running a
 * command is a separate decision with a separate threat model (see the note on
 * Tier 2 at the bottom) and deliberately not this module.
 *
 * ## The one law: observations, never classifications
 *
 * This module reports what is on disk. It never concludes what it means.
 * "`ip_connection_monitor` is one of your files" and "install it" are both
 * decisions, and decisions live in the engine — beside the error pattern that
 * raised the question, in one place, where they already are.
 *
 * That is not style. It is the same law as Critical Rule 10 (the waitlist never
 * trusts a client-computed privilege field) and the attribution rule (the client
 * reports src and referrer, the SERVER computes `medium`). Applied here it also
 * buys something concrete: the name normalisation that decides whether
 * `python-dotenv` matches `python_dotenv` exists in exactly one file, so there
 * is no cross-boundary copy to drift and no parity test to keep (Rule 15b).
 *
 * ## The other law: a capped list cannot prove an absence
 *
 * `local_modules` and `declared_deps` are capped, because a monorepo has
 * thousands of files and this rides on a request a user is waiting for. A cap
 * is the difference between "numpy is not one of your files" and "numpy is not
 * in the first 600 of your files", and answering the first when you only know
 * the second is how a confident wrong answer gets built.
 *
 * So every list that might be short names itself in `incomplete`, and the
 * engine may draw a POSITIVE conclusion from any list (the name is there, so it
 * exists) but a NEGATIVE one only from a list that is not listed there. Same
 * judgement as MIN_SAMPLE in scanFindings and MIN_COHORT in attribution: an
 * instrument that cannot say "I do not know" will say something false instead.
 *
 * Pure: no `vscode` import, no I/O. The caller supplies the file contents and
 * the directory listings, which is what makes the whole thing testable with no
 * editor — same split as `scanCandidates.ts` and `errorPaths.ts`.
 *
 * ## MIRRORED, byte for byte, in two other places
 *
 *     packages/mcp/src/workspaceFacts.ts          (published to npm, standalone)
 *     apps/extension/src/mcp/workspaceFacts.ts    (bundled MCP server)
 *
 * This file has ZERO imports, which is what makes a byte-identical copy the
 * whole of the solution rather than the start of a divergence. `npm publish`
 * cannot reach into `apps/`, so the copies are not optional (Rule 15b).
 *
 * Do not edit a copy. Edit THIS file and re-copy:
 *
 *     cp apps/extension/src/workspaceFacts.ts packages/mcp/src/workspaceFacts.ts
 *     cp apps/extension/src/workspaceFacts.ts apps/extension/src/mcp/workspaceFacts.ts
 *
 * `mcp/drift.test.ts` compares all three as text and fails on any difference,
 * headers included - deliberately stricter than the other mirrored modules,
 * because this one has no import line to anchor a partial comparison to.
 */

/** A list whose absence-of-a-name means nothing. See the module docstring. */
export type IncompleteList = 'declared_deps' | 'local_modules';

export interface WorkspaceFacts {
    /**
     * Dependency names exactly as the manifests spell them — `python-dotenv`,
     * `@babel/core`, `Flask`. NOT normalised: normalising is comparing, and
     * comparing is the engine's job (see the law above).
     */
    declared_deps: string[];
    /**
     * Version as the manifest SPELLS it, keyed by the same raw name:
     * `{"Yarp.ReverseProxy": "2.3.0", "react": "^18.2.0", "flask": ">=3"}`.
     *
     * Not resolved, and that is the point. `2.3.0` is a fact about what is
     * installed; `^18.2.0` is a fact about what is ALLOWED, and the difference
     * is information the engine needs - on 2026-09-12 we told a user to call
     * `.AddPassiveHealthCheckPolicies()` on YARP at confidence 92 and the
     * method does not exist in the 2.3.0 their own .csproj declares. An exact
     * pin can settle that question; a range cannot, and the engine must be able
     * to tell which one it has.
     *
     * A name declared in two manifests with two versions keeps the first seen.
     * The alternative is a list per name, which costs the whole shape for a
     * case (one package, two versions, one workspace) that is itself a bug.
     */
    declared_versions: Record<string, string>;
    /**
     * Which manifest files those names came from, relative to the root. Load
     * bearing: an empty `declared_deps` means "declares nothing" when a
     * manifest was read and "we found no manifest" when this is empty, and
     * those support opposite conclusions.
     */
    manifests: string[];
    /**
     * Every name in this workspace that Python could import as a top-level
     * module: `foo.py` -> `foo`, `foo/__init__.py` -> `foo`. Deduped across
     * directories, because `sys.path[0]` is the running script's own directory
     * and a sibling module is importable from there without being at the root.
     */
    local_modules: string[];
    /** Root directories that look like a virtualenv: `.venv`, `venv`, `env`. */
    venv_dirs: string[];
    /** A `node_modules` directory exists at the workspace root. */
    has_node_modules: boolean;
    /**
     * The interpreter VS Code currently has selected, from the Python
     * extension's read-only environments API. `null` when the Python extension
     * is not installed, not activated, or has no selection — three states that
     * mean "we do not know", never "there isn't one".
     */
    python_interpreter: string | null;
    /** Lists that may be missing entries. Absence from one of these proves nothing. */
    incomplete: IncompleteList[];
}

/**
 * Caps. Chosen so an ordinary project is never truncated and a monorepo is
 * truncated honestly rather than slowly. `findFiles` is given `cap + 1` so the
 * overflow is detected exactly rather than guessed at the boundary.
 */
export const MAX_DECLARED_DEPS = 400;
/** Versions are only kept for names that survived the dep cap. */
export const MAX_VERSION_LENGTH = 60;
export const MAX_LOCAL_MODULES = 600;

/** Directory names at the root that mean "a Python environment lives here". */
const VENV_DIR_NAMES = ['.venv', 'venv', 'env', '.virtualenv'];

/**
 * Everything a dependency name cannot be. Guards against a manifest that parses
 * into rubbish rather than failing: a 4KB line in `requirements.txt` is not a
 * package name, and shipping it would waste the budget it was meant to save.
 */
const MAX_DEP_NAME_LENGTH = 100;

function usableName(name: string): boolean {
    const n = name.trim();
    return n.length > 0 && n.length <= MAX_DEP_NAME_LENGTH;
}

/**
 * A version string worth reporting.
 *
 * Deliberately permissive about FORM - `2.3.0`, `^18.2.0`, `>=3,<4`, `1.0.0-rc.2`
 * and `*` are all real and all informative. It rejects only what cannot be a
 * version: empty, absurdly long, or carrying a newline (which would mean the
 * parse went wrong rather than that the version is unusual).
 *
 * A workspace path is never a version, and `file:../local-pkg` is how npm
 * spells a local dependency - reported as-is, because "this dependency is a
 * path on their disk, not a registry package" is exactly the kind of fact the
 * engine cannot otherwise know.
 */
function usableVersion(v: unknown): v is string {
    if (typeof v !== 'string') { return false; }
    const t = v.trim();
    return t.length > 0 && t.length <= MAX_VERSION_LENGTH && !/[\r\n]/.test(t);
}

/** First write wins, so a later manifest cannot silently overwrite an earlier one. */
function putVersion(into: Record<string, string>, name: string, version: unknown): void {
    const n = (name || '').trim();
    if (!usableName(n) || n in into) { return; }
    if (!usableVersion(version)) { return; }
    into[n] = version.trim();
}

/**
 * Merge one manifest's versions into the accumulator, first-write-wins.
 *
 * NOT `Object.assign`, which overwrites and made the last manifest read win -
 * the exact opposite of the documented contract, and caught by the test that
 * declares the same name in a package.json and a .csproj. `putVersion` already
 * refuses to overwrite; the merge has to go through it to inherit that.
 */
function mergeVersions(into: Record<string, string>, from: Record<string, string>): void {
    for (const [name, version] of Object.entries(from)) { putVersion(into, name, version); }
}

/**
 * Dependency names declared in a `package.json`, across all four dependency
 * fields.
 *
 * `peerDependencies` and `optionalDependencies` are included on purpose: a
 * `Cannot find module` for a peer dep is a real and common shape (the package
 * is declared, expects you to install it, and nothing did), and leaving them
 * out would make the engine conclude "not declared" about a name that is.
 *
 * Never throws. A malformed `package.json` is itself a plausible thing to be
 * debugging, and losing the whole fact set to it would be absurd.
 */
export function depsFromPackageJson(text: string): string[] {
    let pkg: any;
    try {
        pkg = JSON.parse(text);
    } catch {
        return [];
    }
    if (!pkg || typeof pkg !== 'object') { return []; }
    const out: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const block = pkg[field];
        if (block && typeof block === 'object' && !Array.isArray(block)) {
            for (const name of Object.keys(block)) {
                if (usableName(name)) { out.push(name.trim()); }
            }
        }
    }
    return out;
}

/**
 * Package names from a `requirements.txt`.
 *
 * A requirements line carries far more than a name — version specifiers,
 * extras, environment markers, hashes, editable installs, includes, direct
 * URLs — and every one of those forms appears in real projects. The name is
 * whatever survives stripping them, and a line with no name left (a bare `-r
 * base.txt`, a comment, a flag) contributes nothing rather than contributing
 * garbage.
 *
 * `-r other.txt` is NOT followed. Following it would need another file read
 * driven by content we just parsed, and the honest alternative is cheaper: the
 * caller marks `declared_deps` incomplete, so a name missing from the list
 * proves nothing, which is exactly the truth about a split requirements file.
 */
export function depsFromRequirements(text: string): { deps: string[]; sawInclude: boolean } {
    const deps: string[] = [];
    let sawInclude = false;

    for (const rawLine of (text || '').split(/\r?\n/)) {
        // A `#` starts a comment anywhere it is not inside a URL fragment. The
        // fragment case matters: `...#egg=name` is how an editable VCS install
        // names its package, and cutting there loses the only name on the line.
        let line = rawLine.trim();
        if (!line || line.startsWith('#')) { continue; }

        // `-e .`, `--editable`, `-r base.txt`, `--index-url ...`, `--hash=...`
        if (line.startsWith('-')) {
            if (/^(-r|--requirement|-c|--constraint)\b/.test(line)) { sawInclude = true; continue; }
            if (!/^(-e|--editable)\b/.test(line)) { continue; }
            line = line.replace(/^(-e|--editable)\s+/, '');
        }

        // `git+https://host/x@ref#egg=NAME` — the egg fragment IS the name.
        const egg = line.match(/[#&]egg=([A-Za-z0-9._-]+)/);
        if (egg) {
            if (usableName(egg[1])) { deps.push(egg[1]); }
            continue;
        }

        // A bare path or URL with no egg fragment names nothing we can use.
        if (/^[./~]/.test(line) || /^[a-z][a-z0-9+.-]*:\/\//i.test(line)) { continue; }

        // Strip the trailing comment, then everything that is not the name:
        // extras `[a,b]`, markers `; python_version < "3.9"`, specifiers, and
        // a direct reference `name @ url`.
        line = line.split(/\s+#/)[0];
        line = line.split(';')[0];
        line = line.split('@')[0];
        const name = line.split(/[[<>=!~ ,(]/)[0].trim();
        if (usableName(name) && /^[A-Za-z0-9._-]+$/.test(name)) { deps.push(name); }
    }

    return { deps, sawInclude };
}

/** One dependency a pyproject declares: its name, and the version text beside it or ''. */
interface PyDecl { name: string; spec: string; }

/** A TOML value, read far enough to know what it holds and where it stops. */
interface TomlValue {
    kind: 'array' | 'table' | 'string' | 'other';
    /** The strings directly inside an array, or the one string of a string value. */
    strings: string[];
    /** The value as written. */
    raw: string;
    /** Index of the line end the value stops at. */
    end: number;
    /** False when a string or a bracket was still open where the value stopped. */
    closed: boolean;
}

function lineEnd(src: string, i: number): number {
    const n = src.indexOf('\n', i);
    return n < 0 ? src.length : n;
}

/**
 * The quoted TOML string that starts at `i`: its text as written, and where it
 * ends. A one-line string that reaches the end of its line unclosed stops
 * there, so a stray quote costs one value and not the rest of the file.
 */
function readTomlString(src: string, i: number): { text: string; end: number; closed: boolean } {
    const q = src[i];
    const escapes = q === '"';
    const fence = q + q + q;
    const multiline = src.startsWith(fence, i);
    let j = i + (multiline ? 3 : 1);
    const from = j;
    while (j < src.length) {
        if (multiline ? src.startsWith(fence, j) : (src[j] === q || src[j] === '\n')) { break; }
        j += escapes && src[j] === '\\' ? 2 : 1;
    }
    j = Math.min(j, src.length);
    const closed = j < src.length && src[j] !== '\n';
    return { text: src.slice(from, j), end: closed ? j + (multiline ? 3 : 1) : j, closed };
}

/**
 * A dotted TOML key (`project`, `tool.poetry.dependencies`, `"ruamel.yaml"`)
 * up to the character that ends it: `=` for a key, `]` for a table header.
 * A quoted segment keeps its dots, because it is one name.
 */
function readTomlKey(src: string, start: number, stop: string): { segs: string[]; end: number } | null {
    const segs: string[] = [];
    let i = start;
    for (;;) {
        while (src[i] === ' ' || src[i] === '\t') { i++; }
        if (src[i] === '"' || src[i] === "'") {
            const s = readTomlString(src, i);
            if (!s.closed) { return null; }
            segs.push(s.text);
            i = s.end;
        } else {
            let j = i;
            while (j < src.length && /[A-Za-z0-9_-]/.test(src[j])) { j++; }
            if (j === i) { return null; }
            segs.push(src.slice(i, j));
            i = j;
        }
        while (src[i] === ' ' || src[i] === '\t') { i++; }
        if (src[i] === '.') { i++; continue; }
        return src[i] === stop ? { segs, end: i + 1 } : null;
    }
}

/**
 * The value that starts at `start`, across as many lines as its brackets span.
 *
 * Quotes are what this exists for. `"uvicorn[standard]>=0.23"` has a `]` in it,
 * and a reader that takes the first `]` as the end of the array stops there and
 * loses every dependency listed after it.
 */
function readTomlValue(src: string, start: number): TomlValue {
    let i = start;
    while (src[i] === ' ' || src[i] === '\t') { i++; }
    const from = i;
    const first = src[i];
    const kind = first === '[' ? 'array' : first === '{' ? 'table'
        : (first === '"' || first === "'") ? 'string' : 'other';
    const strings: string[] = [];
    let depth = 0;
    let closed = true;
    while (i < src.length) {
        const c = src[i];
        if (c === '"' || c === "'") {
            const s = readTomlString(src, i);
            if (!s.closed) { closed = false; }
            if ((kind === 'array' && depth === 1) || (kind === 'string' && depth === 0)) { strings.push(s.text); }
            i = s.end;
        } else if (c === '#') {
            i = lineEnd(src, i);
        } else if (c === '\n') {
            if (depth <= 0) { break; }
            i++;
        } else {
            if (c === '[' || c === '{') { depth++; }
            if (c === ']' || c === '}') { depth--; }
            i++;
        }
    }
    if (depth !== 0) { closed = false; }
    return { kind, strings, raw: src.slice(from, i), end: i, closed };
}

/**
 * Name and version out of one requirement string, `uvicorn[standard]>=0.23; ...`.
 * The extras and the environment marker are dropped. `name @ url` pins a URL,
 * not a version, so it keeps the name alone.
 */
function declFromRequirement(req: string): PyDecl | null {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;]*)/.exec(req || '');
    if (!m) { return null; }
    const spec = m[2].trim().replace(/^\((.*)\)$/, '$1').trim();
    return { name: m[1], spec: /^[=<>!~^]/.test(spec) ? spec : '' };
}

/**
 * Where a poetry dependency's name sits in a key path, or -1.
 *
 *     tool.poetry.dependencies.<name>
 *     tool.poetry.dev-dependencies.<name>           (poetry before 1.2)
 *     tool.poetry.group.<group>.dependencies.<name>
 */
function poetryNameAt(path: string[]): number {
    if (path[0] !== 'tool' || path[1] !== 'poetry') { return -1; }
    if (path[2] === 'dependencies' || path[2] === 'dev-dependencies') { return 3; }
    if (path[2] === 'group' && path[4] === 'dependencies') { return 5; }
    return -1;
}

/**
 * What a `pyproject.toml` declares, read table by table.
 *
 * Not a TOML parser: it reads table headers, keys, strings and brackets, which
 * is what it takes to know WHICH table an array is in and where it ends. The
 * first version matched every `key = [...]` in the file and ended each at the
 * first `]`. Measured on 48 real projects (fastapi, flask, django, pandas,
 * poetry, sentry and others) against a real TOML parser, that reported 3,700
 * names that are not dependencies (`tests` from pytest's `testpaths`, `src`
 * from setuptools' `packages`, an author's first name, every ruff rule code)
 * beside 1,687 that are, and lost 675 real ones, in 19 files of 21 without
 * saying so. The engine answered `No module named 'tests'` with "`tests` is
 * already declared as a dependency in pyproject.toml" at confidence 92.
 *
 * `[build-system] requires` is not read. Those are installed into the build's
 * own environment, so `pip install -e .` does not put them where an import
 * looks for them, and "declared, so install the project" would be wrong.
 */
function readPyproject(text: string): { decls: PyDecl[]; found: boolean; partial: boolean } {
    const src = text || '';
    const decls: PyDecl[] = [];
    let found = false;
    let partial = false;
    let table: string[] = [];

    const requirements = (v: TomlValue): void => {
        // Anything but a whole array is a declaration this did not read.
        if (v.kind !== 'array' || !v.closed) { partial = true; }
        if (v.kind !== 'array') { return; }
        for (const s of v.strings) {
            const d = declFromRequirement(s);
            if (d) { decls.push(d); }
        }
    };

    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
        if (c === '#') { i = lineEnd(src, i); continue; }
        if (c === '[') {
            const head = readTomlKey(src, src[i + 1] === '[' ? i + 2 : i + 1, ']');
            // A header that cannot be read owns its keys all the same, or they
            // would be filed under the table before it.
            table = head ? head.segs : ['?'];
            i = lineEnd(src, i);
            continue;
        }
        const key = readTomlKey(src, i, '=');
        if (!key) { i = lineEnd(src, i); continue; }
        const value = readTomlValue(src, key.end);
        i = value.end;

        const p = table.concat(key.segs);
        const n = p.length;
        if (p[0] === 'project') {
            // PEP 621. A [project] table with no `dependencies` key declares
            // none, unless it says they are computed elsewhere (`dynamic`).
            found = true;
            if (n === 2 && p[1] === 'dependencies') { requirements(value); }
            else if (n === 3 && p[1] === 'optional-dependencies') { requirements(value); }
            else if (n === 2 && p[1] === 'optional-dependencies') { partial = true; }
            else if (n === 2 && p[1] === 'dynamic'
                && value.strings.some(s => s === 'dependencies' || s === 'optional-dependencies')) { partial = true; }
        } else if (p[0] === 'dependency-groups' && n === 2) {
            requirements(value);                              // PEP 735
        } else if (p[0] === 'tool' && (p[1] === 'uv' || p[1] === 'rye') && n === 3 && p[2] === 'dev-dependencies') {
            requirements(value);
        } else if (p[0] === 'tool' && p[1] === 'pdm' && n === 4 && p[2] === 'dev-dependencies') {
            requirements(value);
        } else if (p[0] === 'tool' && p[1] === 'hatch' && p[2] === 'envs' && n === 5
            && (p[4] === 'dependencies' || p[4] === 'extra-dependencies')) {
            requirements(value);
        } else {
            const at = poetryNameAt(p);
            if (at < 0 || n <= at) { continue; }
            found = true;
            const name = p[at];
            // `python = "^3.11"` is the interpreter constraint, not a dependency.
            if (name.toLowerCase() === 'python' || !/^[A-Za-z0-9._-]+$/.test(name)) { continue; }
            let spec = '';
            if (n === at + 1 && value.kind === 'string') {
                spec = value.strings[0] || '';                // flask = "^3.0"
            } else if (n === at + 1 && value.kind === 'table') {
                const v = /\bversion\s*=\s*["']([^"']+)["']/.exec(value.raw);
                spec = v ? v[1] : '';                         // flask = { version = "^3.0", extras = [...] }
            } else if (n === at + 2 && p[at + 1] === 'version' && value.kind === 'string') {
                spec = value.strings[0] || '';                // [tool.poetry.dependencies.flask]
            }
            decls.push({ name, spec });
        }
    }
    return { decls, found, partial };
}

/**
 * Package names from a `pyproject.toml`, without a TOML parser.
 *
 * Bundling one would be the honest engineering answer if the file had to be
 * understood whole. It does not: `readPyproject` reads the tables that declare
 * dependencies and says when it could not, and that buys out a dependency in a
 * bundle that ships to every install.
 *
 *     [project]                            PEP 621, the modern default
 *     dependencies = ["flask>=3", "python-dotenv"]
 *     [project.optional-dependencies]      every group
 *     [dependency-groups]                  PEP 735, every group
 *     [tool.poetry.dependencies]           poetry, and its groups
 *     tool.uv / tool.rye / tool.pdm dev-dependencies, tool.hatch.envs.*
 *
 * Two ways the list can be short, and the caller marks `declared_deps`
 * incomplete on either, because a name missing from a short list proves
 * nothing:
 *
 * `found` is false when the file has neither a `[project]` table nor a poetry
 * dependency table: a setuptools project that declares in `setup.py`, flit's
 * own metadata, a file of tool settings. The caller needs that to be a
 * different state from "no pyproject at all", because one means "we could not
 * read the declarations" and the other means "there are none to read".
 *
 * `partial` is true when a declaration was there and not read whole:
 * `dynamic = ["dependencies"]` (they are computed at build time), an array
 * that never closes, groups written as one inline table.
 */
export function depsFromPyproject(text: string): { deps: string[]; found: boolean; partial: boolean } {
    const { decls, found, partial } = readPyproject(text);
    return { deps: decls.map(d => d.name).filter(usableName), found, partial };
}

/**
 * Versions from a `package.json`, keyed by dependency name.
 *
 * A SEPARATE pass rather than a change to `depsFromPackageJson`, on purpose.
 * That function's contract and its tests are shipped and correct; widening a
 * return type to carry a new field is how a working parser acquires a
 * regression. These files are small and already capped, so the second pass
 * costs nothing measurable.
 */
export function versionsFromPackageJson(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    let pkg: any;
    try {
        pkg = JSON.parse(text);
    } catch {
        return out;
    }
    if (!pkg || typeof pkg !== 'object') { return out; }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const block = pkg[field];
        if (block && typeof block === 'object' && !Array.isArray(block)) {
            for (const [name, version] of Object.entries(block)) {
                putVersion(out, name, version);
            }
        }
    }
    return out;
}

/**
 * Versions from a `requirements.txt`, keyed by package name.
 *
 * Keeps the whole specifier as written - `==3.0.0`, `>=2,<3`, `~=1.4` - because
 * `==` is a fact about what IS installed and `>=` is a fact about what is
 * allowed, and collapsing them would throw away the distinction the engine
 * needs most.
 *
 * A line with no specifier contributes a NAME (via `depsFromRequirements`) and
 * no version, which is honest: `flask` on its own line pins nothing.
 *
 * Never reads an `--index-url`. Those carry credentials in real projects
 * (`https://user:token@pypi.internal/simple`) and a package's version is never
 * on that line anyway.
 */
export function versionsFromRequirements(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rawLine of (text || '').split(/\r?\n/)) {
        let line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('-')) { continue; }
        if (/^[./~]/.test(line) || /^[a-z][a-z0-9+.-]*:\/\//i.test(line)) { continue; }
        line = line.split(/\s+#/)[0];
        line = line.split(';')[0];
        // `flask==3.0.0 \` then `--hash=sha256:...` is what pip-compile and
        // `poetry export` write. The option and the line continuation are not
        // part of the version: with the backslash left on, an exact pin reached
        // the engine as `==3.0.0 \`, which it reads as a range.
        line = line.split(/\s+--/)[0].replace(/\s*\\$/, '');
        if (line.includes('@')) { continue; }   // `name @ url` pins a URL, not a version
        const m = line.match(/^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(.+)$/);
        if (!m) { continue; }
        const spec = m[2].trim();
        if (/^[=<>!~^]/.test(spec)) { putVersion(out, m[1], spec); }
    }
    return out;
}

/**
 * Versions from a `pyproject.toml`, keyed by package name.
 *
 * The same tables `depsFromPyproject` reads, through the same reader, so the
 * two cannot disagree about what is declared. A version this finds is real,
 * and one it misses simply is not reported: a missing VERSION is never read as
 * "no version constraint", only as "we did not see one".
 */
export function versionsFromPyproject(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of readPyproject(text).decls) {
        if (d.spec) { putVersion(out, d.name, d.spec); }
    }
    return out;
}

/**
 * Package names and versions from a .NET project file (`.csproj` / `.fsproj`).
 *
 * The manifest that would have prevented 2026-09-12. Four consecutive answers
 * guessed at `Elastic.Clients.Elasticsearch` constructor signatures and a fifth
 * invented `.AddPassiveHealthCheckPolicies()` on YARP - while the user's own
 * project file said `Version="2.3.0"` the entire time, and their error text
 * even quoted it back to us.
 *
 * .NET pins are usually EXACT, which makes this the highest-value manifest in
 * the set: `<PackageReference Include="X" Version="2.3.0" />` settles "does
 * this method exist" in a way `^18.2.0` never can.
 *
 * Two spellings, both common and both emitted by `dotnet add package`:
 *
 *     <PackageReference Include="X" Version="2.3.0" />
 *     <PackageReference Include="X"><Version>2.3.0</Version></PackageReference>
 *
 * Regex rather than an XML parser, for the same reason `depsFromPyproject`
 * avoids a TOML parser: a name this finds is real, a name it misses is covered
 * by `incomplete`, and neither justifies a dependency in a bundle that ships to
 * every install. Attribute order is not assumed - `Version` before `Include`
 * is legal and real.
 */
export function depsFromCsproj(text: string): { deps: string[]; versions: Record<string, string> } {
    const deps: string[] = [];
    const versions: Record<string, string> = {};
    const src = text || '';

    const refRe = /<PackageReference\b([^>]*?)(\/>|>([\s\S]*?)<\/PackageReference\s*>)/gi;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(src)) !== null) {
        const attrs = m[1] || '';
        const body = m[3] || '';
        const nameM = attrs.match(/\bInclude\s*=\s*"([^"]+)"/i)
                   || attrs.match(/\bUpdate\s*=\s*"([^"]+)"/i);
        if (!nameM) { continue; }
        const name = nameM[1].trim();
        if (!usableName(name)) { continue; }
        deps.push(name);

        const attrV = attrs.match(/\bVersion\s*=\s*"([^"]+)"/i);
        const bodyV = body.match(/<Version\s*>([^<]+)<\/Version\s*>/i);
        const raw = attrV ? attrV[1] : (bodyV ? bodyV[1] : undefined);
        // `$(SomeProperty)` is an unexpanded MSBuild variable, not a version.
        // Reporting it would be reporting a string we cannot resolve as if it
        // were a fact, which is the failure mode this whole module exists for.
        if (raw && !/^\s*\$\(/.test(raw)) { putVersion(versions, name, raw.trim()); }
    }
    return { deps, versions };
}

/**
 * The top-level module name a Python file would be imported by, or null.
 *
 * `a/b/foo.py` -> `foo`, `a/b/foo/__init__.py` -> `foo`. A dunder file other
 * than `__init__` (`__main__.py`, `__about__.py`) names no importable module
 * and is dropped, so it cannot be mistaken for one.
 */
export function moduleNameForPath(relPath: string): string | null {
    const parts = (relPath || '').split(/[\\/]/).filter(Boolean);
    if (parts.length === 0) { return null; }
    const file = parts[parts.length - 1];
    if (!file.endsWith('.py')) { return null; }
    const stem = file.slice(0, -3);
    if (stem === '__init__') {
        const dir = parts.length >= 2 ? parts[parts.length - 2] : '';
        return dir && !dir.startsWith('.') ? dir : null;
    }
    if (stem.startsWith('__') || !stem) { return null; }
    return stem;
}

/** Raw inputs, exactly as the editor hands them over. Every field optional. */
export interface FactInputs {
    packageJson?: string | null;
    requirementsTxt?: string | null;
    pyprojectToml?: string | null;
    /**
     * Contents of every .NET project file found, newest-irrelevant order. A
     * list because a solution has one per project and the error can come from
     * any of them - salman's repo had six.
     */
    csprojFiles?: string[];
    /** True when the caller stopped looking for .csproj files before exhausting them. */
    csprojTruncated?: boolean;
    /** Workspace-relative paths of every `.py` file the caller found. */
    pythonFiles?: string[];
    /** True when the caller's file search hit its own limit. */
    pythonFilesTruncated?: boolean;
    /** Root directory names the caller saw. */
    rootDirs?: string[];
    /** From the Python extension's environments API. */
    pythonInterpreter?: string | null;
}

function dedupeSorted(names: string[]): string[] {
    return Array.from(new Set(names)).sort();
}

/**
 * Assemble the facts. Total function: any subset of inputs, no throw.
 *
 * Every list is deduped and sorted before capping, so what survives a cap is
 * stable across requests rather than dependent on filesystem walk order — a
 * cache key reads this, and a set that reshuffles per request would miss the
 * cache every time on exactly the large workspaces where a miss costs most.
 */
export function buildWorkspaceFacts(input: FactInputs): WorkspaceFacts {
    const incomplete = new Set<IncompleteList>();
    const manifests: string[] = [];
    const declared: string[] = [];
    const versions: Record<string, string> = {};

    if (typeof input.packageJson === 'string') {
        manifests.push('package.json');
        declared.push(...depsFromPackageJson(input.packageJson));
        mergeVersions(versions, versionsFromPackageJson(input.packageJson));
    }
    if (typeof input.requirementsTxt === 'string') {
        manifests.push('requirements.txt');
        const { deps, sawInclude } = depsFromRequirements(input.requirementsTxt);
        declared.push(...deps);
        mergeVersions(versions, versionsFromRequirements(input.requirementsTxt));
        // `-r base.txt` means the real list continues in a file we did not read.
        if (sawInclude) { incomplete.add('declared_deps'); }
    }
    if (typeof input.pyprojectToml === 'string') {
        manifests.push('pyproject.toml');
        const { deps, found, partial } = depsFromPyproject(input.pyprojectToml);
        declared.push(...deps);
        mergeVersions(versions, versionsFromPyproject(input.pyprojectToml));
        // The file is there and we could not find its declarations, or found
        // them and could not read them whole. Saying nothing here would let
        // the engine read our silence as "declares nothing", which is the one
        // reading that is certainly wrong.
        if (!found || partial) { incomplete.add('declared_deps'); }
    }

    if (Array.isArray(input.csprojFiles) && input.csprojFiles.length > 0) {
        manifests.push('*.csproj');
        for (const text of input.csprojFiles) {
            if (typeof text !== 'string') { continue; }
            const { deps, versions: v } = depsFromCsproj(text);
            declared.push(...deps);
            mergeVersions(versions, v);
        }
        // A solution whose project files we stopped enumerating declares more
        // than we can see, and a name missing from a short list proves nothing.
        if (input.csprojTruncated) { incomplete.add('declared_deps'); }
    }

    const declaredSorted = dedupeSorted(declared);
    if (declaredSorted.length > MAX_DECLARED_DEPS) { incomplete.add('declared_deps'); }

    const modules = dedupeSorted(
        (input.pythonFiles || [])
            .map(moduleNameForPath)
            .filter((n): n is string => n !== null)
    );
    if (input.pythonFilesTruncated || modules.length > MAX_LOCAL_MODULES) {
        incomplete.add('local_modules');
    }

    const rootDirs = input.rootDirs || [];
    const interpreter = typeof input.pythonInterpreter === 'string' && input.pythonInterpreter.trim()
        ? input.pythonInterpreter.trim().slice(0, 500)
        : null;

    const keptDeps = declaredSorted.slice(0, MAX_DECLARED_DEPS);

    // Versions only for names that survived the cap. A version for a name the
    // engine cannot see is payload with no reader, and it would put the two
    // lists out of step in a way every consumer would have to re-check.
    const keptVersions: Record<string, string> = {};
    for (const name of keptDeps) {
        if (name in versions) { keptVersions[name] = versions[name]; }
    }

    return {
        declared_deps: keptDeps,
        declared_versions: keptVersions,
        manifests,
        local_modules: modules.slice(0, MAX_LOCAL_MODULES),
        venv_dirs: rootDirs.filter(d => VENV_DIR_NAMES.includes(d)),
        has_node_modules: rootDirs.includes('node_modules'),
        python_interpreter: interpreter,
        incomplete: Array.from(incomplete).sort(),
    };
}

/**
 * True when these facts carry nothing the engine could act on.
 *
 * An empty fact set is not neutral: it costs bytes on every request, and — far
 * worse — it takes part in the response cache key, so sending an all-empty
 * object from a window with no folder open would split the cache between
 * "no facts" and "no facts, spelled out" for no gain. Send nothing instead.
 */
export function factsAreEmpty(f: WorkspaceFacts): boolean {
    // `declared_versions` is deliberately absent from this check: a version is
    // only ever kept for a name in `declared_deps`, so a fact set with versions
    // and no deps cannot be built. Adding the clause would be adding a branch
    // no input can reach.
    return (
        f.declared_deps.length === 0 &&
        f.manifests.length === 0 &&
        f.local_modules.length === 0 &&
        f.venv_dirs.length === 0 &&
        !f.has_node_modules &&
        f.python_interpreter === null
    );
}

/**
 * NOT IN THIS MODULE, on purpose: anything that runs.
 *
 * `python -c "import sys; print(sys.executable)"` settles the wrong-interpreter
 * case outright, and `python_interpreter` above only reports what VS Code has
 * SELECTED — which is the right answer for a Run button and not necessarily the
 * interpreter that produced a traceback pasted from an external terminal.
 *
 * Closing that gap means executing something, and the 2026 record of agentic
 * tools is unambiguous about how that goes wrong: every published incident is a
 * variant of one mistake, treating a command STRING as data. Aider ran a
 * repo-supplied `test-cmd` at startup (#5254). Claude Code's allowlist admitted
 * `man --html="touch ..."` (CVE-2025-66032). Cursor's approval dialog showed a
 * workspace path while the write followed a symlink to `~/.ssh/authorized_keys`
 * (CVE-2026-50549).
 *
 * So when Tier 2 lands, the server names a PROBE and its parameters from a
 * catalog this client owns — `{probe: "interpreter"}`, never a command string —
 * the client maps that to argv it wrote itself, and an unknown probe name is
 * refused rather than passed through. That is the difference between MCP
 * elicitation and every incident above, and it is a different module with a
 * consent gate, not a quiet extension of this one.
 */
