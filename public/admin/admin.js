"use strict";

const AUTH_KEY = "durka.admin";
const EFFORT_LABELS = { "": "не передавать" };
const $ = (id) => document.getElementById(id);

let view = null; // последний ответ сервера
let chain = []; // редактируемая копия цепочки

function session(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* без sessionStorage просто придётся вводить пароль заново */
  }
  return null;
}

let memoryAuth = "";

function encodeAuth(pw) {
  const bytes = new TextEncoder().encode(pw);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "value") node.value = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

async function api(method, body) {
  const auth = memoryAuth || session(AUTH_KEY) || "";
  const res = await fetch("/api/admin", {
    method,
    headers: { "x-admin-auth": auth, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    logout();
    throw new Error(data?.error || "Неверный пароль");
  }
  if (res.status === 429) throw new Error("Слишком много запросов, подожди минуту");
  if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
  return data;
}

function logout() {
  memoryAuth = "";
  session(AUTH_KEY, null);
  $("panel").hidden = true;
  $("login").hidden = false;
}

/* ---------- Ключи ---------- */

function renderKeys() {
  const box = $("keys");
  box.replaceChildren(
    ...Object.entries(view.keys).map(([p, k]) => {
      const input = el("input", { type: "password", placeholder: k.set ? "Новый ключ, чтобы заменить" : "Вставь ключ", autocomplete: "off" });
      const status = k.source === "env" ? `из env ${k.env}` : k.source === "admin" ? "из админки" : "нет ключа";
      return el(
        "div",
        { class: "key-row" },
        el(
          "header",
          null,
          el("strong", { text: view.providers[p] || p }),
          el("span", { class: `tag${k.set ? " on" : ""}`, text: k.set ? `${status} · ${k.hint}` : status }),
        ),
        el(
          "div",
          { class: "inline" },
          input,
          el("button", {
            type: "button",
            class: "secondary",
            text: "Сохранить",
            onclick: async () => {
              const v = input.value.trim();
              if (!v) return toast("Сначала вставь ключ");
              await saveKeys({ [p]: v });
              input.value = "";
            },
          }),
        ),
        k.source === "admin"
          ? el("p", { class: "note" }, el("button", { type: "button", class: "link-btn", text: k.env ? `Удалить из админки (вернётся ${k.env}, если он задан)` : "Удалить ключ", onclick: () => saveKeys({ [p]: null }) }))
          : null,
      );
    }),
  );
}

async function saveKeys(keys) {
  try {
    view = await api("POST", { action: "save", keys });
    renderKeys();
    toast("Ключ сохранён");
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- Цепочка ---------- */

function renderChain() {
  const list = $("chain");
  list.replaceChildren(
    ...chain.map((entry, i) => {
      const out = el("p", { class: "test-out" });
      const provider = el(
        "select",
        { "aria-label": "Провайдер", onchange: (e) => (entry.provider = e.target.value) },
        Object.entries(view.providers).map(([id, label]) => el("option", { value: id, text: label, selected: id === entry.provider })),
      );
      const model = el("input", { type: "text", value: entry.model, placeholder: "id модели", "aria-label": "Модель", oninput: (e) => (entry.model = e.target.value) });
      const effort = el(
        "select",
        { "aria-label": "Reasoning effort", onchange: (e) => (entry.effort = e.target.value) },
        view.efforts.map((ef) => el("option", { value: ef, text: EFFORT_LABELS[ef] ?? ef, selected: ef === entry.effort })),
      );
      const enabled = el("input", { type: "checkbox", checked: entry.enabled, onchange: (e) => (entry.enabled = e.target.checked) });
      return el(
        "li",
        null,
        el("span", { class: "num", text: String(i + 1) }),
        el("div", { class: "cols" }, provider, model, effort),
        el(
          "div",
          { class: "tools" },
          el("label", null, enabled, "включён"),
          el("button", { type: "button", class: "secondary", text: "↑", "aria-label": "Выше", disabled: i === 0, onclick: () => move(i, -1) }),
          el("button", { type: "button", class: "secondary", text: "↓", "aria-label": "Ниже", disabled: i === chain.length - 1, onclick: () => move(i, 1) }),
          el("button", { type: "button", class: "secondary", text: "Тест", onclick: () => test(entry, out) }),
          el("button", { type: "button", class: "secondary", text: "✕", "aria-label": "Убрать", onclick: () => remove(i) }),
        ),
        out,
      );
    }),
  );
  $("add").disabled = chain.length >= 6;
}

function move(i, d) {
  const j = i + d;
  [chain[i], chain[j]] = [chain[j], chain[i]];
  renderChain();
}

function remove(i) {
  if (chain.length === 1) return toast("Хотя бы один врач нужен");
  chain.splice(i, 1);
  renderChain();
}

async function test(entry, out) {
  out.className = "test-out";
  out.textContent = "Проверяем…";
  try {
    const r = await api("POST", { action: "test", entry });
    out.className = `test-out ${r.ok ? "ok" : "bad"}`;
    out.textContent = r.ok ? `Работает: ${r.model}, ${r.ms} мс, ответ «${r.reply}»` : `Не работает: ${r.error}`;
  } catch (e) {
    out.className = "test-out bad";
    out.textContent = e.message;
  }
}

/* ---------- Общее ---------- */

function fill() {
  chain = view.chain.map((e) => ({ ...e }));
  renderKeys();
  renderChain();
  $("custom-url").value = view.customBaseUrl || "";
  $("access-code").value = view.accessCode || "";
  const note = $("access-note");
  note.hidden = !view.accessCodeFromEnv;
  note.textContent = "Если поле пустое, действует код из переменной APP_PASSWORD.";
  $("daily-limit").value = view.dailyLimit;
  $("timeout").value = view.timeoutSec;
  $("usage").textContent = `Сегодня (UTC) принято пациентов: ${view.usageToday}${view.dailyLimit ? ` из ${view.dailyLimit}` : ""}.`;
}

async function saveSettings() {
  const btn = $("save");
  btn.disabled = true;
  try {
    view = await api("POST", {
      action: "save",
      chain: chain.map((e) => ({ ...e, model: e.model.trim() })).filter((e) => e.model),
      customBaseUrl: $("custom-url").value.trim(),
      accessCode: $("access-code").value.trim(),
      dailyLimit: Number($("daily-limit").value),
      timeoutSec: Number($("timeout").value),
    });
    fill();
    toast("Сохранено");
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function enter() {
  view = await api("GET");
  fill();
  $("login").hidden = true;
  $("panel").hidden = false;
}

function init() {
  $("login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("login-error");
    err.hidden = true;
    const pw = $("password").value;
    if (!pw) return;
    memoryAuth = encodeAuth(pw);
    session(AUTH_KEY, memoryAuth);
    try {
      await enter();
      $("password").value = "";
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  $("add").addEventListener("click", () => {
    chain.push({ provider: "openrouter", model: "", effort: "", enabled: true });
    renderChain();
  });
  $("save").addEventListener("click", saveSettings);
  $("logout").addEventListener("click", logout);

  if (session(AUTH_KEY)) enter().catch(() => logout());
}

init();
