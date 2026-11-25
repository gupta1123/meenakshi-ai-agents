import test from "node:test";
import assert from "node:assert/strict";
import { runTallyPorts } from "../src/support/tally-ports.mjs";

test("tally ports lists the companies each local Tally listener holds", async () => {
  const probed = [];
  const probe = async (url) => {
    probed.push(url);
    if (url.endsWith(":9000")) return { activeCompany: { name: "A (2026-2027)", guid: "g1" }, availableCompanies: [{ name: "A (2026-2027)", guid: "g1", isActive: true }] };
    if (url.endsWith(":9002")) return { activeCompany: { name: "A (2025-2026)", guid: "g2" }, availableCompanies: [{ name: "A (2025-2026)", guid: "g2", isActive: true }] };
    throw new Error("refused");
  };
  const result = await runTallyPorts({}, { config: { tallyUrl: "http://localhost:9000" } },
    { listeners: async () => ["http://127.0.0.1:9000", "http://127.0.0.1:9002", "http://127.0.0.1:9100"], probe });
  assert.deepEqual(result.ports.map((p) => [p.port, p.reachable, p.tallyProcess]), [[9000, true, true], [9002, true, true], [9100, false, true]]);
  assert.equal(result.ports[1].activeCompany.guid, "g2");
  assert.equal(result.configuredUrl, "http://localhost:9000");
});
