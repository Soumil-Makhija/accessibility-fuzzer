import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { audit } from '../src/audit.js';

let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
});
after(async () => { await browser?.close(); });

async function fixture(name, callback) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(new URL(`../fixtures/${name}`, import.meta.url).href);
    return await callback(page);
  } finally {
    await context.close();
  }
}

test('ordinary document wrapping is not a focus trap; names come from Chromium AX', async () => {
  await fixture('accessible.html', async (page) => {
    const report = await audit(page, { steps: 24, settleMs: 0 });
    assert.equal(report.findings.filter((finding) => finding.type === 'suspected-focus-trap').length, 0);
    assert.equal(report.findings.filter((finding) => finding.type === 'unlabeled-control').length, 0);
    assert.equal(report.findings.length, 0);
    const name = report.traces.forward.find((step) => step.domId === 'name');
    assert.equal(name.role, 'textbox');
    assert.equal(name.name, 'Name');
    assert.equal(name.axStatus, 'exposed');
    assert.equal(name.simulatedAnnouncement, 'textbox: Name');
    assert.equal(report.scope.actualScreenReader, false);
    assert.deepEqual(report.coverage.sampledSteps, { forward: 24, reverse: 24 });
    assert.ok(report.traces.forward.some((step) => step.tag === 'body'));
    assert.ok(!JSON.stringify(report).includes('undefined'));
    assert.ok(!report.traces.forward.some((step) => step.domId === 'disabled' || step.domId === 'hidden'));
  });
});

test('detects real repeating focus, empty AX names and click-only control', async () => {
  await fixture('broken.html', async (page) => {
    const report = await audit(page, { steps: 20, settleMs: 0 });
    const unnamed = report.findings.filter((finding) => finding.type === 'unlabeled-control');
    assert.deepEqual(unnamed.map((finding) => finding.evidence.domId).sort(), ['unnamed', 'unnamed-input']);
    const clickOnly = report.findings.find((finding) => finding.type === 'unreached-control' && finding.evidence.domId === 'click-only');
    assert.ok(clickOnly);
    assert.equal(clickOnly.evidence.name, 'Click-only action');
    const traps = report.findings.filter((finding) => finding.type === 'suspected-focus-trap');
    assert.equal(traps.length, 1);
    assert.ok(traps[0].evidence.probes.length >= 1);
    for (const probe of traps[0].evidence.probes) {
      assert.equal(probe.cycle.subset.length, 2);
      assert.equal(probe.recovered, false);
      assert.ok(probe.cycle.outside.length > 0);
    }
    // The audit must never click the candidate's handler.
    assert.equal(await page.locator('#click-only').getAttribute('data-clicked'), null);
    assert.ok(report.traces.reverse.some((step) => step.domId === 'outside'));
  });
});

test('Escape-recoverable modal does not produce a trap finding', async () => {
  await fixture('modal-escape.html', async (page) => {
    const report = await audit(page, { steps: 20, settleMs: 0 });
    assert.equal(report.findings.filter((finding) => finding.type === 'suspected-focus-trap').length, 0);
    assert.equal(report.findings.length, 0);
    assert.ok(!report.findings.some((finding) => finding.type === 'unreached-control' && finding.evidence.domId?.startsWith('outside-')));
    assert.equal(report.coverage.nativeModalInertCandidateCount, 2);
    assert.ok(report.escapeProbes.length > 0);
    assert.ok(report.escapeProbes.every((probe) => probe.recovered));
  });
});

test('small traversal bounds do not imply complete reachability', async () => {
  await fixture('accessible.html', async (page) => {
    const report = await audit(page, { steps: 1, settleMs: 0 });
    assert.equal(report.coverage.bounded, true);
    assert.ok(report.findings.some((finding) => finding.type === 'unreached-control'));
    assert.equal(report.findings.filter((finding) => finding.type === 'suspected-focus-trap').length, 0);
  });
});

test('rejects invalid traversal options before page mutation', async () => {
  for (const options of [{ steps: 0 }, { steps: 201 }, { steps: 1.5 }, { settleMs: -1 }, { settleMs: 1001 }]) {
    await assert.rejects(audit(null, options), RangeError);
  }
});
