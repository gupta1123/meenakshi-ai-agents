import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resultIsVisible, visibleResults } from './result-visibility.ts';

test('without a reset existing results are unchanged', () => {
  assert.equal(resultIsVisible(null, null), true);
  const query = { gt() { throw new Error('must not filter before reset'); } };
  assert.equal(visibleResults(query, null, 'created_at'), query);
});
test('reset excludes old, equal and undated results, but allows new calculations', () => {
  const cutoff = '2026-10-10T06:00:00Z';
  for (const timestamp of [null, 'invalid', '2026-10-10T05:59:59Z', cutoff]) assert.equal(resultIsVisible(timestamp, cutoff), false);
  assert.equal(resultIsVisible('2026-10-10T06:00:01Z', cutoff), true);
});
test('filter is applied before pagination on the supplied evidence timestamp, not a posting update', () => {
  const calls = [];
  const query = { gt(column, cutoff) { calls.push([column, cutoff]); return this; } };
  assert.equal(visibleResults(query, '2026-10-10T06:00:00Z', 'latest_evaluated_at'), query);
  assert.deepEqual(calls, [['latest_evaluated_at', '2026-10-10T06:00:00Z']]);
});

test('operator reset only appends an audit marker and never deletes, updates or enqueues', () => {
  const source = readFileSync(new URL('../../../../scripts/reset-discount-results.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/\.insert\(/g) ?? []).length, 1);
  assert.match(source, /db\.from\('audit_events'\)\.insert\(/);
  // Crypto's .update hashes backup data; it is not a database mutation.
  const databaseSource = source.replace(/createHash\('sha256'\)\.update\(/g, 'hash(');
  assert.doesNotMatch(databaseSource, /\.(delete|update|upsert|rpc)\(/);
  assert.doesNotMatch(source, /fetch\([^;]+method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
  assert.match(source, /digest\(await load\(scope\)\) !== scope\.digest/);
  assert.match(source, /previousResetId/);
});
