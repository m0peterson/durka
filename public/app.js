"use strict";

const MAX_FILES = 6;
const MAX_PARTS = 10;
// Сколько base64-символов можно отправить за раз (лимит функции Netlify около 6 МБ).
const BUDGET = 4_600_000;
const POLL_LIMIT_MS = 16 * 60 * 1000;
const JOB_KEY = "durka.job";
const CODE_KEY = "durka.code";

const QUIPS = [
  "Санитары разминаются",
  "Ищем признаки интеллекта. Пока безуспешно",
  "Сверяемся с методичкой Минздрава",
  "Главврач надел очки",
  "Готовим смирительную рубашку, на всякий случай",
  "Считаем восклицательные знаки",
  "Консилиум спорит о диагнозе",
  "Проверяем, умеет ли пациент читать",
  "Главврач перечитывает третий раз, не верит глазам",
  "Заваривают пустырник",
  "Звоним в регистратуру за анамнезом",
  "Меряем давление капслоку",
];

const WARDS = [
  { max: 20, ward: "Здоров", note: "подозрительно здоров", stamp: "Здоров" },
  { max: 40, ward: "Амбулаторно", note: "пустырник и прогулки", stamp: "Амбулаторно" },
  { max: 60, ward: "Дневной стационар", note: "с 9 до 18, с вещами", stamp: "Стационар" },
  { max: 80, ward: "Госпитализация", note: "санитары выехали", stamp: "Госпитализировать" },
  { max: 101, ward: "Буйное отделение", note: "рубашка по размеру", stamp: "В буйное" },
];

const $ = (id) => document.getElementById(id);

const state = {
  files: [], // { id, file, url, w, h }
  busy: false,
  codeRequired: false,
  seq: 0,
};

