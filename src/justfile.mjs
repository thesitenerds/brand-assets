// Justfile linter. Verifies that a project's justfile matches the conventions
// documented at ~/workspace/notes/work/justfile-conventions.md — required
// recipes per category/features, required dependencies on core composed
// recipes, doc comments above every recipe, and (soft-check) section order.
//
// The caller loads the justfile and manifest, passes them as absolute paths,
// and renders the returned issues however fits its flow. Zero npm deps.

import fs from 'node:fs/promises';

// Canonical ordering for the soft order-check. Only recipes listed here are
// ordered; allowlisted / unknown recipes are skipped.
const ORDER = [
  'default',
  'install', 'vendor', 'tidy',
  'fmt', 'vet', 'lint',
  'test', 'test-race', 'test-cover', 'test-integration',
  'check',
  'build', 'run', 'clean',
  'dev',
  'css', 'css-watch', 'portal', 'portal-dev',
  'fonts', 'fonts-check', 'icon', 'og', 'legal-check', 'justfile-check',
  'db-up', 'db-down', 'db-shell', 'db-reset', 'migrate', 'migrate-version', 'sqlc-gen',
  'docker-build', 'docker-run',
  'fly-deploy', 'fly-ssh', 'fly-logs',
];

const APP_ALWAYS = [
  'default', 'install', 'vendor', 'tidy',
  'fmt', 'vet', 'lint',
  'test', 'test-race',
  'check',
  'build', 'run', 'clean',
  'dev',
  'justfile-check',
];

const LIBRARY_ALWAYS = [
  'default', 'tidy',
  'fmt', 'vet', 'lint',
  'test', 'test-race',
  'check',
  'build',
];

const FEATURE_RECIPES = {
  css: ['css', 'css-watch'],
  frontend: ['portal', 'portal-dev'],
  icons: ['icon', 'og'],
  fonts: ['fonts', 'fonts-check'],
  legal: ['legal-check'],
  database: ['db-up', 'db-down', 'db-shell', 'migrate', 'migrate-version', 'sqlc-gen'],
  docker: ['docker-build', 'docker-run'],
  fly: ['fly-deploy', 'fly-ssh', 'fly-logs'],
};

// Optional recipes that are allowed but not required. Extend as needed.
const APP_OPTIONAL = ['test-cover', 'test-integration', 'db-reset'];
const LIBRARY_OPTIONAL = ['test-cover'];

function requiredFor(manifest) {
  if (manifest.category === 'library') return [...LIBRARY_ALWAYS];
  const out = [...APP_ALWAYS];
  for (const f of manifest.features ?? []) {
    if (FEATURE_RECIPES[f]) out.push(...FEATURE_RECIPES[f]);
  }
  return out;
}

function optionalFor(manifest) {
  return manifest.category === 'library' ? LIBRARY_OPTIONAL : APP_OPTIONAL;
}

// What each composed recipe is expected to depend on. Returns null for
// recipes with no expected deps (or unknown recipes the linter ignores).
function expectedDepsFor(name, manifest) {
  const features = new Set(manifest.features ?? []);
  const isApp = manifest.category !== 'library';

  if (name === 'run') return ['build'];
  if (name === 'docker-build') return features.has('docker') ? ['vendor'] : null;
  if (name === 'docker-run') return features.has('docker') ? ['docker-build'] : null;

  if (name === 'build' && isApp) {
    const deps = ['install', 'vendor'];
    if (features.has('fonts')) deps.push('fonts-check');
    if (features.has('css')) deps.push('css');
    if (features.has('frontend')) deps.push('portal');
    return deps;
  }

  if (name === 'check') {
    const deps = ['fmt', 'vet', 'lint', 'test'];
    if (features.has('fonts')) deps.push('fonts-check');
    if (features.has('legal')) deps.push('legal-check');
    if (isApp) deps.push('justfile-check');
    return deps;
  }

  if (name === 'dev' && isApp) {
    return features.has('database') ? ['db-up', 'migrate'] : [];
  }

  return null;
}

