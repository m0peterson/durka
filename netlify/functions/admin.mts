import type { Config } from "@netlify/functions";
import {
  adminView,
  allSecrets,
  baseUrlFor,
  loadConfig,
  normalizeChain,
  PROVIDER_IDS,
  readUsage,
  resolveKey,
  saveConfig,
  validBaseUrl,
  type ProviderId,
  type StoredConfig,
} from "../lib/config.mts";
import { callModel } from "../lib/llm.mts";
import { errorText, json, safeEqual, scrub } from "../lib/util.mts";

const MIN_PASSWORD = 10;

function checkAuth(req: Request): Response | null {
  const expected = Netlify.env.get("ADMIN_PASSWORD") ?? "";
  if (!expected) {
    return json({ error: "Админка выключена: задай переменную окружения ADMIN_PASSWORD в настройках Netlify и передеплой." }, 503);
  }
  if (expected.length < MIN_PASSWORD) {
    return json({ error: `ADMIN_PASSWORD слишком короткий, нужно минимум ${MIN_PASSWORD} символов.` }, 503);
  }
  // Пароль приходит в base64(UTF-8), чтобы кириллица не ломала заголовок.
  const header = req.headers.get("x-admin-auth") ?? "";
  let given = "";
  try {
    given = Buffer.from(header, "base64").toString("utf8");
  } catch {
    given = "";
  }
  if (!safeEqual(given, expected)) return json({ error: "Неверный пароль" }, 401);
  return null;
}

async function view(cfg: StoredConfig) {
  return { ...adminView(cfg), usageToday: await readUsage() };
}

async function save(cfg: StoredConfig, body: Record<string, unknown>): Promise<Response> {
  const next: StoredConfig = { ...cfg, keys: { ...cfg.keys } };

  if (body.chain !== undefined) {
    const chain = normalizeChain(body.chain);
    if (!chain || chain.length === 0) return json({ error: "Цепочка моделей не может быть пустой" }, 400);
    next.chain = chain;
  }

  if (typeof body.customBaseUrl === "string") {
    const url = body.customBaseUrl.trim().replace(/\/+$/, "");
    if (url && !validBaseUrl(url)) return json({ error: "Адрес своего провайдера должен начинаться с https://" }, 400);
    if (url !== cfg.customBaseUrl) {
      // Сменился адрес: старый ключ туда не отправляем, пусть введут заново.
      delete next.keys.custom;
    }
    next.customBaseUrl = url;
  }

  if (typeof body.accessCode === "string") next.accessCode = body.accessCode.trim().slice(0, 100);
  if (body.dailyLimit !== undefined) {
    const n = Math.round(Number(body.dailyLimit));
    if (!Number.isFinite(n) || n < 0) return json({ error: "Лимит должен быть числом от 0" }, 400);
    next.dailyLimit = Math.min(n, 100000);
  }
  if (body.timeoutSec !== undefined) {
    const n = Math.round(Number(body.timeoutSec));
    if (!Number.isFinite(n) || n < 30 || n > 840) return json({ error: "Таймаут от 30 до 840 секунд" }, 400);
    next.timeoutSec = n;
  }

  if (body.keys && typeof body.keys === "object") {
    for (const [p, v] of Object.entries(body.keys as Record<string, unknown>)) {
      if (!(PROVIDER_IDS as string[]).includes(p)) continue;
      const provider = p as ProviderId;
      if (v === null) {
        delete next.keys[provider];
      } else if (typeof v === "string" && v.trim()) {
        const key = v.trim();
        if (!/^\S{8,500}$/.test(key)) return json({ error: `Ключ ${provider} выглядит битым` }, 400);
        next.keys[provider] = key;
      }
    }
  }

  await saveConfig(next);
  return json(await view(next));
}

async function test(cfg: StoredConfig, body: Record<string, unknown>, origin: string): Promise<Response> {
  const [entry] = normalizeChain([body.entry]) ?? [];
  if (!entry) return json({ error: "Кривая строка цепочки" }, 400);
  const { key } = resolveKey(cfg, entry.provider);
  const baseUrl = baseUrlFor(cfg, entry.provider);
  if (!key) return json({ ok: false, error: "Нет ключа для этого провайдера" });
  if (!baseUrl) return json({ ok: false, error: "Не задан адрес своего провайдера" });

  const t0 = Date.now();
  try {
    const r = await callModel(
      entry,
      key,
      baseUrl,
      [{ role: "user", content: "Ответь одним словом: работает" }],
      25_000,
      origin,
    );
    return json({ ok: true, ms: Date.now() - t0, model: r.servedModel, reply: r.text.slice(0, 200) });
  } catch (e) {
    const msg = scrub(errorText(e), allSecrets(cfg)).slice(0, 400);
    const hint = msg === "таймаут" && entry.effort ? " (на высоком effort это бывает, проверь с low)" : "";
    return json({ ok: false, ms: Date.now() - t0, error: msg + hint });
  }
}

export default async (req: Request) => {
  const denied = checkAuth(req);
  if (denied) return denied;

  const cfg = await loadConfig();
  if (req.method === "GET") return json(await view(cfg));
  if (req.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Кривой запрос" }, 400);
  }
  if (body.action === "save") return save(cfg, body);
  if (body.action === "test") return test(cfg, body, new URL(req.url).origin);
  return json({ error: "Неизвестное действие" }, 400);
};

export const config: Config = {
  path: "/api/admin",
  method: ["GET", "POST"],
  // Заодно защищает от перебора пароля.
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
