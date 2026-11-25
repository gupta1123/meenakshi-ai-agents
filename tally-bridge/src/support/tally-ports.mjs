// Read-only support check: which Tally listeners the server has, and which
// companies each one holds. It sends only the two tiny "which company" reads
// Tally answers instantly, so it is safe while people are working in Tally.
import { localTallyUrls } from "../tally/local-instances.mjs";
import { probeTallyCompanies } from "../tally/company-probe.mjs";

const EXTRA_PORTS = [9000, 9001, 9002, 9003, 9004, 9005];

export async function runTallyPorts(_input, context, deps = {}) {
  const listeners = await (deps.listeners ?? localTallyUrls)().catch(() => []);
  const urls = [...new Set([...listeners, ...EXTRA_PORTS.map((port) => `http://127.0.0.1:${port}`)])];
  const probe = deps.probe ?? probeTallyCompanies;
  const ports = [];
  for (const url of urls) {
    if (context.isCancelled?.()) throw new Error("Port check stopped.");
    const port = Number(new URL(url).port);
    const tallyProcess = listeners.includes(url);
    try {
      const snapshot = await probe(url, { timeoutMs: 4000, redirect: "error" });
      ports.push({
        port, tallyProcess, reachable: true,
        activeCompany: snapshot.activeCompany,
        companies: snapshot.availableCompanies.map(({ name, guid }) => ({ name, guid })),
      });
    } catch (error) {
      // A port nobody answers on is only interesting when a Tally process owns it.
      if (tallyProcess) ports.push({ port, tallyProcess, reachable: false, error: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return { type: "tally_ports", configuredUrl: context.config?.tallyUrl ?? null, ports };
}
