#!/usr/bin/env node
// Test frontend GET latencies with real credentials
const SUPABASE_URL = 'https://onjbqvqinbsojdptqixo.supabase.co'
const API_BASE = process.env.API_BASE || 'http://localhost:3001'
const EMAIL = 'meenakshi.api.admin@example.test'
const PASSWORD = 'MeenakshiApiAdminTest!2026'
const PUBLISHABLE = 'sb_publishable_Yu4BHkKaUJa5lZjKz9PWlg_JlRtagHD'

async function login() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  })
  const j = await r.json()
  if (!j.access_token) throw new Error('login failed: ' + JSON.stringify(j))
  return j.access_token
}

async function timedFetch(token, path, opts={}) {
  const url = `${API_BASE}${path}`
  const t0 = performance.now()
  let status = 0, bodyLen = 0, error=null, json=null
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, ...opts })
    status = res.status
    const text = await res.text()
    bodyLen = text.length
    try { json = JSON.parse(text) } catch {}
  } catch(e){ error = String(e) }
  const ms = performance.now() - t0
  return { path, status, ms: Math.round(ms), bodyLen, error, json }
}

async function main(){
  const token = await login()
  console.log('login OK, token len', token.length)

  // bootstrap to get company IDs
  const boot = await timedFetch(token, '/api/bootstrap')
  console.log('bootstrap', boot.status, boot.ms+'ms', JSON.stringify(boot.json)?.slice(0,400))
  const org = boot.json?.organizations?.[0]
  const companyId = org?.companies?.[0]?.id
  const orgId = org?.id
  if (!companyId) throw new Error('no company')

  console.log(`Using org ${orgId} company ${companyId}`)

  // Pre-fetch ids for dynamic GETs
  const ref = await timedFetch(token, `/api/companies/${companyId}/rulebook/reference-data`)
  const overview = await timedFetch(token, `/api/companies/${companyId}/rulebook/overview`)
  const schemes = await timedFetch(token, `/api/companies/${companyId}/schemes`)
  let schemeId=null, versionId=null
  try {
    const sj = schemes.json
    schemeId = sj?.schemes?.[0]?.id || null
    if (schemeId) {
      const sd = await timedFetch(token, `/api/companies/${companyId}/schemes/${schemeId}`)
      versionId = sd.json?.scheme?.versions?.[0]?.id || sd.json?.versions?.[0]?.id || null
    }
    if (!versionId && overview.json?.versions) versionId = overview.json.versions?.[0]?.id || null
  } catch{}

  // get a proposal / run / voucher ids if exist
  const proposalsTod = await timedFetch(token, `/api/companies/${companyId}/evaluations/proposals?schemeType=tod&limit=5`)
  const proposalId = proposalsTod.json?.proposals?.[0]?.id || null
  const runs = await timedFetch(token, `/api/companies/${companyId}/evaluations/runs?schemeType=tod&limit=5`)
  const runId = runs.json?.evaluationRuns?.[0]?.id || runs.json?.runs?.[0]?.id || null
  const contacts = await timedFetch(token, `/api/companies/${companyId}/contacts`)
  const contactId = contacts.json?.contacts?.[0]?.id || null
  const connectors = await timedFetch(token, `/api/connectors?organizationId=${orgId}`)
  const connectorId = connectors.json?.connectors?.[0]?.id || null

  const cases = [
    ['GET /api/bootstrap', '/api/bootstrap'],
    ['GET /api/active-company', `/api/active-company?companyId=${encodeURIComponent(companyId)}`],
    ['GET /api/companies/:id/overview', `/api/companies/${companyId}/overview`],
    ['GET /api/companies/:id/operations/health', `/api/companies/${companyId}/operations/health`],
    ['GET /api/companies/:id/tally-activity', `/api/companies/${companyId}/tally-activity`],
    ['GET /api/companies/:id/tally-health', `/api/companies/${companyId}/tally-health`],
    ['GET /api/companies/:id/operations/detail', `/api/companies/${companyId}/operations/detail?limit=5`],
    ['GET /api/companies/:id/launch-control', `/api/companies/${companyId}/launch-control`],
    ['GET /api/companies/:id/rulebook/reference-data', `/api/companies/${companyId}/rulebook/reference-data`],
    ['GET /api/companies/:id/rulebook/overview', `/api/companies/${companyId}/rulebook/overview`],
    ['GET /api/companies/:id/schemes', `/api/companies/${companyId}/schemes`],
    schemeId ? ['GET /api/companies/:id/schemes/:schemeId', `/api/companies/${companyId}/schemes/${schemeId}`] : null,
    versionId ? ['GET /api/companies/:id/scheme-versions/:versionId', `/api/companies/${companyId}/scheme-versions/${versionId}`] : null,
    ['GET /api/companies/:id/calendars', `/api/companies/${companyId}/calendars`],
    ['GET /api/companies/:id/contacts', `/api/companies/${companyId}/contacts`],
    contactId ? ['GET /api/companies/:id/contacts/:id/opt-ins', `/api/companies/${companyId}/contacts/${contactId}/opt-ins`] : null,
    ['GET /api/companies/:id/evaluations/proposals?schemeType=tod', `/api/companies/${companyId}/evaluations/proposals?schemeType=tod&limit=5`],
    ['GET /api/companies/:id/evaluations/proposals?schemeType=tod&activeOnly', `/api/companies/${companyId}/evaluations/proposals?schemeType=tod&activeOnly=true&limit=5`],
    proposalId ? ['GET /api/companies/:id/evaluations/proposals/:proposalId', `/api/companies/${companyId}/evaluations/proposals/${proposalId}`] : null,
    ['GET /api/companies/:id/evaluations/runs', `/api/companies/${companyId}/evaluations/runs?schemeType=tod&limit=5`],
    runId ? ['GET /api/companies/:id/evaluations/runs/:runId', `/api/companies/${companyId}/evaluations/runs/${runId}`] : null,
    runId ? ['GET /api/companies/:id/evaluations/runs/:runId/results', `/api/companies/${companyId}/evaluations/runs/${runId}/results`] : null,
    ['GET /api/companies/:id/evaluations/cd/local-bootstrap', `/api/companies/${companyId}/evaluations/cd/local-bootstrap`],
    ['GET /api/companies/:id/evaluations/tod/local-bootstrap', `/api/companies/${companyId}/evaluations/tod/local-bootstrap`],
    ['GET /api/companies/:id/vouchers', `/api/companies/${companyId}/vouchers?dateFrom=2025-04-01&dateTo=2025-04-30&voucherKind=sales`],
    ['GET /api/companies/:id/credit-notes', `/api/companies/${companyId}/credit-notes`],
    ['GET /api/companies/:id/cash-discount/recoveries', `/api/companies/${companyId}/cash-discount/recoveries`],
    ['GET /api/companies/:id/notifications', `/api/companies/${companyId}/notifications`],
    ['GET /api/companies/:id/notifications/health', `/api/companies/${companyId}/notifications/health`],
    ['GET /api/companies/:id/notifications/test', `/api/companies/${companyId}/notifications/test`],
    ['GET /api/companies/:id/message-templates', `/api/companies/${companyId}/message-templates`],
    ['GET /api/companies/:id/message-templates?providerCatalog', `/api/companies/${companyId}/message-templates?providerCatalog=true`],
    ['GET /api/connectors?organizationId', `/api/connectors?organizationId=${orgId}`],
    connectorId ? ['GET /api/connectors/:id/tally-companies', `/api/connectors/${connectorId}/tally-companies`] : null,
  ].filter(Boolean)

  console.log(`\nBenchmarking ${cases.length} GETs (3 runs each, median)...\n`)
  const results=[]
  for (const [label, path] of cases) {
    const runs=[]
    for(let i=0;i<3;i++){
      const r = await timedFetch(token, path)
      runs.push(r)
      await new Promise(res=>setTimeout(res, 120))
    }
    runs.sort((a,b)=>a.ms-b.ms)
    const med = runs[1]
    const avg = Math.round(runs.reduce((s,x)=>s+x.ms,0)/runs.length)
    const statuses = runs.map(x=>x.status).join('/')
    results.push({ label, path, medianMs: med.ms, avgMs: avg, statuses, bodyLen: med.bodyLen, ok: med.status>=200 && med.status<300 })
    console.log(`${med.status===200?'✅':'⚠️'} ${String(med.ms).padStart(4)}ms (avg ${avg}ms) [${statuses}] ${label}`)
  }

  // also measure parallel page bundles like workspace-session does
  console.log('\n--- Page bundle timings (Promise.all as frontend does) ---')
  async function bundle(label, paths){
    const t0=performance.now()
    const res = await Promise.all(paths.map(p=>timedFetch(token,p)))
    const ms=Math.round(performance.now()-t0)
    console.log(`${String(ms).padStart(4)}ms ${label} -> ${res.map(r=>r.status).join(',')}`)
    return ms
  }
  await bundle('/ (overview)', [`/api/companies/${companyId}/overview`])
  await bundle('/turnover-discount', [`/api/companies/${companyId}/evaluations/proposals?schemeType=tod&activeOnly=true`, `/api/companies/${companyId}/launch-control`, `/api/companies/${companyId}/rulebook/reference-data`])
  await bundle('/credit-notes', [`/api/companies/${companyId}/evaluations/proposals?schemeType=tod&limit=5`, `/api/companies/${companyId}/credit-notes`, `/api/companies/${companyId}/notifications`, `/api/companies/${companyId}/contacts`, `/api/companies/${companyId}/launch-control`, `/api/companies/${companyId}/rulebook/reference-data`])
  await bundle('/messages', [`/api/companies/${companyId}/notifications`, `/api/companies/${companyId}/notifications/health`, `/api/companies/${companyId}/message-templates`])

  // write markdown report
  const md = `# Frontend GET Latency Report
Generated: ${new Date().toISOString()}
API base: ${API_BASE}
Org: ${orgId} | Company: ${companyId} (${org?.companies?.[0]?.tally_company_name})
User: ${EMAIL} (administrator)
Runs: 3 per endpoint, median reported. Cache: cold (120ms gap between runs, no frontend readCache here).

| Status | Median | Avg | Path |
|---|---|---|---|
${results.map(r=>`| ${r.ok?'✅':'⚠️ '+r.statuses} | ${r.medianMs}ms | ${r.avgMs}ms | \`${r.label}\` \`${r.path}\` |`).join('\n')}

### Notes
- All calls authenticated with Supabase JWT \`Authorization: Bearer <token>\`.
- Dynamic IDs: schemeId=${schemeId||'none'}, versionId=${versionId||'none'}, proposalId=${proposalId||'none'}, runId=${runId||'none'}, contactId=${contactId||'none'}, connectorId=${connectorId||'none'}. Some endpoints skipped when no fixture exists.
- Backend: Next.js 15 Turbopack on localhost:3001 (pid 19676 at test time). Supabase: ${SUPABASE_URL}.
`
  await import('fs').then(m=>m.writeFileSync('docs/frontend-get-latency-report.md', md))
  console.log('\nWrote docs/frontend-get-latency-report.md')
}
main().catch(e=>{ console.error(e); process.exit(1)})
