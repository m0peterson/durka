import { configStore } from "./store.mts";
import { maskKey, todayKey } from "./util.mts";

export type ProviderId = "openrouter" | "groq" | "gemini" | "custom";
export type Effort = "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const PROVIDER_IDS: ProviderId[] = ["openrouter", "groq", "gemini", "custom"];
export const EFFORTS: Effort[] = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

interface ProviderInfo {
  label: string;
  // Адрес зашит в код: ключ OpenRouter физически не может уйти никуда,
  // кроме openrouter.ai, даже если кто-то влезет в админку.
  baseUrl: string | null;
  envKey: string | null;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY" },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
  },
  custom: { label: "Свой (OpenAI-совместимый)", baseUrl: null, envKey: null },
};

export interface ChainEntry {
  provider: ProviderId;
  model: string;
  effort: Effort;
  enabled: boolean;
}

export interface StoredConfig {
  chain: ChainEntry[];
  keys: Partial<Record<ProviderId, string>>;
  customBaseUrl: string;
  accessCode: string;
  dailyLimit: number;
  timeoutSec: number;
}

export const MAX_CHAIN = 6;

export const DEFAULT_CONFIG: StoredConfig = {
  chain: [
    { provider: "openrouter", model: "openai/gpt-6-luna", effort: "max", enabled: true },
    { provider: "openrouter", model: "openai/gpt-5.6-luna", effort: "high", enabled: true },
    { provider: "groq", model: "qwen/qwen3.8-27b", effort: "", enabled: true },
    { provider: "gemini", model: "gemini-3.8-flash", effort: "", enabled: true },
  ],
  keys: {},
  customBaseUrl: "",
  accessCode: "",
  dailyLimit: 200,
  timeoutSec: 480,
};

function isProvider(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDER_IDS as string[]).includes(v);
}

function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORTS as string[]).includes(v);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeChain(raw: unknown): ChainEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ChainEntry[] = [];
  for (const item of raw.slice(0, MAX_CHAIN)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const model = typeof e.model === "string" ? e.model.trim().slice(0, 200) : "";
    if (!isProvider(e.provider) || !model) continue;
    out.push({
      provider: e.provider,
      model,
      effort: isEffort(e.effort) ? e.effort : "",
      enabled: e.enabled !== false,
    });
  }
  return out;
}

// https:// везде, http:// только для локальной отладки.
export function validBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
  } catch {
    return false;
  }
}

function normalizeConfig(raw: unknown): StoredConfig {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const keys: StoredConfig["keys"] = {};
  if (r.keys && typeof r.keys === "object") {
    for (const [p, k] of Object.entries(r.keys as Record<string, unknown>)) {
      if (isProvider(p) && typeof k === "string" && k) keys[p] = k;
    }
  }
  const customBaseUrl = typeof r.customBaseUrl === "string" && validBaseUrl(r.customBaseUrl) ? r.customBaseUrl : "";
  return {
    chain: normalizeChain(r.chain) ?? DEFAULT_CONFIG.chain,
    keys,
    customBaseUrl: customBaseUrl.replace(/\/+$/, ""),
    accessCode: typeof r.accessCode === "string" ? r.accessCode.slice(0, 100) : "",
    dailyLimit: clampInt(r.dailyLimit, 0, 100000, DEFAULT_CONFIG.dailyLimit),
    timeoutSec: clampInt(r.timeoutSec, 30, 840, DEFAULT_CONFIG.timeoutSec),
  };
}

export async function loadConfig(): Promise<StoredConfig> {
  const raw = await configStore().get("config", { type: "json" });
  return normalizeConfig(raw);
}

export async function saveConfig(cfg: StoredConfig): Promise<void> {
  await configStore().setJSON("config", cfg);
}

export type KeySource = "admin" | "env" | null;

// Ключ из админки перекрывает переменную окружения: так его можно сменить без редеплоя.
export function resolveKey(cfg: StoredConfig, provider: ProviderId): { key: string | null; source: KeySource } {
  const fromAdmin = cfg.keys[provider];
  if (fromAdmin) return { key: fromAdmin, source: "admin" };
  const envName = PROVIDERS[provider].envKey;
  const fromEnv = envName ? Netlify.env.get(envName) : undefined;
  if (fromEnv) return { key: fromEnv.trim(), source: "env" };
  return { key: null, source: null };
}

export function baseUrlFor(cfg: StoredConfig, provider: ProviderId): string | null {
  return provider === "custom" ? cfg.customBaseUrl || null : PROVIDERS[provider].baseUrl;
}

export function effectiveAccessCode(cfg: StoredConfig): string {
  return cfg.accessCode || Netlify.env.get("APP_PASSWORD") || "";
}

export function usableEntries(cfg: StoredConfig): ChainEntry[] {
  return cfg.chain.filter((e) => e.enabled && resolveKey(cfg, e.provider).key && baseUrlFor(cfg, e.provider));
}

export function allSecrets(cfg: StoredConfig): string[] {
  return PROVIDER_IDS.map((p) => resolveKey(cfg, p).key).filter((k): k is string => Boolean(k));
}

// Счётчик запросов за сутки. Запись через etag, чтобы параллельные запросы не терялись.
export async function bumpUsage(): Promise<number> {
  const store = configStore();
  const key = `usage/${todayKey()}`;
  for (let i = 0; i < 5; i++) {
    const cur = await store.getWithMetadata(key, { type: "text" });
    const next = (cur ? Number(cur.data) || 0 : 0) + 1;
    const res = cur
      ? await store.set(key, String(next), { onlyIfMatch: cur.etag })
      : await store.set(key, String(next), { onlyIfNew: true });
    if (res.modified) return next;
  }
  // Не удалось за 5 попыток: считаем без гарантий, лишь бы не блокировать людей.
  return 0;
}

export async function readUsage(): Promise<number> {
  const v = await configStore().get(`usage/${todayKey()}`, { type: "text" });
  return Number(v) || 0;
}

export function adminView(cfg: StoredConfig) {
  const keys = Object.fromEntries(
    PROVIDER_IDS.map((p) => {
      const { key, source } = resolveKey(cfg, p);
      return [p, { set: Boolean(key), source, hint: key ? maskKey(key) : "", env: PROVIDERS[p].envKey }];
    }),
  );
  return {
    chain: cfg.chain,
    keys,
    customBaseUrl: cfg.customBaseUrl,
    accessCode: cfg.accessCode,
    accessCodeFromEnv: Boolean(Netlify.env.get("APP_PASSWORD")),
    dailyLimit: cfg.dailyLimit,
    timeoutSec: cfg.timeoutSec,
    providers: Object.fromEntries(PROVIDER_IDS.map((p) => [p, PROVIDERS[p].label])),
    efforts: EFFORTS,
  };
}
