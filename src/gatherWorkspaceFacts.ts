/**
 * Read this project's manifests off disk, so the engine stops guessing.
 *
 * ## The hole
 *
 * `workspaceFacts.ts` (pure, beside this file) has existed since 2026-09-10 and
 * answers the question every wrong diagnosis needed: what is actually on this
 * machine. It runs in the VS Code extension only. It has never run here.
 *
 * A read of 76 production `debug_feedback.actual_fix` rows on 2026-09-13 put
 * numbers on that: the largest single class of wrong answer, 24%, needed a fact
 * about the MACHINE rather than about the error - an interpreter, a declared
 * dependency, an installed version. And 54 of the last 83 debugs arrived over
 * MCP, where none of those facts are sent.
 *
 * The clearest case is one line of one file on 2026-09-12. Four consecutive
 * answers guessed at `Elastic.Clients.Elasticsearch` constructor signatures and
 * a fifth invented `.AddPassiveHealthCheckPolicies()` on YARP, at confidence 92,
 * while the user's own `.csproj` said `Version="2.3.0"` the whole time - and
 * this process was running inside that repository.
 *
 * ## Why the server reads them rather than asking the agent
 *
 * Same reason `sourceContext.ts` reads the files a trace names: this is a local
 * process with the filesystem the engine lacks, and an agent that has to be
 * asked for something will be asked differently by every client. Reading costs
 * one bounded walk; asking costs a contract with every MCP host there is.
 *
 * ## What it refuses to do
 *
 * The security model here is an EXACT-NAME allowlist, and it has to be, because
 * the extension allowlist that protects `sourceContext.ts` does not apply: a
 * manifest has no source extension. Only the names in `MANIFEST_FILES` are ever
 * opened, plus files matching `PROJECT_EXT` whose names vary by project.
 *
 * `.env` is deliberately NOT in that list, and never will be. It is the single
 * most useful-looking file here and it holds secrets; two production rows had a
 * live Stripe key and a Discord bot token pasted into an error box already, and
 * we are not going to be the ones who send the next one. Its EXISTENCE is a
 * fact worth having and costs nothing - `has_env_file` says so without reading
 * a byte.
 *
 * Everything resolves inside the project root after symlinks, the walk is
 * depth- and count-bounded, and every read is size-capped. A repository is
 * untrusted input; it was cloned, not written.
 *
 * ## Never throws
 *
 * Returns `null` rather than raising, on every path. A debug that fails because
 * the fact-gatherer tripped over a permissions error would be strictly worse
 * than the guessing this replaces.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, extname, relative, sep } from 'node:path';

import { buildWorkspaceFacts, type WorkspaceFacts } from './workspaceFacts.js';

/**
 * Opened by exact name only. `.env` is absent on purpose - see the header.
 *
 * Load bearing, and it took a mutation pass to make it so: the reads used to be
 * driven by three hard-coded `joined('package.json')` calls, which meant adding
 * `.env` to this Set changed no behaviour and turned no test red. A guard that
 * cannot be broken by editing it is not a guard. Everything now iterates this
 * list, and `drift.test.ts` pins its exact contents.
 */
export const MANIFEST_FILES = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
] as const;

type ManifestName = (typeof MANIFEST_FILES)[number];

function isManifestName(name: string): name is ManifestName {
  return (MANIFEST_FILES as readonly string[]).includes(name);
}

/** .NET project files. Names vary per project, so these go by extension. */
const PROJECT_EXT = new Set(['.csproj', '.fsproj', '.vbproj']);

/** Never descended into. Same list the chunker and sourceContext use. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env', '.virtualenv',
  'dist', 'build', 'out', '.next', '.nuxt', 'coverage', 'target', 'bin', 'obj',
  '.idea', '.vscode', '.cache', 'vendor', 'site-packages',
]);

/** A manifest larger than this is not a manifest we can use. */
export const MAX_MANIFEST_BYTES = 512 * 1024;
/** Directories visited. A monorepo must cost a bounded walk, not a full one. */
export const MAX_DIRS = 400;
/** How deep. Deep enough for `services/api/src`, shallow enough to stay cheap. */
export const MAX_DEPTH = 6;
/** Python files collected for `local_modules`. Matches the extension's cap. */
export const MAX_PY_FILES = 600;
/** .NET project files read. Six services is a normal solution; twelve is plenty. */
export const MAX_CSPROJ = 12;
/**
 * Nested manifests read, beyond the root ones.
 *
 * A monorepo keeps its real dependencies in subdirectories - this repository's
 * root `package.json` declares exactly one package while `apps/web` declares
 * forty, and salman's react-dom error was about `web/package.json` in a tree
 * whose root is a .NET solution. Reading only the root would have made the
 * feature answer confidently about the wrong half of his project.
 */
