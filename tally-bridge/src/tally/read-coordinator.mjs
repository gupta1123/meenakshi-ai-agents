import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage();
const tasks = new Map();
const requests = new Map();
const keyOf = (url) => String(url).replace(/\/+$/, "").toLowerCase();
export const TALLY_BUSY_MESSAGE = "Tally is busy with another check. Wait for it to finish before trying again.";

export function tallyActivity(url) {
  const task = tasks.get(keyOf(url));
  return task ? { name: task.name, activeCompany: task.activeCompany, verifiedAt: task.verifiedAt } : null;
}

// Reserve before the first await (including reading an HTTP request body or
// claiming a cloud command). A second browser/tab/cloud job must not sneak in.
export function tryAcquireTallyTask(url, name, signal) {
  const key = keyOf(url);
  if (tasks.has(key)) return null;
  const task = { key, name, signal, activeCompany: null, verifiedAt: null };
  tasks.set(key, task);
  const release = () => { if (tasks.get(key) === task) tasks.delete(key); };
  return {
    release,
    run: async (callback) => {
      try { return await context.run(task, callback); }
      finally { release(); }
    },
  };
}

export function recordVerifiedCompany(url, company) {
  const task = context.getStore();
  if (task?.key === keyOf(url)) {
    task.activeCompany = { name: company.name, guid: company.guid };
    task.verifiedAt = new Date().toISOString();
  }
}

export function tallyTaskSignal(url) {
  const task = context.getStore();
  return task?.key === keyOf(url) ? task.signal : undefined;
}

// All XML calls share one lane, including probes made outside a task. The
// HTTP timeout starts INSIDE callback, not while another export owns the lane.
export async function serializeTallyRequest(url, callback, signal) {
  const key = keyOf(url);
  const previous = requests.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => {
    signal?.throwIfAborted();
    return callback();
  });
  requests.set(key, next);
  try { return await next; }
  finally { if (requests.get(key) === next) requests.delete(key); }
}

// A busy export is not a failed connection probe. These are explicitly cached
// observations, just like cloud-command lease heartbeats, never a fresh proof
// for a new accounting action. Every task re-verifies the active company.
export function busyTallySnapshot(activity, previous) {
  const activeCompany = activity?.activeCompany ?? (previous?.companyLoaded ? previous.activeCompany : null);
  return {
    tallyBusy: true,
    companySnapshotFresh: false,
    tallyReachable: Boolean(activeCompany),
    companyLoaded: Boolean(activeCompany),
    activeCompany,
    availableCompanies: activeCompany ? [{ ...activeCompany, isActive: true }] : [],
    error: activeCompany ? null : TALLY_BUSY_MESSAGE,
  };
}
