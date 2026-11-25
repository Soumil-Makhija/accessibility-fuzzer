import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, main } from '../src/cli.js';

test('CLI scope and bounds reject mistaken targets and incomplete options', () => {
  for (const args of [[], ['--fixture'], ['--fixture', '../private'], ['--url', 'file:///etc/passwd'], ['--url', 'https://example.com'], ['--url', 'http://localhost.evil.test'], ['--url', 'http://user:secret@localhost'], ['--url', 'http://localhost', '--fixture', 'broken'], ['--fixture', 'broken', '--steps', '0'], ['--fixture', 'broken', '--steps', '201'], ['--fixture', 'broken', '--steps', '1.1']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['--url', 'http://[::1]:3000', '--steps', '12']).steps, 12);
  assert.equal(parseArgs(['--fixture', 'broken']).fixture, 'broken');
});

test('help and bad options exit without opening a browser', async () => {
  let output = '', error = '';
  const out = { write: value => { output += value; } }, err = { write: value => { error += value; } };
  assert.equal(await main(['--help'], out, err), 0);
  assert.match(output, /no real screen reader/);
  assert.equal(await main(['--bad'], out, err), 2);
  assert.match(error, /Unknown/);
});
