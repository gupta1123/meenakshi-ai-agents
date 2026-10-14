import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../app/api/companies/[companyId]/scheme-versions/[versionId]/tiers/route.ts', import.meta.url), 'utf8');
function handler({ active = false, failed = false } = {}) {
  const filters = [];
  let audited = false;
  const chain = { delete() { return this; }, eq(key, value) { filters.push([key, value]); return this; }, then(resolve) { return Promise.resolve({ error: failed ? new Error('database error') : null }).then(resolve); } };
  const modules = {
    '@/lib/api/cors': { jsonWithCors: (_, body) => Response.json(body), optionsWithCors: () => new Response(null) },
    '@/lib/supabase/admin': { createSupabaseAdminClient: () => ({ from: table => { assert.equal(table, 'scheme_version_tiers'); return chain; } }) },
    '@/lib/rulebook/shared': {
      requireRulebookVersionForCompany: async () => ({ scope: {}, version: { id: 'draft-version', scheme_type: 'tod', status: active ? 'active' : 'draft' } }),
      requireDraftVersion: version => { if (version.status !== 'draft') throw new Error('not a draft'); },
      readRequiredUuid: value => value,
      appendRulebookAudit: async () => { audited = true; },
      rulebookErrorResponse: (_, error) => Response.json({ error: error.message }, { status: 409 }),
      RulebookRequestError: Error,
    },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: name => modules[name] });
  return { run: () => exports.DELETE({ json: async () => ({ tierId: 'tier-id' }) }, { params: Promise.resolve({ companyId: 'company', versionId: 'draft-version' }) }), filters, audited: () => audited };
}
test('DELETE returns a success response after a version-scoped deletion and audit', async () => {
  const check = handler();
  const response = await check.run();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.deepEqual(check.filters, [['id', 'tier-id'], ['scheme_version_id', 'draft-version']]);
  assert.equal(check.audited(), true);
});
test('active rule tiers cannot be deleted', async () => {
  const check = handler({ active: true });
  assert.equal((await check.run()).status, 409);
  assert.deepEqual(check.filters, []);
});
test('failed deletes return an error and do not audit success', async () => {
  const check = handler({ failed: true });
  assert.equal((await check.run()).status, 409);
  assert.equal(check.audited(), false);
});
