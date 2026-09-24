import {
  allSecrets,
  baseUrlFor,
  resolveKey,
  type ChainEntry,
  type ProviderId,
  type StoredConfig,
} from "./config.mts";
import { buildUserText, SYSTEM_PROMPT } from "./prompt.mts";
import { errorText, scrub } from "./util.mts";

export interface JobInput {
  images: string[];
  target: string;
  context: string;
}

export interface Attempt {
  provider: ProviderId;
  model: string;
  effort: string;
  status: "ok" | "error" | "skipped";
  ms: number;
  error?: string;
}

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: string } };
type Message = { role: "system" | "user"; content: string | ContentPart[] };

export function buildMessages(input: JobInput, provider: ProviderId): Message[] {
  const images: ContentPart[] = input.images.map((url) => ({
    type: "image_url",
    // detail: "high" нужен OpenAI-моделям, чтобы мелкий текст скринов не превращался в кашу.
    image_url: provider === "openrouter" ? { url, detail: "high" } : { url },
  }));
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [{ type: "text", text: buildUserText(input.images.length, input.target, input.context) }, ...images],
    },
  ];
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function providerError(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const err = (data as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; metadata?: { raw?: unknown } };
    const parts = [e.message, e.code, typeof e.metadata?.raw === "string" ? e.metadata.raw : ""].filter(Boolean);
    return parts.map(String).join(" | ");
  }
  return "";
}

export interface CallResult {
  text: string;
  servedModel: string;
  usage: unknown;
}

export async function callModel(
  entry: ChainEntry,
  key: string,
  baseUrl: string,
  messages: Message[],
  timeoutMs: number,
  referer: string,
): Promise<CallResult> {
  const body: Record<string, unknown> = { model: entry.model, messages };
  if (entry.effort) {
    if (entry.provider === "openrouter") body.reasoning = { effort: entry.effort, exclude: true };
    else body.reasoning_effort = entry.effort;
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  if (entry.provider === "openrouter") {
    headers["http-referer"] = referer;
    headers["x-title"] = "Durka";
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300) || "пустое тело"}`);
  }
  const err = providerError(data);
  if (!res.ok || err) throw new Error(`HTTP ${res.status}: ${err || raw.slice(0, 300)}`);

  const d = data as { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; model?: string; usage?: unknown };
  const choice = d.choices?.[0];
  const text = contentToText(choice?.message?.content).trim();
  if (!text) throw new Error(`пустой ответ (finish_reason: ${choice?.finish_reason ?? "?"})`);
  return { text, servedModel: d.model || entry.model, usage: d.usage ?? null };
}

export interface ChainResult {
  text: string;
  entry: ChainEntry;
  servedModel: string;
  attempts: Attempt[];
}

export class ChainError extends Error {
  constructor(
    message: string,
    public attempts: Attempt[],
  ) {
    super(message);
  }
}

// Идём по цепочке, пока кто-то не ответит. Провайдеры без ключа пропускаем.
export async function runChain(
  cfg: StoredConfig,
  input: JobInput,
  deadline: number,
  referer: string,
  onAttempt: (entry: ChainEntry, index: number) => Promise<void>,
): Promise<ChainResult> {
  const attempts: Attempt[] = [];
  const secrets = allSecrets(cfg);
  let tried = 0;

  for (const entry of cfg.chain) {
    if (!entry.enabled) continue;
    const base = { provider: entry.provider, model: entry.model, effort: entry.effort };
    const { key } = resolveKey(cfg, entry.provider);
    const baseUrl = baseUrlFor(cfg, entry.provider);
    if (!key || !baseUrl) {
      attempts.push({ ...base, status: "skipped", ms: 0, error: !key ? "нет ключа" : "не задан адрес" });
      continue;
    }
    const left = deadline - Date.now();
    if (left < 20_000) {
      attempts.push({ ...base, status: "skipped", ms: 0, error: "кончилось время" });
      continue;
    }

    await onAttempt(entry, tried++);
    const t0 = Date.now();
    try {
      const r = await callModel(entry, key, baseUrl, buildMessages(input, entry.provider), Math.min(cfg.timeoutSec * 1000, left - 10_000), referer);
      attempts.push({ ...base, status: "ok", ms: Date.now() - t0 });
      return { text: r.text, entry, servedModel: r.servedModel, attempts };
    } catch (e) {
      const msg = scrub(errorText(e), secrets).slice(0, 400);
      console.error(`[durka] ${entry.provider}/${entry.model} упал: ${msg}`);
      attempts.push({ ...base, status: "error", ms: Date.now() - t0, error: msg });
    }
  }

  const reason = tried === 0 ? "Ни у одного провайдера в цепочке нет ключа." : "Все врачи из цепочки отказались.";
  throw new ChainError(reason, attempts);
}
