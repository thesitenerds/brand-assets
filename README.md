# tsn-build-tools

Build-time tooling for Go+Echo projects. One package, five engines:

- **`tsn-build-tools/icon`** — favicon pipeline (monogram → outlined SVG → PNGs → multi-layer ICO)
- **`tsn-build-tools/og`** — Open Graph / Twitter summary_large_image card (1200×630 PNG)
- **`tsn-build-tools/fonts`** — manifest-driven WOFF2 vendoring with license allowlist + drift-detectable lockfile
- **`tsn-build-tools/legal-sync`** — structural parity check between MD templates and published HTML
- **`tsn-build-tools/justfile`** — justfile convention linter (verifies recipe naming, composition, docs, ordering against `~/lab/notes/work/justfile-conventions.md`)

All five are build-time tools. Nothing from this package ships to the browser; consumers run an engine during `pnpm build` or `pnpm check:*` and commit the output (if any).

> **Note on scope.** The package name will evolve — originally narrower ("brand assets"), it now covers build-time correctness tooling too (legal-sync, justfile linting). A rename is planned for `v1.0.0`; until then, `tsn-build-tools` hosts the whole set.

## Install

This package is published as a public GitHub repo, not on npm. Reference it as a git dependency pinned to a tag:

```json
{
  "dependencies": {
    "tsn-build-tools": "github:thesitenerds/tsn-build-tools#v0.1.0"
  }
}
```

Tags are preferred over branches; branches (`#main`) silently change on every install.

## Favicon — `tsn-build-tools/icon`

Converts a short monogram to outlined SVG path data at build time using `opentype.js`, then rasterizes to PNGs and assembles `favicon.ico`. Rendered artifacts have no runtime font dependency.

```js
// scripts/build-icon.mjs
import { buildIcon } from 'tsn-build-tools/icon';
import config from './brand.config.json' with { type: 'json' };

await buildIcon({
  ...config.icon,
  fontPath: process.argv[2],
  outDir: process.argv[3] ?? 'internal/assets/static',
});
```

Required options: `fontPath`, `outDir`, `letters`, `bgColor`, `textColor`, `accentColor`. Everything else (viewBox, sizes, font-size, spacing) has sensible defaults — see `src/icon.mjs` for the full schema.

## OG card — `tsn-build-tools/og`

Lays out brand text (eyebrow, wordmark, tagline, footer) as SVG paths and rasterizes to 1200×630 PNG. A trailing `.` on `wordmarkText` is automatically rendered in `accentColor`.

```js
// scripts/build-og.mjs
import { buildOg } from 'tsn-build-tools/og';
import config from './brand.config.json' with { type: 'json' };

await buildOg({
  ...config.og,
  fontPath: process.argv[2],
  outDir: process.argv[3] ?? 'internal/assets/static',
});
```

Required text: `eyebrowText`, `wordmarkText`, `taglineText`, `footerLeft`, `footerRight`. Required colors: `bgColor`, `lineColor`, `textColor`, `dimColor`, `accentColor`. Sizes and tracking have defaults.

## Fonts — `tsn-build-tools/fonts`

Downloads WOFF2 files per a manifest, writes `LICENSES.txt` + `fonts.lock.json`, cleans up stale files. Variable-font CDNs (e.g. Google Fonts for Geist Mono) dedupe automatically — one file covers the whole requested weight range.

```js
// scripts/build-fonts.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchFonts } from 'tsn-build-tools/fonts';

const manifest = JSON.parse(await fs.readFile('scripts/fonts.manifest.json', 'utf8'));
const checkOnly = process.argv.includes('--check');

const { drift } = await fetchFonts({
  manifest,
  outDir: path.resolve('internal/assets/static/fonts'),
  checkOnly,
});

if (checkOnly && drift.length) {
  console.error(`fonts.lock.json drift: ${drift.join(', ')}`);
  process.exit(1);
}
```

Manifest schema:

