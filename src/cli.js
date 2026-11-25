#!/usr/bin/env node
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { audit } from './audit.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function parseArgs(args) {
  const options = { steps: 30 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') { options.help = true; continue; }
    if (!['--url', '--fixture', '--steps', '--output'].includes(arg) || !args[i + 1]) throw new Error(`Unknown or incomplete option: ${arg}`);
    const value = args[++i];
    if (arg === '--steps') {
      if (!/^\d+$/.test(value) || +value < 1 || +value > 200) throw new Error('Steps must be an integer from 1 to 200');
      options.steps = +value;
    } else options[arg.slice(2)] = value;
  }
  if (options.help) return options;
  if (Boolean(options.url) === Boolean(options.fixture)) throw new Error('Choose exactly one --url or --fixture');
  if (options.fixture && !['accessible', 'broken', 'modal-escape'].includes(options.fixture)) throw new Error('Unknown fixture');
  if (options.url) {
    const url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Only local http(s) URLs on localhost, 127.0.0.1 or [::1] are supported');
    options.url = url.href;
  }
  return options;
}

export async function main(args, stdout = process.stdout, stderr = process.stderr) {
  let browser, context, server, timer;
  try {
    const options = parseArgs(args);
    if (options.help) {
      stdout.write('Usage: keyboard-audit (--fixture accessible|broken|modal-escape | --url http://localhost:PORT) [--steps 1..200] [--output report.json]\nUses real Tab/Shift+Tab and browser accessibility evidence; no real screen reader.\nExit: 0 no findings in this sample; 1 findings; 2 configuration/runtime error.\n');
      return 0;
    }
    let url = options.url;
    if (options.fixture) {
      const html = await readFile(resolve(root, 'fixtures', `${options.fixture}.html`));
      server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); });
      await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
      url = `http://127.0.0.1:${server.address().port}/`;
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, timeout: 15000 });
    context = await browser.newContext({ serviceWorkers: 'block' });
    const origin = new URL(url).origin;
    await context.route('**/*', route => {
      const request = route.request();
      return new URL(request.url()).origin === origin ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(10000);
    await page.goto(url, { waitUntil: 'load' });
    const report = await Promise.race([
      audit(page, { steps: options.steps, settleMs: 20 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Audit exceeded 60-second limit')), 60000); }),
    ]);
    if (options.fixture) report.fixture = options.fixture;
    const json = JSON.stringify(report, null, 2) + '\n';
    if (options.output) await writeFile(options.output, json, 'utf8');
    stdout.write(json);
    return report.findings.length ? 1 : 0;
  } catch (error) {
    stderr.write(`keyboard-audit: ${error.message}\n`);
    return 2;
  } finally {
    clearTimeout(timer);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (server) await new Promise(done => server.close(done));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
