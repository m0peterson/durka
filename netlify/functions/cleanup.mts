import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { configStore } from "../lib/store.mts";

const DAY = 24 * 60 * 60 * 1000;

// Раз в сутки выкидываем старые задания (там могут остаться скрины) и старые счётчики.
export default async () => {
  const jobs = getStore({ name: "durka-jobs", consistency: "strong" });
  const now = Date.now();
  let removed = 0;
  const { blobs } = await jobs.list({ prefix: "job/" });
  for (const { key } of blobs) {
    const created = parseInt(key.slice(4).split("-")[0] ?? "", 36);
    if (!Number.isFinite(created) || now - created > DAY) {
      await jobs.delete(key);
      removed++;
    }
  }

  const cfg = configStore();
  const cutoff = new Date(now - 30 * DAY).toISOString().slice(0, 10);
  const { blobs: usage } = await cfg.list({ prefix: "usage/" });
  for (const { key } of usage) {
    if (key.slice(6) < cutoff) await cfg.delete(key);
  }
  console.log(`[durka] cleanup: удалено заданий ${removed}`);
};

export const config: Config = {
  schedule: "@daily",
};
