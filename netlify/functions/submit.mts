import type { Config, Context } from "@netlify/functions";
import { bumpUsage, effectiveAccessCode, loadConfig, usableEntries } from "../lib/config.mts";
import { jobKey, jobStore } from "../lib/store.mts";
import { json, randomId, safeEqual } from "../lib/util.mts";

const MAX_IMAGES = 10;
// Лимит тела синхронной функции около 6 МБ, оставляем запас.
const MAX_TOTAL_CHARS = 5_200_000;
const IMAGE_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Только POST" }, 405);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Кривой запрос" }, 400);
  }

  const cfg = await loadConfig();

  const code = effectiveAccessCode(cfg);
  if (code && !safeEqual(typeof body.code === "string" ? body.code : "", code)) {
    return json({ error: "Неверный код доступа", needCode: true }, 401);
  }

  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length === 0) return json({ error: "Скинь хотя бы один скрин" }, 400);
  if (images.length > MAX_IMAGES) return json({ error: `Максимум ${MAX_IMAGES} картинок (с учётом нарезки)` }, 400);
  let total = 0;
  for (const img of images) {
    if (typeof img !== "string" || !IMAGE_RE.test(img)) return json({ error: "Это не картинка" }, 400);
    total += img.length;
  }
  if (total > MAX_TOTAL_CHARS) return json({ error: "Слишком тяжёлые картинки, скинь поменьше" }, 413);

  if (usableEntries(cfg).length === 0) {
    return json({ error: "Главврач в отпуске: не настроен ни один ключ API. Загляни в /admin." }, 503);
  }

  if (cfg.dailyLimit > 0) {
    const used = await bumpUsage();
    if (used > cfg.dailyLimit) {
      return json({ error: "Дневной лимит приёма исчерпан. Приходи завтра." }, 429);
    }
  }

  const target = typeof body.target === "string" ? body.target.trim().slice(0, 100) : "";
  const note = typeof body.context === "string" ? body.context.trim().slice(0, 600) : "";

  const id = `${Date.now().toString(36)}-${randomId(12)}`;
  const token = randomId(24);
  const store = jobStore(context.deploy);
  await store.setJSON(jobKey(id), {
    status: "queued",
    token,
    createdAt: Date.now(),
    target,
    input: { images, target, context: note },
  });

  // Анализ может идти дольше лимита синхронной функции (max effort думает долго),
  // поэтому отдаём его фоновой функции, а браузер опрашивает /api/result.
  try {
    const res = await fetch(new URL("/.netlify/functions/analyze-background", req.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, token }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error("[durka] не удалось запустить фоновый анализ:", e);
    await store.setJSON(jobKey(id), { status: "error", createdAt: Date.now(), error: "Не удалось запустить анализ" });
    return json({ error: "Не удалось запустить анализ, попробуй ещё раз" }, 502);
  }

  return json({ id }, 202);
};

export const config: Config = {
  path: "/api/submit",
  method: "POST",
  rateLimit: { windowLimit: 8, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