function storage(kind) {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function store(kind, key, value) {
  try {
    const s = storage(kind);
    if (!s) return null;
    if (value === undefined) return s.getItem(key);
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* приватный режим и т.п. */
  }
  return null;
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function wardFor(score) {
  const i = WARDS.findIndex((w) => score < w.max);
  return { ...WARDS[i], level: i };
}

function showError(msg) {
  const box = $("form-error");
  box.textContent = msg || "";
  box.hidden = !msg;
}

/* ---------- Картинки ---------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("не картинка"));
    };
    img.src = url;
  });
}

// Длинные скрины переписки режем на куски с нахлёстом, иначе модель ужмёт их и не прочитает текст.
function planTiles(w, h, mul) {
  const tall = h / w > 3;
  const scale = tall ? Math.min(1, (1280 * mul) / w) : Math.min(1, (2048 * mul) / Math.max(w, h));
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  if (!tall) return { W, H, scale, tiles: [[0, H]] };
  const overlap = Math.round(W * 0.08);
  const maxTiles = 4;
  const tileH = Math.max(W * 2, Math.ceil((H + (maxTiles - 1) * overlap) / maxTiles));
  const tiles = [];
  for (let y = 0; y < H; y += tileH - overlap) {
    const hh = Math.min(tileH, H - y);
    tiles.push([y, hh]);
    if (y + hh >= H) break;
  }
  return { W, H, scale, tiles };
}

function partsCount() {
  return state.files.reduce((n, f) => n + planTiles(f.w, f.h, 1).tiles.length, 0);
}

async function encodeAll(quality, mul) {
  const out = [];
  for (const f of state.files) {
    const { img, url } = await loadImage(f.file);
    try {
      const { W, scale, tiles } = planTiles(f.w, f.h, mul);
      for (const [y, hh] of tiles) {
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = hh;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, W, hh);
        ctx.drawImage(img, 0, y / scale, f.w, hh / scale, 0, 0, W, hh);
        out.push(canvas.toDataURL("image/jpeg", quality));
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return out;
}

async function encodeWithinBudget() {
  const steps = [
    [0.86, 1],
    [0.76, 0.85],
    [0.66, 0.72],
    [0.56, 0.6],
  ];
  for (const [q, mul] of steps) {
    const images = await encodeAll(q, mul);
    const size = images.reduce((n, s) => n + s.length, 0);
    if (size <= BUDGET) return images;
  }
  throw new Error("Скрины слишком тяжёлые даже после сжатия. Убери парочку.");
}

async function addFiles(list) {
  showError("");
  const files = Array.from(list || []).filter((f) => f && f.type.startsWith("image/"));
  if (files.length === 0) return;
  for (const file of files) {
    if (state.files.length >= MAX_FILES) {
      showError(`Максимум ${MAX_FILES} скринов за один приём.`);
      break;
    }
    try {
      const { img, url } = await loadImage(file);
      state.files.push({ id: ++state.seq, file, url, w: img.naturalWidth, h: img.naturalHeight });
    } catch {
      showError(`Не смог открыть «${file.name || "картинку"}». Нужен PNG, JPEG или WebP.`);
    }
  }
  renderThumbs();
}

function removeFile(id) {
  const i = state.files.findIndex((f) => f.id === id);
  if (i === -1) return;
  URL.revokeObjectURL(state.files[i].url);
  state.files.splice(i, 1);
  renderThumbs();
}

function renderThumbs() {
  const list = $("thumbs");
  list.replaceChildren(
    ...state.files.map((f, i) => {
      const n = planTiles(f.w, f.h, 1).tiles.length;
      return el(
        "li",
        { class: "thumb" },
        el("img", { src: f.url, alt: `Скрин ${i + 1}` }),
        n > 1 ? el("span", { class: "badge", text: `${n} части` }) : null,
        el("button", { type: "button", class: "remove", "aria-label": `Убрать скрин ${i + 1}`, text: "×", onclick: () => removeFile(f.id) }),
      );
    }),
  );
  const parts = partsCount();
  const info = $("parts");
  if (state.files.length === 0) {
    info.hidden = true;
  } else {
    info.hidden = false;
    const over = parts > MAX_PARTS;
    info.classList.toggle("bad", over);
    info.textContent = over
      ? `Частей после нарезки ${parts}, а влезает ${MAX_PARTS}. Убери что-нибудь.`
      : `Скринов: ${state.files.length}, частей для анализа: ${parts} из ${MAX_PARTS}`;
  }
  $("go").disabled = state.busy || state.files.length === 0 || parts > MAX_PARTS;
}

/* ---------- Отправка и ожидание ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

let ticker = null;

function startProgress(id, since) {
  $("intake").hidden = true;
  $("result").hidden = true;
  $("progress").hidden = false;
  $("card-no").textContent = id.split("-")[1]?.slice(0, 6).toUpperCase() || "…";
  $("stage").textContent = "Регистрируем пациента";
  let q = Math.floor(Math.random() * QUIPS.length);
  $("quip").textContent = QUIPS[q];
  clearInterval(ticker);
  let tick = 0;
  ticker = setInterval(() => {
    $("elapsed").textContent = fmtTime(Date.now() - since);
    if (++tick % 4 === 0) {
      q = (q + 1) % QUIPS.length;
      $("quip").textContent = QUIPS[q];
    }
  }, 1000);
}

function stopProgress() {
  clearInterval(ticker);
  $("progress").hidden = true;
}

async function poll(id, since) {
  let misses = 0;
  while (Date.now() - since < POLL_LIMIT_MS) {
    await sleep(Date.now() - since < 60_000 ? 2000 : 4000);
    let res;
    try {
      res = await fetch(`/api/result?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    } catch {
      if (++misses > 10) throw new Error("Пропала связь с диспансером.");
      continue;
    }
    misses = 0;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
    if (data.status === "done") return data;
    if (data.status === "error") {
      const err = new Error(data.error || "Врачи не справились");
      err.attempts = data.attempts;
      throw err;
    }
    if (data.stage) $("stage").textContent = data.stage;
  }
  throw new Error("Не дождались врача. Попробуй ещё раз.");
}

async function follow(id, since) {
  startProgress(id, since);
  try {
    const job = await poll(id, since);
    renderResult(job, id);
  } catch (e) {
    $("intake").hidden = false;
    showError(e.message + attemptsLine(e.attempts));
  } finally {
    store("session", JOB_KEY, null);
    stopProgress();
    state.busy = false;
    renderThumbs();
  }
}

function attemptsLine(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return "";
  const failed = attempts.filter((a) => a.status === "error").map((a) => `${a.model}: ${a.error}`);
  return failed.length ? ` (${failed.join("; ")})` : "";
}

async function submit(ev) {
  ev.preventDefault();
  if (state.busy || state.files.length === 0) return;
  showError("");
  state.busy = true;
  const go = $("go");
  go.disabled = true;
  go.textContent = "Сжимаем скрины…";

  try {
    const images = await encodeWithinBudget();
    go.textContent = "Отправляем…";
    const code = $("code").value.trim();
    const res = await fetch("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images, target: $("target").value.trim(), context: $("context").value.trim(), code }),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401 && data?.needCode) {
      $("code-wrap").hidden = false;
      $("code").focus();
      throw new Error(code ? "Код доступа не подошёл." : "Нужен код доступа.");
    }
    if (res.status === 429 && !data?.error) throw new Error("Слишком часто. Санитары на перекуре, подожди минуту.");
    if (!res.ok || !data?.id) throw new Error(data?.error || `Ошибка ${res.status}`);
    if (code) store("local", CODE_KEY, code);

    const since = Date.now();
    store("session", JOB_KEY, JSON.stringify({ id: data.id, since }));
    go.textContent = "Поставить диагноз";
    await follow(data.id, since);
  } catch (e) {
    showError(e.message || "Что-то сломалось");
    state.busy = false;
    go.textContent = "Поставить диагноз";
    renderThumbs();
  }
}

/* ---------- Заключение ---------- */

function renderSuspect(s) {
  const w = wardFor(s.score);
  const lvl = `lvl-${w.level}`;
  const mark = el("span", { class: "gauge-mark" });
  mark.style.left = `${s.score}%`;
  return el(
    "article",
    { class: "sheet patient" },
    el(
      "div",
      { class: "patient-top" },
      el(
        "div",
        null,
        el("h3", { class: "patient-name", text: s.name }),
        el("p", { class: `patient-ward ${lvl}`, text: `${w.ward} · ${w.note}` }),
      ),
      el("div", { class: `score ${lvl}` }, String(s.score), el("small", { text: "индекс долбоебизма" })),
    ),
    el("div", { class: "gauge", role: "img", "aria-label": `${s.score} из 100` }, mark),
    el("div", { class: "gauge-scale", "aria-hidden": "true" }, el("span", { text: "0" }), el("span", { text: "50" }), el("span", { text: "100" })),
    s.diagnosis ? el("p", { class: "diagnosis" }, el("b", { text: "Диагноз" }), s.diagnosis) : null,
    s.verdict ? el("p", { class: "verdict", text: s.verdict }) : null,
    s.evidence?.length
      ? el(
          "ul",
          { class: "evidence" },
          s.evidence.map((e) => el("li", null, el("blockquote", { text: e.quote }), e.comment ? el("p", { text: e.comment }) : null)),
        )
      : el("div", { class: "evidence" }),
    el("span", { class: `stamp ${lvl}`, "aria-hidden": "true", text: w.stamp }),
  );
}

function resultText(job) {
  const r = job.result;
  const lines = ["ЗАКЛЮЧЕНИЕ ВРАЧЕБНОЙ КОМИССИИ", ""];
  for (const s of sortedSuspects(job)) {
    const w = wardFor(s.score);
    lines.push(`${s.name}: ${s.score}/100, ${w.ward.toLowerCase()} (${w.note})`);
    if (s.diagnosis) lines.push(`Диагноз: ${s.diagnosis}`);
    if (s.verdict) lines.push(s.verdict);
    for (const e of s.evidence || []) lines.push(`  «${e.quote}»${e.comment ? ` - ${e.comment}` : ""}`);
    lines.push("");
  }
  if (r.summary) lines.push(r.summary, "");
  if (r.prescription) lines.push(`Назначение: ${r.prescription}`, "");
  lines.push(location.origin);
  return lines.join("\n");
}

function sortedSuspects(job) {
  const list = [...(job.result?.suspects || [])];
  // Если указали, кого проверять, модель ставит его первым. Иначе сортируем по тяжести.
  return job.target ? list : list.sort((a, b) => b.score - a.score);
}

function renderResult(job, id) {
  const r = job.result || {};
  const box = $("result");
  const secs = job.finishedAt && job.startedAt ? Math.round((job.finishedAt - job.startedAt) / 1000) : null;
  const doc = job.doctor || {};
  const attempts = Array.isArray(job.attempts) ? job.attempts : [];

  const blocks = [];
  if (r.summary) blocks.push(el("div", { class: "block" }, el("h3", { text: r.raw ? "Заключение (врач писал от руки)" : "Заключение" }), el("p", { text: r.summary })));
  if (r.prescription) blocks.push(el("div", { class: "block" }, el("h3", { text: "Назначение" }), el("p", { text: r.prescription })));

  const copyBtn = el("button", {
    type: "button",
    class: "secondary",
    text: "Скопировать заключение",
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(resultText(job));
        copyBtn.textContent = "Скопировано";
      } catch {
        copyBtn.textContent = "Не вышло скопировать";
      }
      setTimeout(() => (copyBtn.textContent = "Скопировать заключение"), 2000);
    },
  });

  box.replaceChildren(
    el(
      "div",
      { class: "result-head" },
      el("h2", { text: "Заключение врачебной комиссии" }),
      el("p", { text: `карта ${id.split("-")[1]?.slice(0, 6).toUpperCase() || ""} · ${new Date().toLocaleDateString("ru-RU")}` }),
    ),
    ...sortedSuspects(job).map(renderSuspect),
    blocks.length ? el("section", { class: `sheet${r.serious ? " serious" : ""}` }, blocks) : null,
    el(
      "div",
      { class: "actions" },
      el("button", { type: "button", class: "primary", text: "Следующий пациент", onclick: reset }),
      copyBtn,
    ),
    el(
      "div",
      { class: "doctor" },
      el("p", { text: `Осматривал: ${doc.model || "?"}${doc.effort ? ` (${doc.effort})` : ""} через ${doc.provider || "?"}${secs !== null ? ` · ${secs} с` : ""}` }),
      attempts.length > 1
        ? el(
            "details",
            null,
            el("summary", { text: "Кто ещё пытался" }),
            el(
              "ol",
              null,
              attempts.map((a) => el("li", { text: `${a.model}: ${a.status === "ok" ? "справился" : a.status === "skipped" ? `пропущен (${a.error})` : `упал (${a.error})`}` })),
            ),
          )
        : null,
    ),
  );
  box.hidden = false;
  $("intake").hidden = true;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

function reset() {
  for (const f of state.files) URL.revokeObjectURL(f.url);
  state.files = [];
  $("target").value = "";
  $("context").value = "";
  $("result").hidden = true;
  $("intake").hidden = false;
  showError("");
  renderThumbs();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- Инициализация ---------- */

function init() {
  const drop = $("drop");
  const input = $("file");
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => {
    addFiles(input.files);
    input.value = "";
  });

  ["dragenter", "dragover"].forEach((t) =>
    drop.addEventListener(t, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((t) =>
    drop.addEventListener(t, (e) => {
      e.preventDefault();
      drop.classList.remove("over");
    }),
  );
  drop.addEventListener("drop", (e) => addFiles(e.dataTransfer?.files));
  // Чтобы промах мимо зоны не открывал картинку во вкладке.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  document.addEventListener("paste", (e) => {
    if ($("intake").hidden) return;
    const files = Array.from(e.clipboardData?.items || [])
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  if (navigator.clipboard && typeof navigator.clipboard.read === "function") {
    const btn = $("paste");
    btn.hidden = false;
    btn.addEventListener("click", async () => {
      try {
        const items = await navigator.clipboard.read();
        const files = [];
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) files.push(new File([await item.getType(type)], "clipboard", { type }));
        }
        if (files.length) addFiles(files);
        else showError("В буфере нет картинки.");
      } catch {
        showError("Браузер не дал доступ к буферу. Попробуй Ctrl+V.");
      }
    });
  }

  $("intake").addEventListener("submit", submit);

  const savedCode = store("local", CODE_KEY);
  if (savedCode) $("code").value = savedCode;

  fetch("/api/meta", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (!m) return;
      state.codeRequired = m.codeRequired;
      $("code-wrap").hidden = !m.codeRequired;
      if (!m.configured) showError("Главврач в отпуске: владелец сайта ещё не настроил ключ API.");
    })
    .catch(() => {});

  renderThumbs();

  // Страницу обновили во время осмотра: продолжаем ждать тот же результат.
  const pending = store("session", JOB_KEY);
  if (pending) {
    try {
      const { id, since } = JSON.parse(pending);
      if (id && Date.now() - since < POLL_LIMIT_MS) {
        state.busy = true;
        follow(id, since);
      } else {
        store("session", JOB_KEY, null);
      }
    } catch {
      store("session", JOB_KEY, null);
    }
  }
}

init();
