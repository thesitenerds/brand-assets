// Favicon pipeline: monogram → outlined SVG → multi-size PNGs → multi-layer ICO.
//
// Text is converted to SVG path data at build time via opentype.js, so the
// rendered PNGs have no font dependency. Re-run whenever the config or font
// changes.

import fs from 'node:fs/promises';
import path from 'node:path';
import opentype from 'opentype.js';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const DEFAULTS = {
  viewBox: 100,
  cornerRadius: 14,
  letterFontSize: 58,
  periodFontSize: 88,
  letterSpacing: -3,
  baselineY: 72,
  period: '.',
  pngSizes: [16, 32, 48, 180, 192, 512],
  icoSizes: [16, 32, 48],
};

/**
 * Build a favicon set from a brand monogram.
 *
 * @param {object} opts
 * @param {string} opts.fontPath           — absolute path to a bold .otf file
 * @param {string} opts.outDir             — absolute output directory
 * @param {string} opts.letters            — monogram characters (short: 2-3 chars)
 * @param {string} opts.bgColor            — background fill
 * @param {string} opts.textColor          — letter fill
 * @param {string} opts.accentColor        — period/dot fill
 * @param {number} [opts.viewBox=100]
 * @param {number} [opts.cornerRadius=14]
 * @param {number} [opts.letterFontSize=58]
 * @param {number} [opts.periodFontSize=88]
 * @param {number} [opts.letterSpacing=-3]
 * @param {number} [opts.baselineY=72]
 * @param {string} [opts.period='.']
 * @param {number[]} [opts.pngSizes]
 * @param {number[]} [opts.icoSizes]
 * @param {(msg: string) => void} [opts.log] — logger; defaults to console.log
 */
export async function buildIcon(opts) {
  const cfg = { ...DEFAULTS, ...opts };
  const log = cfg.log ?? (m => console.log(m));

  for (const k of ['fontPath', 'outDir', 'letters', 'bgColor', 'textColor', 'accentColor']) {
    if (!cfg[k]) throw new Error(`buildIcon: missing required option "${k}"`);
  }

  const absFontPath = path.resolve(cfg.fontPath);
  try { await fs.access(absFontPath); }
  catch { throw new Error(`buildIcon: font file not found: ${absFontPath}`); }

  log(`loading font: ${absFontPath}`);
  const font = await opentype.load(absFontPath);

  const letterGlyphs = [...cfg.letters].map(ch => {
    const g = font.charToGlyph(ch);
    if (!g || g.name === '.notdef') throw new Error(`buildIcon: font missing glyph for '${ch}'`);
    return g;
  });
  const periodGlyph = font.charToGlyph(cfg.period);
  if (!periodGlyph || periodGlyph.name === '.notdef') {
    throw new Error(`buildIcon: font missing glyph for '${cfg.period}'`);
  }

  const letterScale = cfg.letterFontSize / font.unitsPerEm;
  const periodScale = cfg.periodFontSize / font.unitsPerEm;

  const totalGlyphs = letterGlyphs.length + 1;
  const sumLetterAdvances = letterGlyphs.reduce((w, g) => w + g.advanceWidth * letterScale, 0);
  const periodAdvance = periodGlyph.advanceWidth * periodScale;
  const totalWidth = sumLetterAdvances + periodAdvance + cfg.letterSpacing * (totalGlyphs - 1);
  const startX = (cfg.viewBox - totalWidth) / 2;

  const paths = [];
  let currentX = startX;
  for (const g of letterGlyphs) {
    const p = g.getPath(currentX, cfg.baselineY, cfg.letterFontSize);
    paths.push({ d: p.toPathData(4), fill: cfg.textColor });
    currentX += g.advanceWidth * letterScale + cfg.letterSpacing;
  }
  const pp = periodGlyph.getPath(currentX, cfg.baselineY, cfg.periodFontSize);
  paths.push({ d: pp.toPathData(4), fill: cfg.accentColor });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cfg.viewBox} ${cfg.viewBox}">
  <rect width="${cfg.viewBox}" height="${cfg.viewBox}" rx="${cfg.cornerRadius}" fill="${cfg.bgColor}"/>
${paths.map(p => `  <path fill="${p.fill}" d="${p.d}"/>`).join('\n')}
</svg>
`;

  const absOutDir = path.resolve(cfg.outDir);
  await fs.mkdir(absOutDir, { recursive: true });

  const svgPath = path.join(absOutDir, 'icon.svg');
  await fs.writeFile(svgPath, svg);
  log(`  wrote ${svgPath}`);

  const svgBuffer = Buffer.from(svg);
  for (const size of cfg.pngSizes) {
    const pngPath = path.join(absOutDir, `icon-${size}.png`);
    await sharp(svgBuffer).resize(size, size).png().toFile(pngPath);
    log(`  wrote ${pngPath}`);
  }

  const icoBuffers = await Promise.all(
    cfg.icoSizes.map(size => sharp(svgBuffer).resize(size, size).png().toBuffer())
  );
  const icoData = await pngToIco(icoBuffers);
  const icoPath = path.join(absOutDir, 'favicon.ico');
  await fs.writeFile(icoPath, icoData);
  log(`  wrote ${icoPath}`);
}
