import type { Context } from "@netlify/functions";
import { loadConfig, PROVIDERS } from "../lib/config.mts";
import { ChainError, runChain, type JobInput } from "../lib/llm.mts";
import { parseVerdict } from "../lib/prompt.mts";
import { JOB_ID_RE, jobKey, jobStore } from "../lib/store.mts";
import { errorText, safeEqual } from "../lib/util.mts";

// Фоновая функция живёт до 15 минут. Оставляем минуту запаса на запись результата.
const BUDGET_MS = 14 * 60 * 1000;

export default async (req: Request, context: Context) => {
  const started = Date.now();
  let body: { id?: unknown; token?: unknown };
  try {
    body = await req.json();
  } catch {
    return;
  }
  const id = typeof body.id === "string" ? body.id : "";
  const token = typeof body.token === "string" ? body.token : "";
  if (!JOB_ID_RE.test(id) || !token) return;

  const store = jobStore(context.deploy);
  const key = jobKey(id);
  const current = await store.getWithMetadata(key, { type: "json" });
  const job = current?.data as { status?: string; token?: string; createdAt?: number; target?: string; input?: JobInput } | undefined;
  if (!current || !job || job.status !== "queued" || !job.token || !job.input || !safeEqual(token, job.token)) return;

  const base = { createdAt: job.createdAt ?? started, target: job.target ?? "", startedAt: started };
  // Захватываем задание атомарно: если кто-то дёрнет функцию повторно, второй запуск отвалится.
  // Картинки и токен из записи убираем сразу, в памяти они уже есть.
  const claim = await store.setJSON(key, { ...base, status: "running", stage: "Готовим палату" }, { onlyIfMatch: current.etag });
  if (!claim.modified) return;

  const input = job.input;
  const referer = new URL(req.url).origin;

  try {
    const cfg = await loadConfig();
    const result = await runChain(cfg, input, started + BUDGET_MS, referer, async (entry, index) => {
      const who = `${PROVIDERS[entry.provider].label} · ${entry.model}${entry.effort ? ` (${entry.effort})` : ""}`;
      const stage = index === 0 ? `Осматривает ${who}` : `Предыдущий врач сбежал, зовём дежурного: ${who}`;
      await store.setJSON(key, { ...base, status: "running", stage });
    });
    await store.setJSON(key, {
      ...base,
      status: "done",
      finishedAt: Date.now(),
      result: parseVerdict(result.text),
      doctor: {
        provider: PROVIDERS[result.entry.provider].label,
        model: result.servedModel,
        effort: result.entry.effort,
      },
      attempts: result.attempts,
    });
  } catch (e) {
    const attempts = e instanceof ChainError ? e.attempts : [];
    const message = e instanceof ChainError ? e.message : `Внутренняя ошибка: ${errorText(e).slice(0, 200)}`;
    console.error("[durka] анализ провалился:", message, JSON.stringify(attempts));
    await store.setJSON(key, { ...base, status: "error", finishedAt: Date.now(), error: message, attempts });
  }
};
