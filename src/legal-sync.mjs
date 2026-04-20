// Structural drift detection between pairs of legal documents stored in two
// representations (e.g. a Markdown template and its published HTML render).
// Extracts title, version+date, and ordered lists of h2/h3 headings, bullet
// items, and paragraphs from each. Returns per-pair issues; caller decides
// whether to exit non-zero.
//
// What it ignores: markdown/HTML formatting, HTML entities vs their unicode
// equivalents, smart quotes, whitespace. Notes-for-developer blocks in
// Markdown are skipped (not published).

import fs from 'node:fs/promises';

function normalize(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim()
    .toLowerCase();
}

function stripMd(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

const ENTITIES = {
  mdash: '\u2014', ndash: '\u2013', middot: '\u00b7',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  larr: '\u2190', rarr: '\u2192', nbsp: ' ',
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'",
  copy: '\u00a9', hellip: '\u2026',
};

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&(\w+);/g, (_, name) => ENTITIES[name] ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractFromMd(raw) {
  const out = { title: null, version: null, effective: null, h2s: [], h3s: [], lis: [], ps: [] };
  const lines = raw.split('\n');

  for (const line of lines) {
    if (/^##\s+/.test(line)) break;
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1 && !out.title) out.title = normalize(h1[1]);
    const ver = line.match(/Version\s+(\d+),\s+effective\s+(\d{4}-\d{2}-\d{2})/i);
    if (ver && !out.version) { out.version = ver[1]; out.effective = ver[2]; }
  }

  let inBody = false;
  for (const line of lines) {
    if (!inBody) { if (/^##\s+/.test(line)) inBody = true; else continue; }
    if (/Notes for the Developer/i.test(line)) break;

    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) { out.h2s.push(normalize(h2[1])); continue; }
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) { out.h3s.push(normalize(h3[1])); continue; }
    const bullet = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/);
    if (bullet) { out.lis.push(normalize(stripMd(bullet[1]))); continue; }

    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;
    out.ps.push(normalize(stripMd(trimmed)));
  }
  return out;
}

function extractFromHtml(raw) {
  const out = { title: null, version: null, effective: null, h2s: [], h3s: [], lis: [], ps: [] };
  const article = raw.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const scope = article ? article[1] : raw;

  const h1 = scope.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) out.title = normalize(stripHtml(h1[1]));

  const ver = scope.match(/Version\s+(\d+)\s*(?:&middot;|\u00b7)\s*Effective\s+(\d{4}-\d{2}-\d{2})/i);
  if (ver) { out.version = ver[1]; out.effective = ver[2]; }

  const firstH2 = scope.search(/<h2[^>]*>/i);
  const body = firstH2 >= 0 ? scope.slice(firstH2) : scope;

  for (const m of body.matchAll(/<(h2|h3|li|p)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    const content = normalize(stripHtml(m[2]));
    if (!content) continue;
    if (tag === 'h2') out.h2s.push(content);
    else if (tag === 'h3') out.h3s.push(content);
    else if (tag === 'li') out.lis.push(content);
    else if (tag === 'p') out.ps.push(content);
  }
  return out;
}

function diffArrays(label, a, b, issues) {
  if (a.length !== b.length) {
    issues.push(`${label}: count md=${a.length} html=${b.length}`);
  }
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      issues.push(`${label}[${i}]:\n       md:   ${a[i] ?? '(missing)'}\n       html: ${b[i] ?? '(missing)'}`);
    }
  }
}

function compareExtracted(md, html) {
  const issues = [];
  if (md.title !== html.title) issues.push(`title: md="${md.title}" html="${html.title}"`);
  if (md.version !== html.version) issues.push(`version: md="${md.version}" html="${html.version}"`);
  if (md.effective !== html.effective) issues.push(`effective: md="${md.effective}" html="${html.effective}"`);
  diffArrays('h2', md.h2s, html.h2s, issues);
  diffArrays('h3', md.h3s, html.h3s, issues);
  diffArrays('li', md.lis, html.lis, issues);
  diffArrays('p', md.ps, html.ps, issues);
  return issues;
}

/**
 * Check structural parity across MD/HTML pairs.
 *
 * @param {object} opts
 * @param {Array<{name: string, mdPath: string, htmlPath: string}>} opts.pairs
 *   — absolute paths; caller resolves tildes / project roots.
 * @returns {Promise<Array<{name: string, ok: boolean, issues: string[], counts: object}>>}
 */
export async function checkLegalSync({ pairs }) {
  const results = [];
  for (const pair of pairs) {
    let mdText, htmlText;
    try { mdText = await fs.readFile(pair.mdPath, 'utf8'); }
    catch { results.push({ name: pair.name, ok: false, issues: [`missing md: ${pair.mdPath}`], counts: {} }); continue; }
    try { htmlText = await fs.readFile(pair.htmlPath, 'utf8'); }
    catch { results.push({ name: pair.name, ok: false, issues: [`missing html: ${pair.htmlPath}`], counts: {} }); continue; }

    const md = extractFromMd(mdText);
    const html = extractFromHtml(htmlText);
    const issues = compareExtracted(md, html);
    results.push({
      name: pair.name,
      ok: issues.length === 0,
      issues,
      counts: { h2: md.h2s.length, h3: md.h3s.length, li: md.lis.length, p: md.ps.length },
    });
  }
  return results;
}
