import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage();
const tasks = new Map();
const waitingReads = new Map();
const requests = new Map();
const keyOf = (url) => String(url).replace(/\/+$/, "").toLowerCase();
const isBackgroundCheck = (name) => name === "connection_check" || name === "command_poll";
export const TALLY_BUSY_MESSAGE = "Tally is busy with another check. Wait for it to finish before trying again.";

export function tallyActivity(url) {
  const task = tasks.get(keyOf(url));
  return task ? { name: task.name, activeCompany: task.activeCompany, verifiedAt: task.verifiedAt } : null;
}

// Reserve before the first await (including reading an HTTP request body or
// claiming a cloud command). A second browser/tab/cloud job must not sneak in.
export function tryAcquireTallyTask(url, name, signal) {
  const key = keyOf(url);
  if (tasks.has(key) || waitingReads.has(key)) return null;
  return reserveTask(key, name, signal);
}

function reserveTask(key, name, signal) {
  const task = { key, name, signal, activeCompany: null, verifiedAt: null };
  tasks.set(key, task);
  const release = () => {
    if (tasks.get(key) !== task) return;
    tasks.delete(key);
    // Transfer ownership synchronously: another heartbeat/tab cannot take
    // the lane between the background check and the waiting calculation.
    const waiting = waitingReads.get(key);
    if (waiting) waiting.finish(reserveTask(key, waiting.name, waiting.signal));
  };
  return {
    release,
    setName(name) {
      if (tasks.get(key) !== task) return;
      task.name = name;
      // A poll that claimed a real command is no longer a short check.
      // Never queue a browser calculation behind an accounting/cloud job.
      if (!isBackgroundCheck(name)) waitingReads.get(key)?.finish(null);
    },
    run: async (callback) => {
      try { return await context.run(task, callback); }
      finally { release(); }
    },
  };
}

// Wait only for short background work, never for another calculation. One
// waiting read gets priority, with a finite deadline and browser cancellation.
// This acquires ownership, not a retry of the calculation or its result save.
export async function acquireTallyReadTask(url, name, signal, { waitMs = 15_000 } = {}) {
  signal?.throwIfAborted();
  const key = keyOf(url);
  const immediate = tryAcquireTallyTask(url, name, signal);
  if (immediate) return immediate;
  if (waitingReads.has(key) || !isBackgroundCheck(tasks.get(key)?.name)) return null;
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const onAbort = () => finish(null, signal.reason);
    const finish = (task, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      waitingReads.delete(key);
      if (error !== undefined) reject(error);
      else resolve(task);
    };
    waitingReads.set(key, { name, signal, finish });
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(null), waitMs);
  });
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
