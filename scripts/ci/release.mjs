import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourceRepo = 'nyx-solutions-team/meenakshi-ai-agents';
const targetRepo = 'gupta1123/meenakshi-ai-agents';
const herokuApp = 'meenakshi-ai-agents';
const backendUrl = 'https://meenakshi-ai-agents-d9c2580d84e3.herokuapp.com';
const frontendUrl = 'https://meenakshi-ai-agents.netlify.app';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing Actions secret or environment variable: ${name}`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'could not start'}). See the preceding logs.`);
  return result.stdout?.trim();
}

function gitAuth(host, username, token) {
  // Keep credentials out of URLs, process arguments and saved git config.
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function api(url, token, headers = {}, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Service access check failed (${response.status}) for ${new URL(url).hostname}. Check the token's permissions.`);
  return response.json();
}

async function preflight() {
  for (const name of ['GUPTA_REPO_TOKEN', 'HEROKU_API_KEY', 'NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']) required(name);
  const repo = await api(`https://api.github.com/repos/${targetRepo}`, required('GUPTA_REPO_TOKEN'), {
    Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
  });
  if (repo.full_name !== targetRepo || !repo.permissions?.push) throw new Error(`GUPTA_REPO_TOKEN must have write access to ${targetRepo}.`);
  const site = await api(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(required('NETLIFY_SITE_ID'))}`, required('NETLIFY_AUTH_TOKEN'));
  if (new URL(site.ssl_url || site.url).origin !== frontendUrl) throw new Error(`NETLIFY_SITE_ID must identify ${frontendUrl}, not another site.`);
  const app = await api(`https://api.heroku.com/apps/${herokuApp}`, required('HEROKU_API_KEY'), { Accept: 'application/vnd.heroku+json; version=3' });
  if (app.name !== herokuApp || new URL(app.web_url).origin !== backendUrl) throw new Error('The Heroku token does not identify the expected production app.');
  console.log('GitHub, Heroku and Netlify target checks passed.');
}

function mirror() {
  const sha = required('GITHUB_SHA');
  const env = gitAuth('github.com', 'x-access-token', required('GUPTA_REPO_TOKEN'));
  const remote = `https://github.com/${targetRepo}.git`;
  run('git', ['fetch', '--no-tags', remote, 'refs/heads/main:refs/remotes/gupta-ci/main'], { env });
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', 'refs/remotes/gupta-ci/main', sha]);
  if (ancestor.status !== 0) throw new Error('Gupta main has diverged. Preserve its new changes in Nyx before retrying; the pipeline never force-pushes.');
  run('git', ['push', remote, `${sha}:refs/heads/main`], { env });
  console.log(`Synchronized ${sha} to ${targetRepo}.`);
}

async function backend() {
  const sha = required('GITHUB_SHA');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid source commit.');
  const token = required('HEROKU_API_KEY');
  const base = `https://api.heroku.com/apps/${herokuApp}`;
  const headers = { Accept: 'application/vnd.heroku+json; version=3' };
  const directory = await mkdtemp(join(tmpdir(), 'meenakshi-deploy-'));
  try {
    const archive = join(directory, 'backend.tar.gz');
    run('git', ['archive', '--format=tar.gz', `--output=${archive}`, `${sha}:backend`]);
    const source = await api(`${base}/sources`, token, headers, { method: 'POST' });
    const upload = await fetch(source.source_blob.put_url, {
      method: 'PUT', body: await readFile(archive), signal: AbortSignal.timeout(60_000),
    });
    if (!upload.ok) throw new Error(`Backend source upload failed (${upload.status}).`);
    let build = await api(`${base}/builds`, token, { ...headers, 'Content-Type': 'application/json' }, {
      method: 'POST', body: JSON.stringify({ source_blob: { url: source.source_blob.get_url, version: sha } }),
    });
    console.log(`Heroku build ${build.id} started for ${sha}.`);
    const deadline = Date.now() + 15 * 60_000;
    while (build.status === 'pending' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5_000));
      build = await api(`${base}/builds/${build.id}`, token, headers);
    }
    if (build.output_stream_url) {
      const log = await fetch(build.output_stream_url, { signal: AbortSignal.timeout(30_000) });
      if (log.ok) console.log((await log.text()).replaceAll('\0', ''));
    }
    if (build.status !== 'succeeded' || build.source_blob?.version !== sha || !build.slug?.id) {
      throw new Error(`Heroku build did not succeed for the expected commit (status: ${build.status}).`);
    }
    console.log(`Heroku built and released ${sha}.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function frontend() {
  run('npx', ['--yes', 'netlify-cli@27.1.1', 'deploy', '--build', '--prod', '--site', required('NETLIFY_SITE_ID'), '--context', 'production', '--message', `Nyx ${required('GITHUB_SHA')}`]);
}

async function verify() {
  const apiResponse = await fetch(`${backendUrl}/api/bootstrap`, { signal: AbortSignal.timeout(30_000) });
  if (apiResponse.status !== 401 || (await apiResponse.json()).error !== 'Unauthorized') throw new Error('The production API did not return its expected unauthenticated response.');
  const cors = await fetch(`${backendUrl}/api/bootstrap`, {
    method: 'OPTIONS', headers: { Origin: frontendUrl, 'Access-Control-Request-Method': 'GET' },
    signal: AbortSignal.timeout(30_000),
  });
  if (cors.status !== 204 || cors.headers.get('access-control-allow-origin') !== frontendUrl) throw new Error('Production frontend CORS verification failed.');
  const site = await api(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(required('NETLIFY_SITE_ID'))}`, required('NETLIFY_AUTH_TOKEN'));
  if (site.published_deploy?.state !== 'ready' || site.published_deploy?.title !== `Nyx ${required('GITHUB_SHA')}`) throw new Error('Netlify has not published the expected source commit.');
  const page = await fetch(frontendUrl, { signal: AbortSignal.timeout(30_000) });
  if (!page.ok || new URL(page.url).origin !== frontendUrl) throw new Error('The production frontend is not responding on its expected domain.');
  console.log(`Verified production release of ${required('GITHUB_SHA')}.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `Source: ${sourceRepo}@${required('GITHUB_SHA')}\n\nGupta main synchronized. Backend API and frontend CORS passed. Netlify production deploy is ready.\n\nFrontend: ${frontendUrl}\n\nBackend: ${backendUrl}\n`);
  }
}

try {
  const command = process.argv[2];
  const operations = { preflight, mirror, backend, frontend, verify };
  if (!operations[command]) throw new Error('Expected: preflight, mirror, backend, frontend or verify.');
  if (required('GITHUB_REPOSITORY') !== sourceRepo || required('GITHUB_REF') !== 'refs/heads/main') throw new Error('Production releases must run from Nyx main.');
  await operations[command]();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
