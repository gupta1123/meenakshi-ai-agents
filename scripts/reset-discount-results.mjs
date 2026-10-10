// Operator-only archival reset. The ONLY database write is one audit_events INSERT.
// No result deletion, setting update, outbox enqueue, Tally call or message send.
import { createClient } from '../backend/node_modules/@supabase/supabase-js/dist/index.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const action = 'discount_results_archived';
const [mode = 'inspect', companyId, backupArg] = process.argv.slice(2);
if (!['inspect', 'prepare', 'apply', 'verify'].includes(mode) || !/^[0-9a-f-]{36}$/i.test(companyId ?? '')) {
  throw new Error('Usage: node --env-file=backend/.env.local scripts/reset-discount-results.mjs inspect|prepare|apply|verify COMPANY_ID [BACKUP_DIRECTORY]');
}
const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Database credentials are required; never use frontend credentials.');
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30000) }) } });
const root = resolve('.runtime-logs/result-reset-backups');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function digest(rows) { return createHash('sha256').update(rows.map(row => JSON.stringify(canonical(row))).sort().join('\n')).digest('hex'); }
async function checked(query) { const { data, error } = await query; if (error) throw new Error(error.message); return data; }
async function marker() {
  return checked(db.from('audit_events').select('id,created_at,metadata').eq('company_id', companyId).eq('entity_id', companyId)
    .eq('entity_type', 'company').eq('action', action).order('created_at', { ascending: false }).limit(1).maybeSingle());
}
async function idle() {
  const active = await checked(db.from('evaluation_runs').select('id,status').eq('company_id', companyId).in('status', ['queued', 'refreshing_tally', 'evaluating']).limit(1));
  if (active.length) throw new Error('A calculation is still running. No reset was performed.');
  for (const table of ['credit_note_postings', 'cash_discount_debit_note_postings']) {
    const activeNotes = await checked(db.from(table).select('id,status').eq('company_id', companyId)
      .in('status', table === 'credit_note_postings' ? ['pending_approval', 'queued', 'sending', 'verification_pending', 'cancel_requested'] : ['queued', 'sending']).limit(1));
    if (activeNotes.length) throw new Error('A note is still being processed. No reset was performed.');
  }
  // Local calculations can run without a cloud run; refuse a reset during one.
  const response = await fetch('http://127.0.0.1:3219/v1/progress', { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (response?.ok && (await response.json()).progress) throw new Error('The local connector is calculating. No reset was performed.');
}
const company = await checked(db.from('companies').select('id,organization_id,tally_company_name').eq('id', companyId).single());
async function scopes() {
  const response = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Could not discover backup table scopes.');
  const { definitions } = await response.json();
  const versions = await checked(db.from('scheme_versions').select('id').eq('company_id', companyId));
  const calendars = await checked(db.from('working_calendars').select('id').eq('organization_id', company.organization_id));
  const messages = await checked(db.from('notification_messages').select('id').eq('company_id', companyId));
  const resultNames = new Set(['evaluation_runs', 'discount_proposals', 'proposal_evaluations', 'cash_discount_recovery_candidates']);
  const protectedName = name => /^(scheme|working_calendar|company_)/.test(name)
    || ['companies', 'customers', 'customer_groups', 'customer_contacts', 'customer_contact_consents', 'stock_items', 'stock_groups', 'tally_units', 'tally_vouchers', 'tally_voucher_inventory_lines', 'tally_bill_allocations', 'tally_ledgers', 'tally_voucher_types', 'credit_note_postings', 'credit_note_documents', 'cash_discount_debit_note_postings', 'note_einvoices', 'notification_messages', 'notification_attempts', 'whatsapp_templates', 'tally_connector_company_bindings', 'tod_customer_period_rule_locks', 'reconciliation_issues'].includes(name);
  const list = [];
  for (const [table, definition] of Object.entries(definitions)) {
    const columns = definition.properties ?? {};
    if (!resultNames.has(table) && !protectedName(table)) continue;
    // Counters are updated by connector heartbeats; they are not reset settings.
    if (table === 'company_tally_change_counters') continue;
    let filter;
    if (table === 'companies') filter = ['id', [companyId]];
    else if (columns.company_id) filter = ['company_id', [companyId]];
    else if (columns.scheme_version_id) filter = ['scheme_version_id', versions.map(row => row.id)];
    else if (columns.working_calendar_id) filter = ['working_calendar_id', calendars.map(row => row.id)];
    else if (columns.organization_id) filter = ['organization_id', [company.organization_id]];
    else if (columns.notification_message_id) filter = ['notification_message_id', messages.map(row => row.id)];
    else throw new Error(`No safe company scope for ${table}.`);
    const order = columns.id ? ['id'] : Object.entries(columns).filter(([, column]) => ['string', 'integer', 'number', 'boolean'].includes(column.type)).map(([name]) => name);
    if (!order.length) throw new Error(`No stable backup ordering for ${table}.`);
    list.push({ table, filter, order, result: resultNames.has(table) });
  }
  for (const table of resultNames) if (!list.some(scope => scope.table === table)) throw new Error(`Missing result table ${table}.`);
  return list.sort((a, b) => a.table.localeCompare(b.table));
}
async function load(scope) {
  const rows = [];
  for (let chunk = 0; chunk < scope.filter[1].length; chunk += 100) {
    for (let from = 0; ; from += 500) {
      let query = db.from(scope.table).select('*').in(scope.filter[0], scope.filter[1].slice(chunk, chunk + 100));
      for (const column of scope.order) query = query.order(column);
      const data = await checked(query.range(from, from + 499));
      rows.push(...data);
      if (data.length < 500) break;
    }
  }
  return rows;
}
async function summary() {
  const cutoff = (await marker())?.created_at;
  const counts = {};
  for (const [table, column] of [['evaluation_runs', 'created_at'], ['discount_proposals', 'latest_evaluated_at'], ['cash_discount_recovery_candidates', 'created_at']]) {
    let query = db.from(table).select('id', { count: 'exact', head: true }).eq('company_id', companyId);
    if (cutoff) query = query.gt(column, cutoff);
    if (table === 'cash_discount_recovery_candidates') query = query.eq('current_snapshot', true);
    const { count, error } = await query; if (error) throw error;
    counts[table] = count;
  }
  return { company, cutoff: cutoff ?? null, visibleResultCounts: counts };
}
if (mode === 'inspect') { await idle(); console.log(JSON.stringify(await summary(), null, 2)); }
else if (mode === 'prepare') {
  await idle();
  const directory = join(root, `${companyId}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const manifest = { version: 1, company, project: new URL(url).origin, operationId: randomUUID(), previousResetId: (await marker())?.id ?? null, scopes: [] };
  for (const scope of await scopes()) {
    const data = await load(scope);
    await writeFile(join(directory, `${scope.table}.json.gz`), gzipSync(JSON.stringify(data)), { flag: 'wx' });
    manifest.scopes.push({ ...scope, count: data.length, digest: digest(data) });
    console.log(`Backed up ${scope.table}: ${data.length} rows`);
  }
  await idle();
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ backupDirectory: directory, protectedTables: manifest.scopes.filter(scope => !scope.result).length, ...await summary() }, null, 2));
} else {
  if (!backupArg) throw new Error('A prepared backup directory is required.');
  const directory = resolve(backupArg);
  const backupRelative = relative(root, directory);
  if (backupRelative.startsWith('..') || isAbsolute(backupRelative) || directory === root) throw new Error('Backup must be inside the result-reset backup directory.');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.company.id !== companyId || manifest.company.tally_company_name !== company.tally_company_name || manifest.project !== new URL(url).origin) throw new Error('Backup scope does not match the target company/project.');
  const previousMarker = await marker();
  if (mode === 'apply' && previousMarker?.metadata?.operationId !== manifest.operationId) {
    if ((previousMarker?.id ?? null) !== manifest.previousResetId) throw new Error('A different reset occurred after the backup.');
    await idle();
    for (const scope of manifest.scopes) {
      const backup = JSON.parse(gunzipSync(await readFile(join(directory, `${scope.table}.json.gz`))));
      if (digest(backup) !== scope.digest || digest(await load(scope)) !== scope.digest) throw new Error(`${scope.table} changed since the backup. No reset was performed.`);
    }
    await idle();
    // One append-only audit record. All historical rows remain byte-for-byte unchanged.
    await checked(db.from('audit_events').insert({ organization_id: company.organization_id, company_id: companyId,
      actor_type: 'system', action, entity_type: 'company', entity_id: companyId,
      metadata: { version: 1, schemes: ['cd', 'tod'], operationId: manifest.operationId,
        reason: 'User-approved result-only archive for fresh testing; preserve rules, settings and accounting evidence.',
        backupManifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') } }).select('id,created_at').single());
  }
  const currentMarker = await marker();
  if (currentMarker?.metadata?.operationId !== manifest.operationId) throw new Error('Expected archive marker is missing.');
  const checks = [];
  for (const scope of manifest.scopes) {
    const data = await load(scope);
    checks.push({ table: scope.table, rows: data.length, unchanged: digest(data) === scope.digest });
  }
  console.log(JSON.stringify({ ...await summary(), preservationChecks: checks }, null, 2));
  if (checks.some(check => !check.unchanged)) throw new Error('Some data changed concurrently; inspect preservation checks. No historical rows were changed by this reset script.');
}
