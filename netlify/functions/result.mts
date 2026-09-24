import type { Config, Context } from "@netlify/functions";
import { JOB_ID_RE, jobKey, jobStore } from "../lib/store.mts";
import { json } from "../lib/util.mts";

// Фоновая функция не переживёт 15 минут. Если задание висит дольше, оно умерло.
const STALE_MS = 16 * 60 * 1000;

export default async (req: Request, context: Context) => {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!JOB_ID_RE.test(id)) return json({ error: "Кривой номер карты" }, 400);

  const job = (await jobStore(context.deploy).get(jobKey(id), { type: "json" })) as Record<string, unknown> | null;
  if (!job) return json({ error: "Карта пациента не найдена" }, 404);

  const { token: _t, input: _i, ...view } = job;
  const since = Number(job.startedAt ?? job.createdAt) || 0;
  if ((job.status === "queued" || job.status === "running") && Date.now() - since > STALE_MS) {
    return json({ ...view, status: "error", error: "Врач уснул на приёме (таймаут). Попробуй ещё раз." });
  }
  return json(view);
};

export const config: Config = {
  path: "/api/result",
  method: "GET",
};
