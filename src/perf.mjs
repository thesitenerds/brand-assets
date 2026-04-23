import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * @param {string[]} argv - process.argv.slice(2)
 * @param {{ url?: string, runs?: number, mode?: string, chromePath?: string }} [defaults]
 * @returns {{ url: string, runs: number, mode: string, chromePath: string }}
 */
export function parsePerfArgs(argv, defaults = {}) {
  const options = {
    url: defaults.url ?? 'http://localhost:8080',
    runs: defaults.runs ?? 3,
    mode: defaults.mode ?? 'desktop',
    chromePath: defaults.chromePath ?? process.env.CHROME_PATH ?? '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') options.url = argv[++i];
    else if (arg === '--runs') options.runs = Number.parseInt(argv[++i], 10);
    else if (arg === '--mode') options.mode = argv[++i];
    else if (arg === '--chrome-path') options.chromePath = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: node scripts/perf.mjs [--url http://localhost:8080] [--runs 3] [--mode desktop|mobile] [--chrome-path /path/to/chrome]');
      process.exit(0);
    }
  }

  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error(`invalid --runs value: ${options.runs}`);
  }
  if (!['desktop', 'mobile'].includes(options.mode)) {
    throw new Error(`invalid --mode value: ${options.mode}`);
  }

  return options;
}

function pickMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function formatMs(value) {
  return `${(value / 1000).toFixed(2)}s`;
}

function formatScore(value) {
  return `${Math.round(value * 100)}`;
}

function formatCls(value) {
  return value.toFixed(3);
}

async function runLighthouseOnce({ url, mode, runIndex, outputDir, chromePath, cwd }) {
  const outputPath = path.join(outputDir, `${mode}-run-${runIndex}.json`);
  const args = [
    'exec',
    'lighthouse',
    url,
    '--only-categories=performance',
    ...(mode === 'desktop' ? ['--preset=desktop'] : []),
    '--throttling-method=simulate',
    `--throttling.cpuSlowdownMultiplier=${mode === 'desktop' ? 1 : 4}`,
    `--throttling.requestLatencyMs=${mode === 'desktop' ? 40 : 150}`,
    `--throttling.downloadThroughputKbps=${mode === 'desktop' ? 10240 : 1638.4}`,
    `--throttling.uploadThroughputKbps=${mode === 'desktop' ? 10240 : 675}`,
    '--screenEmulation.width=1440',
    '--screenEmulation.height=900',
    '--screenEmulation.mobile=false',
    '--output=json',
    `--output-path=${outputPath}`,
    '--chrome-flags=--headless=new --disable-dev-shm-usage --no-sandbox',
    '--quiet',
  ];

  if (mode === 'mobile') {
    args.splice(args.indexOf('--screenEmulation.mobile=false'), 1, '--screenEmulation.mobile=true');
    args.splice(args.indexOf('--screenEmulation.width=1440'), 2, '--screenEmulation.width=390', '--screenEmulation.height=844');
    args.push('--screenEmulation.deviceScaleFactor=1.75');
  }

  if (chromePath) {
    args.push(`--chrome-path=${chromePath}`);
  }

  try {
    await execFileAsync('pnpm', args, { cwd, maxBuffer: 1024 * 1024 * 10 });
  } catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    if (detail.includes('No Chrome installations found')) {
      throw new Error('lighthouse could not find Chrome or Chromium. Install one locally or rerun with CHROME_PATH=/path/to/chrome.');
    }
    throw new Error(`lighthouse run ${runIndex} failed:\n${detail}`);
  }

  const report = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  const audits = report.audits;
  return {
    score: report.categories.performance.score,
    fcp: audits['first-contentful-paint'].numericValue,
    si: audits['speed-index'].numericValue,
    lcp: audits['largest-contentful-paint'].numericValue,
    tbt: audits['total-blocking-time'].numericValue,
    cls: audits['cumulative-layout-shift'].numericValue,
    path: outputPath,
  };
}

/**
 * Run Lighthouse N times and print median performance metrics.
 * Requires `lighthouse` to be installed in the consumer project (`pnpm add -D lighthouse`).
 *
 * @param {{ url: string, runs?: number, mode?: 'desktop'|'mobile', chromePath?: string, outputDir: string, cwd?: string, log?: (...args: any[]) => void }} opts
 * @returns {Promise<{ score: number, fcp: number, si: number, lcp: number, tbt: number, cls: number }>}
 */
export async function runPerf({
  url,
  runs = 3,
  mode = 'desktop',
  chromePath = '',
  outputDir,
  cwd = process.cwd(),
  log = console.log,
}) {
  if (!url) throw new Error('url is required');
  if (!outputDir) throw new Error('outputDir is required');

  const runOutputDir = path.join(outputDir, `${mode}-${Date.now()}`);
  await fs.mkdir(runOutputDir, { recursive: true });

  const runResults = [];
  for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
    log(`Running Lighthouse ${runIndex}/${runs} against ${url} (${mode})...`);
    runResults.push(await runLighthouseOnce({ url, mode, runIndex, outputDir: runOutputDir, chromePath, cwd }));
  }

  const summary = {
    score: pickMedian(runResults.map((r) => r.score)),
    fcp: pickMedian(runResults.map((r) => r.fcp)),
    si: pickMedian(runResults.map((r) => r.si)),
    lcp: pickMedian(runResults.map((r) => r.lcp)),
    tbt: pickMedian(runResults.map((r) => r.tbt)),
    cls: pickMedian(runResults.map((r) => r.cls)),
  };

  log('');
  log(`Median of ${runs} run(s) for ${url}`);
  log(`Mode  ${mode}`);
  log(`Score ${formatScore(summary.score)}`);
  log(`FCP   ${formatMs(summary.fcp)}`);
  log(`SI    ${formatMs(summary.si)}`);
  log(`LCP   ${formatMs(summary.lcp)}`);
  log(`TBT   ${Math.round(summary.tbt)}ms`);
  log(`CLS   ${formatCls(summary.cls)}`);
  log(`Raw reports saved to ${path.relative(cwd, runOutputDir)}`);

  return summary;
}
