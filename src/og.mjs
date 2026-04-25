// Open Graph / social card pipeline: brand text → outlined SVG → 1200x630 PNG.
//
// Text is converted to SVG path data at build time via opentype.js, so the
// rendered PNG has no font dependency at display time.

import fs from 'node:fs/promises';
import path from 'node:path';
import opentype from 'opentype.js';
import sharp from 'sharp';

const DEFAULTS = {
  width: 1200,
  height: 630,
  padX: 80,
  padY: 72,
  eyebrowSize: 22,
  eyebrowTrack: 3,
  wordmarkSize: 140,
  wordmarkTrack: -4,
  taglineSize: 52,
  taglineTrack: -1,
  footerSize: 20,
  footerTrack: 3,
  // Optional dataTile defaults — see buildOg JSDoc for the dataTile shape.
  tileWidth: 280,
  tileHeight: 220,
  tilePadX: 24,
  tilePadY: 24,
  tileEyebrowSize: 16,
  tileEyebrowTrack: 2,
  tileValueSize: 56,
  tileValueTrack: -2,
  tileFooterSize: 14,
  tileFooterTrack: 1,
  tileSparkHeight: 28,
  tileSparkStroke: 2,
  tileSparkDotR: 3,
};

function layoutText(font, text, fontSize, tracking, x, y, fill) {
  const scale = fontSize / font.unitsPerEm;
  const paths = [];
  let cursor = x;
  let totalWidth = 0;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const glyph = font.charToGlyph(ch);
    if (!glyph || glyph.name === '.notdef') {
      throw new Error(`buildOg: font missing glyph for ${JSON.stringify(ch)}`);
    }
    const p = glyph.getPath(cursor, y, fontSize);
    paths.push({ d: p.toPathData(4), fill });
    const advance = glyph.advanceWidth * scale;
    const gap = i < chars.length - 1 ? tracking : 0;
    cursor += advance + gap;
    totalWidth += advance + gap;
  }
  return { paths, width: totalWidth };
}

function layoutRight(font, text, fontSize, tracking, rightX, y, fill) {
  const measure = layoutText(font, text, fontSize, tracking, 0, 0, fill);
  return layoutText(font, text, fontSize, tracking, rightX - measure.width, y, fill);
}

/**
 * Build an Open Graph / Twitter summary_large_image card.
 *
 * @param {object} opts
 * @param {string} opts.fontPath      — absolute path to a bold .otf file
 * @param {string} opts.outDir        — absolute output directory
 * @param {string} opts.bgColor
 * @param {string} opts.lineColor     — hairline rule above the footer
 * @param {string} opts.textColor     — primary text (wordmark stem)
 * @param {string} opts.dimColor      — secondary text (eyebrow, tagline, footer-left)
 * @param {string} opts.accentColor   — period/dot and footer-right accent
 * @param {string} opts.eyebrowText
 * @param {string} opts.wordmarkText  — trailing "." will be rendered in accentColor
 * @param {string} opts.taglineText
 * @param {string} opts.footerLeft
 * @param {string} opts.footerRight
 * @param {number} [opts.width=1200]
 * @param {number} [opts.height=630]
 * @param {number} [opts.padX=80]
 * @param {number} [opts.padY=72]
 * @param {number} [opts.eyebrowSize=22]
 * @param {number} [opts.eyebrowTrack=3]
 * @param {number} [opts.wordmarkSize=140]
 * @param {number} [opts.wordmarkTrack=-4]
 * @param {number} [opts.taglineSize=52]
 * @param {number} [opts.taglineTrack=-1]
 * @param {number} [opts.footerSize=20]
 * @param {number} [opts.footerTrack=3]
 * @param {object} [opts.dataTile]    — optional bordered stat tile in the upper-right
 * @param {string} opts.dataTile.eyebrow   — required when dataTile present; uppercased on render
 * @param {string} opts.dataTile.value     — required when dataTile present; the big number
 * @param {number[]} [opts.dataTile.sparkline] — optional ≥2 values; renders a trendline in dimColor with an accent endpoint dot
 * @param {string} [opts.dataTile.footer]      — optional small footer line beneath
 * @param {number} [opts.tileWidth=280]
 * @param {number} [opts.tileHeight=220]
 * @param {number} [opts.tilePadX=24]
 * @param {number} [opts.tilePadY=24]
 * @param {number} [opts.tileEyebrowSize=16]
 * @param {number} [opts.tileEyebrowTrack=2]
 * @param {number} [opts.tileValueSize=56]
 * @param {number} [opts.tileValueTrack=-2]
 * @param {number} [opts.tileFooterSize=14]
 * @param {number} [opts.tileFooterTrack=1]
 * @param {number} [opts.tileSparkHeight=28]
 * @param {number} [opts.tileSparkStroke=2]
 * @param {number} [opts.tileSparkDotR=3]
 * @param {(msg: string) => void} [opts.log]
 */