export const MAX_NESTED_MANIFESTS = 8;
/** Wall clock. A slow or network filesystem costs the facts, never the debug. */
export const DEADLINE_MS = 1500;

/**
 * How long a gathered set stays good.
 *
 * The VS Code extension has cached these on the same TTL since 2026-09-10 (it
 * shares the framework hint's window) and this copy shipped without one - an
 * agent working through a failing build calls `debug_error` repeatedly, and
 * every call was walking the tree again. Five minutes is also the CORRECTNESS
 * bound, and it is the reason the TTL is short rather than long: install a
 * package and the facts are stale, so the window has to be small enough that a
 * wrong answer cannot outlive the mistake by much.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { root: string; at: number; facts: GatheredFacts | null } | null = null;

/** Test seam. Never called in production. */
export function __resetWorkspaceFactsCache(): void {
  cached = null;
}

function insideRoot(candidate: string, root: string): boolean {
  let realRoot: string;
  let realCandidate: string;
  try { realRoot = realpathSync(root); } catch { return false; }
  try { realCandidate = realpathSync(candidate); } catch { return false; }
  const rel = relative(realRoot, realCandidate);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep + '..'));
}

function readCapped(path: string, root: string): string | null {
  try {
    if (!insideRoot(path, root)) { return null; }
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) { return null; }
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

interface Walked {
  pythonFiles: string[];
  pythonTruncated: boolean;
  csprojPaths: string[];
  csprojTruncated: boolean;
  nested: Array<{ name: string; path: string }>;
  nestedTruncated: boolean;
  rootDirs: string[];
  hasEnvFile: boolean;
}

/**
 * One bounded pass over the tree.
 *
 * Breadth-first so that a shallow, relevant directory is always visited before
 * a deep one - when the caps bite, what survives is the top of the project
 * rather than whichever branch the walk happened to enter first.
 */
function walk(root: string, deadline: number): Walked {
  const out: Walked = {
    pythonFiles: [], pythonTruncated: false,
    csprojPaths: [], csprojTruncated: false,
    nested: [], nestedTruncated: false,
    rootDirs: [], hasEnvFile: false,
  };
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;

  while (queue.length > 0) {
    if (Date.now() > deadline) { out.pythonTruncated = true; out.csprojTruncated = true; break; }
    if (visited >= MAX_DIRS) { out.pythonTruncated = true; out.csprojTruncated = true; break; }
    const next = queue.shift();
    if (!next) { break; }
    const { dir, depth } = next;
    visited += 1;

    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .map(d => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      continue;
    }

    for (const e of entries) {
      // A symlink reports `isDirectory() === false`, so a link to a directory
      // is never descended into - which was accidental protection until a
      // mutation pass showed the containment test passing for that reason
      // rather than for the check it was written to exercise. A symlinked FILE
      // does fall through to the file branch below, gets collected, and is
      // stopped by `insideRoot` inside `readCapped`. Both halves are needed and
      // both are now pinned by their own test.
      if (e.isDir) {
        if (depth === 0) { out.rootDirs.push(e.name); }
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) { continue; }
        if (depth + 1 <= MAX_DEPTH) { queue.push({ dir: join(dir, e.name), depth: depth + 1 }); }
        continue;
      }
      if (depth === 0 && (e.name === '.env' || e.name.startsWith('.env.'))) {
        // Recorded, never opened. See the header.
        out.hasEnvFile = true;
      }
      if (depth > 0 && isManifestName(e.name)) {
        if (out.nested.length < MAX_NESTED_MANIFESTS) {
          out.nested.push({ name: e.name, path: join(dir, e.name) });
        } else {
          out.nestedTruncated = true;
        }
      }
      const ext = extname(e.name).toLowerCase();
      if (ext === '.py') {
        if (out.pythonFiles.length < MAX_PY_FILES) {
          out.pythonFiles.push(relative(root, join(dir, e.name)));
        } else {
          out.pythonTruncated = true;
        }
      } else if (PROJECT_EXT.has(ext)) {
        if (out.csprojPaths.length < MAX_CSPROJ) {
          out.csprojPaths.push(join(dir, e.name));
        } else {
          out.csprojTruncated = true;
        }
      }
    }
  }
  return out;
}

