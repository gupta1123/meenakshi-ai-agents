import { loadApplication } from "./release-loader.mjs";
await loadApplication("worker", import.meta.url);