```json
{
  "allowedLicenses": ["OFL-1.1"],
  "families": [
    {
      "slug": "cabinet-grotesk",
      "family": "Cabinet Grotesk",
      "source": "fontshare",
      "fontshareId": "cabinet-grotesk",
      "weights": [500, 700],
      "license": "OFL-1.1",
      "copyright": "Copyright (c) Indian Type Foundry",
      "reservedFontName": "Cabinet Grotesk"
    },
    {
      "slug": "geist-mono",
      "family": "Geist Mono",
      "source": "google",
      "googleName": "Geist Mono",
      "weights": [400, 500],
      "license": "OFL-1.1",
      "copyright": "Copyright (c) 2023 Vercel",
      "reservedFontName": "Geist Mono"
    }
  ]
}
```

`source` is `"fontshare"` or `"google"`. `license` must appear in `allowedLicenses` or the run aborts before any network call.

## Legal-doc drift — `tsn-build-tools/legal-sync`

Compares paired representations of the same legal content (typical case: a Markdown template and its published HTML page) by extracting structural tokens — title, version+date, h2/h3 headings, bullet items, paragraphs — from each and diffing them. Ignores formatting differences, HTML entities, smart quotes, whitespace. Skips `Notes for the Developer` sections.

```js
// scripts/check-legal-sync.mjs
import path from 'node:path';
import os from 'node:os';
import { checkLegalSync } from 'tsn-build-tools/legal-sync';

const templatesDir = path.join(os.homedir(), 'workspace/notes/personal/business/thesitenerds/legal');
const repoRoot = path.resolve(import.meta.dirname, '..');

const pairs = [
  { name: 'privacy', mdPath: path.join(templatesDir, 'sample-privacy-policy.md'), htmlPath: path.join(repoRoot, 'internal/assets/templates/pages/privacy.html') },
];

const results = await checkLegalSync({ pairs });
let fail = false;
for (const r of results) {
  if (r.ok) {
    console.log(`[${r.name}] OK  (${r.counts.h2} h2, ${r.counts.h3} h3, ${r.counts.li} li, ${r.counts.p} p)`);
  } else {
    fail = true;
    console.error(`[${r.name}] DRIFT (${r.issues.length} issue${r.issues.length === 1 ? '' : 's'}):`);
    for (const issue of r.issues) console.error(`  - ${issue}`);
  }
}
if (fail) process.exit(1);
```

## Justfile linter — `tsn-build-tools/justfile`

Parses a project's `justfile` and verifies it conforms to the conventions documented at `~/lab/notes/work/justfile-conventions.md` — required recipes per category + features, composition dependencies on `build` / `check` / `dev` / `run` / `docker-build` / `docker-run`, doc comments above every recipe, and ordering.

```js
// scripts/check-justfile.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintJustfile } from 'tsn-build-tools/justfile';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const manifest = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'just.manifest.json'), 'utf8'));
const { issues } = await lintJustfile({
  justfilePath: path.join(REPO_ROOT, 'justfile'),
  manifest,
});

let errors = 0;
for (const issue of issues) {
  const where = issue.line > 0 ? `:${issue.line}` : '';
  console.error(`[${issue.level}] justfile${where}: ${issue.message}`);
  if (issue.level === 'error') errors++;
}
if (errors) {
  console.error(`\n${errors} error${errors === 1 ? '' : 's'}. Fix and re-run.`);
  process.exit(1);
}
console.log('justfile OK');
```

Manifest schema (`just.manifest.json` in repo root):

```json
{
  "category": "app",
  "features": ["frontend", "assets", "legal", "database", "docker", "fly"],
  "allowlist": ["dev-api"]
}
```

- **`category`**: `"app"` or `"library"`
- **`features`**: subset of `css`, `frontend`, `icons`, `fonts`, `legal`, `database`, `docker`, `fly`
- **`allowlist`**: project-specific recipes that don't match the standard catalog

See the conventions doc for the full standard recipe list and what each feature requires.

## Versioning

Tagged SemVer. Until `1.0.0`, minor-version bumps may break API. Pin to an exact tag in consumers.

## License

MIT. See `LICENSE`.
