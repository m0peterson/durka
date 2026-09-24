import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// Сравнение секретов за постоянное время: хэшируем, чтобы длины совпадали.
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

export function maskKey(key: string): string {
  if (key.length <= 12) return "••••";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

// Вычищает ключи из текста ошибок провайдеров, чтобы они не утекли в UI или логи.
export function scrub(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("***");
  }
  return out
    .replace(/\b(sk|gsk|csk|AIza)[-_A-Za-z0-9]{12,}/g, "***")
    .replace(/Bearer\s+[-_.A-Za-z0-9]{12,}/gi, "Bearer ***");
}

export function errorText(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "таймаут";
    return e.message;
  }
  return String(e);
}

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