export async function buildOg(opts) {
  const cfg = { ...DEFAULTS, ...opts };
  const log = cfg.log ?? (m => console.log(m));

  const required = [
    'fontPath', 'outDir',
    'bgColor', 'lineColor', 'textColor', 'dimColor', 'accentColor',
    'eyebrowText', 'wordmarkText', 'taglineText', 'footerLeft', 'footerRight',
  ];
  for (const k of required) {
    if (!cfg[k]) throw new Error(`buildOg: missing required option "${k}"`);
  }

  const absFontPath = path.resolve(cfg.fontPath);
  try { await fs.access(absFontPath); }
  catch { throw new Error(`buildOg: font file not found: ${absFontPath}`); }

  log(`loading font: ${absFontPath}`);
  const font = await opentype.load(absFontPath);

  const allPaths = [];

  const eyebrow = layoutText(
    font, cfg.eyebrowText.toUpperCase(), cfg.eyebrowSize, cfg.eyebrowTrack,
    cfg.padX, cfg.padY + cfg.eyebrowSize, cfg.dimColor,
  );
  allPaths.push(...eyebrow.paths);

  const wordmarkY = cfg.padY + cfg.eyebrowSize + 90;
  const hasPeriod = cfg.wordmarkText.endsWith('.');
  const stemText = hasPeriod ? cfg.wordmarkText.slice(0, -1) : cfg.wordmarkText;
  const stem = layoutText(
    font, stemText, cfg.wordmarkSize, cfg.wordmarkTrack,
    cfg.padX, wordmarkY + cfg.wordmarkSize, cfg.textColor,
  );
  allPaths.push(...stem.paths);
  if (hasPeriod) {
    const period = layoutText(
      font, '.', cfg.wordmarkSize, 0,
      cfg.padX + stem.width, wordmarkY + cfg.wordmarkSize, cfg.accentColor,
    );
    allPaths.push(...period.paths);
  }

  const taglineY = wordmarkY + cfg.wordmarkSize + 40;
  const tagline = layoutText(
    font, cfg.taglineText, cfg.taglineSize, cfg.taglineTrack,
    cfg.padX, taglineY + cfg.taglineSize, cfg.dimColor,
  );
  allPaths.push(...tagline.paths);

  const footerY = cfg.height - cfg.padY;
  const footerLeft = layoutText(
    font, cfg.footerLeft.toUpperCase(), cfg.footerSize, cfg.footerTrack,
    cfg.padX, footerY, cfg.dimColor,
  );
  allPaths.push(...footerLeft.paths);
  const footerRight = layoutRight(
    font, cfg.footerRight.toUpperCase(), cfg.footerSize, cfg.footerTrack,
    cfg.width - cfg.padX, footerY, cfg.accentColor,
  );
  allPaths.push(...footerRight.paths);

  const hairlineY = footerY - cfg.footerSize - 22;

  // Optional dataTile in upper-right. Inherits palette + font; non-text
  // primitives (border, sparkline) collected in `decorations`.
  const decorations = [];
  if (cfg.dataTile) {
    const t = cfg.dataTile;
    if (!t.eyebrow || !t.value) {
      throw new Error('buildOg: dataTile requires both "eyebrow" and "value"');
    }

    const tileX = cfg.width - cfg.padX - cfg.tileWidth;
    const tileY = cfg.padY;
    const innerX = tileX + cfg.tilePadX;
    const innerW = cfg.tileWidth - cfg.tilePadX * 2;

    decorations.push(
      `<rect x="${tileX}" y="${tileY}" width="${cfg.tileWidth}" height="${cfg.tileHeight}" fill="none" stroke="${cfg.lineColor}" stroke-width="1"/>`,
    );

    let cursorY = tileY + cfg.tilePadY + cfg.tileEyebrowSize;
    const tileEyebrow = layoutText(
      font, t.eyebrow.toUpperCase(), cfg.tileEyebrowSize, cfg.tileEyebrowTrack,
      innerX, cursorY, cfg.dimColor,
    );
    allPaths.push(...tileEyebrow.paths);

    cursorY += 18 + cfg.tileValueSize;
    const tileValue = layoutText(
      font, t.value, cfg.tileValueSize, cfg.tileValueTrack,
      innerX, cursorY, cfg.textColor,
    );
    allPaths.push(...tileValue.paths);

    if (Array.isArray(t.sparkline) && t.sparkline.length >= 2) {
      const sparkY = cursorY + 14;
      const min = Math.min(...t.sparkline);
      const max = Math.max(...t.sparkline);
      const range = max - min || 1;
      const usableW = innerW - cfg.tileSparkDotR;
      const step = usableW / (t.sparkline.length - 1);
      const points = t.sparkline.map((v, i) => {
        const px = innerX + i * step;
        const py = sparkY + cfg.tileSparkHeight - ((v - min) / range) * cfg.tileSparkHeight;
        return [px, py];
      });
      const d = points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
      const [endX, endY] = points[points.length - 1];
      decorations.push(
        `<path d="${d}" fill="none" stroke="${cfg.dimColor}" stroke-width="${cfg.tileSparkStroke}" stroke-linecap="round" stroke-linejoin="round"/>`,
        `<circle cx="${endX.toFixed(1)}" cy="${endY.toFixed(1)}" r="${cfg.tileSparkDotR}" fill="${cfg.accentColor}"/>`,
      );
      cursorY = sparkY + cfg.tileSparkHeight;
    }

    if (t.footer) {
      cursorY += 16 + cfg.tileFooterSize;
      const tileFooter = layoutText(
        font, t.footer, cfg.tileFooterSize, cfg.tileFooterTrack,
        innerX, cursorY, cfg.dimColor,
      );
      allPaths.push(...tileFooter.paths);
    }
  }

  const decorationsBlock = decorations.length
    ? '\n' + decorations.map(d => `  ${d}`).join('\n')
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cfg.width}" height="${cfg.height}" viewBox="0 0 ${cfg.width} ${cfg.height}">
  <rect width="${cfg.width}" height="${cfg.height}" fill="${cfg.bgColor}"/>
  <line x1="${cfg.padX}" y1="${hairlineY}" x2="${cfg.width - cfg.padX}" y2="${hairlineY}" stroke="${cfg.lineColor}" stroke-width="1"/>
  <circle cx="${cfg.width - cfg.padX - 6}" cy="${hairlineY}" r="4" fill="${cfg.accentColor}"/>${decorationsBlock}
${allPaths.map(p => `  <path fill="${p.fill}" d="${p.d}"/>`).join('\n')}
</svg>
`;

  const absOutDir = path.resolve(cfg.outDir);
  await fs.mkdir(absOutDir, { recursive: true });

  const svgPath = path.join(absOutDir, 'og.svg');
  await fs.writeFile(svgPath, svg);
  log(`  wrote ${svgPath}`);

  const pngPath = path.join(absOutDir, 'og.png');
  await sharp(Buffer.from(svg)).png().toFile(pngPath);
  log(`  wrote ${pngPath}`);
}