/** What the gatherer adds on top of the shared pure contract. */
export interface GatheredFacts extends WorkspaceFacts {
  /**
   * A `.env` (or `.env.*`) sits at the project root.
   *
   * Recorded because two of the 76 fixes in the 2026-09-13 corpus turned on it
   * - one workspace had only `.env.example`, another had a deployed value that
   * differed from the local file - and because "there is one" is the whole of
   * what can be safely known. The contents are never read.
   */
  has_env_file: boolean;
}

/**
 * Gather what this repository declares. Returns null when there is nothing
 * worth sending, when the root is unusable, or on any failure at all.
 */
export function gatherWorkspaceFacts(root: string | null | undefined): GatheredFacts | null {
  try {
    if (!root || typeof root !== 'string') { return null; }
    const abs = resolve(root);

    // Keyed by root, not merely time: a single agent process can be pointed at
    // more than one repository, and serving one project's manifests for another
    // would be worse than sending nothing at all.
    const now = Date.now();
    if (cached && cached.root === abs && (now - cached.at) < CACHE_TTL_MS) {
      return cached.facts;
    }
    try {
      if (!statSync(abs).isDirectory()) { return null; }
    } catch {
      // Deliberately NOT cached. A root that does not exist yet may exist on
      // the next call (a clone finishing, a folder being opened), and caching
      // the failure would hold the feature off for five minutes for no reason.
      return null;
    }

    const deadline = Date.now() + DEADLINE_MS;
    const walked = walk(abs, deadline);

    const manifest = (name: string) =>
      isManifestName(name) ? readCapped(join(abs, name), abs) : null;

    // Nested manifests, concatenated per KIND into the same string the root one
    // occupies. Concatenation is safe for every format here and keeps the pure
    // builder's contract untouched: requirements.txt is line-oriented, and both
    // JSON and TOML parsers in `workspaceFacts.ts` are regex-shaped rather than
    // strict, by the design documented there. A package.json that fails to
    // parse contributes nothing rather than breaking the set.
    const extraByKind: Record<string, string[]> = {};
    for (const n of walked.nested) {
      if (Date.now() > deadline) { walked.nestedTruncated = true; break; }
      const text = readCapped(n.path, abs);
      if (text === null) { continue; }
      (extraByKind[n.name] ||= []).push(text);
    }
    const joined = (name: string): string | null => {
      const root = manifest(name);
      const extra = extraByKind[name] || [];
      if (root === null && extra.length === 0) { return null; }
      if (name === 'package.json') {
        // JSON cannot be concatenated. Merge the dependency blocks instead,
        // which is the only part `depsFromPackageJson` and its version twin
        // read. Anything unparseable is skipped, never thrown.
        const merged: Record<string, Record<string, string>> = {};
        for (const text of [root, ...extra]) {
          if (text === null) { continue; }
          let pkg: any;
          try { pkg = JSON.parse(text); } catch { continue; }
          if (!pkg || typeof pkg !== 'object') { continue; }
          for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
            const block = pkg[field];
            if (!block || typeof block !== 'object' || Array.isArray(block)) { continue; }
            merged[field] = { ...block, ...(merged[field] || {}) };   // first file wins
          }
        }
        return JSON.stringify(merged);
      }
      return [root, ...extra].filter((t): t is string => t !== null).join('\n');
    };

    const csprojFiles: string[] = [];
    for (const p of walked.csprojPaths) {
      if (Date.now() > deadline) { walked.csprojTruncated = true; break; }
      const text = readCapped(p, abs);
      if (text !== null) { csprojFiles.push(text); }
    }

    const facts = buildWorkspaceFacts({
      packageJson: joined('package.json'),
      requirementsTxt: joined('requirements.txt'),
      pyprojectToml: joined('pyproject.toml'),
      csprojFiles,
      // A manifest list we stopped enumerating declares more than we can see,
      // and a name missing from a short list must prove nothing.
      csprojTruncated: walked.csprojTruncated || walked.nestedTruncated,
      pythonFiles: walked.pythonFiles,
      pythonFilesTruncated: walked.pythonTruncated,
      rootDirs: walked.rootDirs,
      // Deliberately absent: `python_interpreter`. VS Code's Python extension
      // reports which interpreter is SELECTED; this process has no equivalent
      // and could only report its own `process.execPath`, which is node. A
      // wrong fact is worse than a missing one - the engine treats absence as
      // "we do not know" and says so, which is true here.
      pythonInterpreter: null,
    });

    const out: GatheredFacts = { ...facts, has_env_file: walked.hasEnvFile };
    cached = { root: abs, at: now, facts: out };
    return out;
  } catch {
    return null;
  }
}