// Parse a justfile into { recipes: [{ name, deps, lineNumber, docComment }] }.
// Handles: parameterized recipes (`migrate env='dev':`), multi-line doc
// comments immediately above a recipe, deps after the colon. Indented lines
// (recipe bodies) are ignored. Variables (`foo := "bar"`) are ignored.
function parseJustfile(text) {
  const lines = text.split('\n');
  const recipes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip just directives and variable/alias assignments (`set x := y`,
    // `alias b := build`, `FOO := "bar"`). The `:=` operator is unambiguous.
    if (/:=/.test(line)) continue;
    const m = line.match(/^([a-z][a-z0-9-]*)(?:\s+[^:]+?)?:\s*(.*)$/);
    if (!m) continue;
    const [, name, depsPart] = m;
    const deps = depsPart.trim().split(/\s+/).filter(d => /^[a-z][a-z0-9-]*$/.test(d));

    // Collect doc comment: contiguous `#` lines immediately above this recipe.
    const commentLines = [];
    let j = i - 1;
    while (j >= 0 && /^\s*#/.test(lines[j])) {
      commentLines.unshift(lines[j].replace(/^\s*#\s?/, '').trimEnd());
      j--;
    }
    const docComment = commentLines.join('\n').trim();

    recipes.push({ name, deps, lineNumber: i + 1, docComment });
  }

  return { recipes };
}

/**
 * Lint a justfile against the conventions.
 *
 * @param {object} opts
 * @param {string} opts.justfilePath  — absolute path to the justfile
 * @param {object} opts.manifest      — parsed just.manifest.json
 * @returns {Promise<{ issues: Array, recipes: Array }>}
 */
export async function lintJustfile({ justfilePath, manifest }) {
  const text = await fs.readFile(justfilePath, 'utf8');
  const { recipes } = parseJustfile(text);
  const issues = [];

  const names = new Set(recipes.map(r => r.name));
  const allowlist = new Set(manifest.allowlist ?? []);
  const required = requiredFor(manifest);
  const optional = new Set([...requiredFor(manifest), ...optionalFor(manifest)]);
  for (const f of manifest.features ?? []) {
    for (const r of FEATURE_RECIPES[f] ?? []) optional.add(r);
  }

  // 1. Required recipes present?
  for (const req of required) {
    if (!names.has(req)) {
      issues.push({ level: 'error', line: 0, message: `missing required recipe: "${req}"` });
    }
  }

  // 2. Every recipe has a doc comment (except `default`).
  for (const r of recipes) {
    if (r.name === 'default') continue;
    if (!r.docComment) {
      issues.push({ level: 'error', line: r.lineNumber, message: `recipe "${r.name}" has no doc comment above it` });
    }
  }

  // 3. Unknown recipes (not standard-for-features, not allowlisted).
  for (const r of recipes) {
    if (optional.has(r.name)) continue;
    if (allowlist.has(r.name)) continue;
    issues.push({ level: 'error', line: r.lineNumber, message: `unknown recipe "${r.name}" (not in standard catalog for declared features, not in allowlist)` });
  }

  // 4. Expected dependencies on composed recipes.
  for (const r of recipes) {
    const expected = expectedDepsFor(r.name, manifest);
    if (!expected) continue;
    const actual = new Set(r.deps);
    const missing = expected.filter(d => !actual.has(d));
    if (missing.length) {
      issues.push({
        level: 'error',
        line: r.lineNumber,
        message: `recipe "${r.name}" is missing expected deps: ${missing.join(', ')}`,
      });
    }
  }

  // 5. Order check (soft — warn level).
  let lastIdx = -1;
  let lastName = null;
  for (const r of recipes) {
    const idx = ORDER.indexOf(r.name);
    if (idx === -1) continue;
    if (idx < lastIdx) {
      issues.push({
        level: 'warn',
        line: r.lineNumber,
        message: `"${r.name}" appears after "${lastName}" but should come before it per conventions`,
      });
    }
    lastIdx = idx;
    lastName = r.name;
  }

  return { issues, recipes };
}
