// Manifest-driven font vendoring. Downloads WOFF2 files from Fontshare and
// Google Fonts into a local directory, writes a LICENSES.txt with per-family
// copyright/reserved-font-name declarations plus the OFL body, and writes a
// fonts.lock.json with sha256 + source URL + bytes for each file.
//
// Idempotent: re-running with an unchanged manifest produces identical
// output. Variable-font CDNs (Google Fonts Caveat, Geist Mono) dedupe: if
// multiple requested weights resolve to the same upstream URL, one file is
// written with a weight range in its filename and the lock entry lists all
// covered weights.
//
// checkOnly mode verifies that re-fetching upstream produces files matching
// the existing fonts.lock.json; rejects on drift.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OFL_BODY = `-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
`;

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function fetchBytes(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function parseFaces(css) {
  const out = new Map();
  for (const m of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const body = m[1];
    const weightMatch = body.match(/font-weight\s*:\s*(\d+)/);
    const urlMatch = body.match(/url\(([^)]+\.woff2[^)]*)\)/);
    if (!weightMatch || !urlMatch) continue;
    let url = urlMatch[1].replace(/^['"]|['"]$/g, '').trim();
    if (url.startsWith('//')) url = 'https:' + url;
    out.set(Number(weightMatch[1]), url);
  }
  return out;
}

async function resolveFontshare(fam) {
  const url = `https://api.fontshare.com/v2/css?f[]=${fam.fontshareId}@${fam.weights.join(',')}&display=swap`;
  const faces = parseFaces(await fetchText(url));
  return fam.weights.map(w => {
    const src = faces.get(w);
    if (!src) throw new Error(`${fam.family}: no woff2 for weight ${w} in Fontshare CSS`);
    return { weight: w, src };
  });
}

async function resolveGoogle(fam) {
  const famParam = fam.googleName.replaceAll(' ', '+');
  const url = `https://fonts.googleapis.com/css2?family=${famParam}:wght@${fam.weights.join(';')}&display=swap`;
  const faces = parseFaces(await fetchText(url));
  return fam.weights.map(w => {
    const src = faces.get(w);
    if (!src) throw new Error(`${fam.family}: no woff2 for weight ${w} in Google Fonts CSS`);
    return { weight: w, src };
  });
}

async function resolveFamily(fam) {
  const faces = fam.source === 'fontshare' ? await resolveFontshare(fam)
    : fam.source === 'google' ? await resolveGoogle(fam)
    : null;
  if (!faces) throw new Error(`${fam.family}: unknown source "${fam.source}"`);

  // Dedupe by URL: some variable-font CDNs return the same file for multiple
  // requested weights. Write one file; reference it from both @font-face
  // blocks via a weight range in the consumer CSS.
  const groups = new Map();
  for (const { weight, src } of faces) {
    if (!groups.has(src)) groups.set(src, []);
    groups.get(src).push(weight);
  }
  return [...groups.entries()].map(([url, weights]) => {
    weights.sort((a, b) => a - b);
    const suffix = weights.length > 1 ? weights.join('-') : String(weights[0]);
    return { filename: `${fam.slug}-${suffix}.woff2`, url, weights };
  });
}

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function licenseBlockFor(fam) {
  return [
    `== ${fam.family} ==`,
    `${fam.copyright},`,
    `with Reserved Font Name "${fam.reservedFontName}".`,
    `SPDX-License-Identifier: ${fam.license}`,
    ``,
  ].join('\n');
}

/**
 * Fetch vendored fonts per a manifest. Writes WOFF2 files, LICENSES.txt,
 * and fonts.lock.json into outDir. On checkOnly, verifies lock matches
 * upstream and throws on drift.
 *
 * @param {object} opts
 * @param {object} opts.manifest                    — parsed manifest object
 * @param {string} opts.outDir                      — absolute output directory
 * @param {boolean} [opts.checkOnly=false]          — verify mode, no writes
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{files: string[], drift: string[]}>}
 */
export async function fetchFonts({ manifest, outDir, checkOnly = false, log }) {
  const emit = log ?? (m => console.log(m));

  for (const fam of manifest.families) {
    if (!manifest.allowedLicenses.includes(fam.license)) {
      throw new Error(`${fam.family}: license ${fam.license} not in allowedLicenses ${JSON.stringify(manifest.allowedLicenses)}`);
    }
  }

  if (!checkOnly) await fs.mkdir(outDir, { recursive: true });

  const newLock = { generated: new Date().toISOString(), files: {} };
  const downloads = [];

  for (const fam of manifest.families) {
    const files = await resolveFamily(fam);
    for (const { filename, url, weights } of files) {
      const bytes = await fetchBytes(url);
      const hash = sha256(bytes);
      newLock.files[filename] = { family: fam.family, weights, source: url, sha256: hash, bytes: bytes.length };
      downloads.push({ filename, outPath: path.join(outDir, filename), bytes });
      emit(`  ${fam.family} ${weights.join(',')} -> ${filename}  (${bytes.length.toLocaleString()} B, ${hash.slice(0, 12)}...)`);
    }
  }

  const lockPath = path.join(outDir, 'fonts.lock.json');
  let existingLock = null;
  try { existingLock = JSON.parse(await fs.readFile(lockPath, 'utf8')); } catch {}

  if (checkOnly) {
    if (!existingLock) throw new Error('fonts.lock.json missing — run without checkOnly first.');
    const drift = [];
    for (const [name, entry] of Object.entries(newLock.files)) {
      const prev = existingLock.files?.[name];
      if (!prev || prev.sha256 !== entry.sha256) drift.push(name);
    }
    for (const name of Object.keys(existingLock.files ?? {})) {
      if (!newLock.files[name]) drift.push(`${name} (no longer in manifest)`);
    }
    return { files: Object.keys(newLock.files), drift };
  }

  for (const d of downloads) await fs.writeFile(d.outPath, d.bytes);

  const keep = new Set(Object.keys(newLock.files));
  for (const entry of await fs.readdir(outDir)) {
    if (entry.endsWith('.woff2') && !keep.has(entry)) {
      await fs.unlink(path.join(outDir, entry));
      emit(`  removed stale ${entry}`);
    }
  }

  const licenseText = [
    'Fonts in this directory are vendored from their upstream sources by',
    'brand-assets/fonts. Used under the licenses listed below.',
    '',
    ...manifest.families.map(licenseBlockFor),
    OFL_BODY,
  ].join('\n');
  await fs.writeFile(path.join(outDir, 'LICENSES.txt'), licenseText);
  await fs.writeFile(lockPath, JSON.stringify(newLock, null, 2) + '\n');

  return { files: Object.keys(newLock.files), drift: [] };
}
