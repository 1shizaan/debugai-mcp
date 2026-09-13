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

/**
 * Package names from a `pyproject.toml`, without a TOML parser.
 *
 * Bundling one would be the honest engineering answer if the names had to be
 * exact. They do not: a name that survives this is real (a positive conclusion,
 * always safe), and a name this misses is covered by the caller marking the
 * list incomplete (so no negative conclusion is drawn from it). That trade buys
 * out a dependency in a bundle that ships to 652 installs.
 *
 * Two shapes, which between them cover almost every real file:
 *
 *     [project]                      PEP 621, the modern default
 *     dependencies = ["flask>=3", "python-dotenv"]
 *
 *     [tool.poetry.dependencies]     poetry, still very common
 *     flask = "^3.0"
 *
 * `found` is false when the file exists but neither shape was recognised —
 * pdm, hatch's dynamic metadata, a dependency-groups-only file. The caller
 * needs that to be a different state from "no pyproject at all", because one
 * means "we could not read the declarations" and the other means "there are
 * none to read".
 */
export function depsFromPyproject(text: string): { deps: string[]; found: boolean } {
    const src = text || '';
    const deps: string[] = [];
    let found = false;

    // [project] dependencies = [...] and [project.optional-dependencies] tables.
    // Matched as an array literal rather than by section, because the same
    // array shape is what both spell and a section walk would need a parser.
    const arrayRe = /(?:^|\n)\s*(?:dependencies|[A-Za-z0-9_-]+)\s*=\s*\[([^\]]*)\]/g;
    let m: RegExpExecArray | null;
    while ((m = arrayRe.exec(src)) !== null) {
        const body = m[1];
        const entryRe = /["']\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g;
        let e: RegExpExecArray | null;
        while ((e = entryRe.exec(body)) !== null) {
            if (usableName(e[1])) { deps.push(e[1]); found = true; }
        }
    }

    // [tool.poetry.dependencies] / [tool.poetry.group.*.dependencies]
    const poetryRe = /\[tool\.poetry(?:\.group\.[A-Za-z0-9_-]+)?\.dependencies\]([\s\S]*?)(?=\n\s*\[|$)/g;
    while ((m = poetryRe.exec(src)) !== null) {
        found = true;
        for (const line of m[1].split(/\r?\n/)) {
            const key = line.trim().split('=')[0].trim().replace(/^["']|["']$/g, '');
            // `python = "^3.11"` is the interpreter constraint, not a dependency.
            if (key && key.toLowerCase() !== 'python' && usableName(key) && /^[A-Za-z0-9._-]+$/.test(key)) {
                deps.push(key);
            }
        }
    }

    return { deps, found };
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
 * Same two shapes `depsFromPyproject` recognises, and the same trade: a version
 * this finds is real, and one it misses simply is not reported. `declared_deps`
 * already carries `incomplete` for the negative case, and a missing VERSION is
 * never read as "no version constraint" - only as "we did not see one".
 */
export function versionsFromPyproject(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    const src = text || '';

    // PEP 621: dependencies = ["flask>=3", "python-dotenv==1.0.0"]
    const arrayRe = /(?:^|\n)\s*(?:dependencies|[A-Za-z0-9_-]+)\s*=\s*\[([^\]]*)\]/g;
    let m: RegExpExecArray | null;
    while ((m = arrayRe.exec(src)) !== null) {
        const entryRe = /["']\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^"']*)["']/g;
        let e: RegExpExecArray | null;
        while ((e = entryRe.exec(m[1])) !== null) {
            const spec = (e[2] || '').split(';')[0].trim();
            if (/^[=<>!~^]/.test(spec)) { putVersion(out, e[1], spec); }
        }
    }

    // poetry: flask = "^3.0"  ·  flask = { version = "^3.0", extras = [...] }
    const poetryRe = /\[tool\.poetry(?:\.group\.[A-Za-z0-9_-]+)?\.dependencies\]([\s\S]*?)(?=\n\s*\[|$)/g;
    while ((m = poetryRe.exec(src)) !== null) {
        for (const line of m[1].split(/\r?\n/)) {
            const eq = line.indexOf('=');
            if (eq < 0) { continue; }
            const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
            if (!key || key.toLowerCase() === 'python') { continue; }
            const rest = line.slice(eq + 1).trim();
            const inline = rest.match(/^\{[^}]*version\s*=\s*["']([^"']+)["']/);
            const plain = rest.match(/^["']([^"']+)["']/);
            putVersion(out, key, inline ? inline[1] : (plain ? plain[1] : undefined));
        }
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
        const { deps, found } = depsFromPyproject(input.pyprojectToml);
        declared.push(...deps);
        mergeVersions(versions, versionsFromPyproject(input.pyprojectToml));
        // The file is there and we could not find its declarations. Saying
        // nothing here would let the engine read our silence as "declares
        // nothing", which is the one reading that is certainly wrong.
        if (!found) { incomplete.add('declared_deps'); }
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
