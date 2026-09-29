/* FaceRoom · кабинет управляющего.

   Данные лежат рядом в data.enc.json зашифрованными (PBKDF2-SHA256 + AES-256-GCM):
   репозиторий публичный, а в данных телефоны клиентов. Расшифровка — здесь, в
   браузере, паролем управляющих; наружу ничего не отправляется.

   Весь текст из данных (имена, заметки, отзывы) вставляется через textContent:
   это чужой текст, и разметкой он быть не должен. */
"use strict";

let DATA = null;
const state = { tab: "calls", studio: "", period: "7d", query: "",
                tagFilter: { calls: "all", messages: "all" } };

// ── Мелочи ─────────────────────────────────────────────────────────────────
const $ = sel => document.querySelector(sel);

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
const svgEl = (tag, attrs) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
};
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
                "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const parseDay = s => new Date(s + "T12:00:00");
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return iso(d); };
const dayRange = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const short = s => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const longDay = s => { const d = parseDay(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${WEEKDAYS[d.getDay()]}`; };
const pct = (a, b) => (b ? Math.round(100 * a / b) : null);
const fmtPct = v => (v === null || v === undefined ? "—" : `${v}%`);
const sum = arr => arr.reduce((a, b) => a + b, 0);

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function phoneLink(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return null;
  const pretty = d.length === 11 && d[0] === "7"
    ? `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : `+${d}`;
  return el("a", { href: `tel:+${d}` }, pretty);
}

// ── Расшифровка ────────────────────────────────────────────────────────────
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function decrypt(blob, password) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(blob.salt), iterations: blob.kdf.iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(blob.iv) }, key, b64(blob.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function enter(password) {
  const msg = $("#gateMsg"), btn = $("#enter");
  msg.className = ""; msg.textContent = "Открываю…"; btn.disabled = true;
  try {
    const resp = await fetch("data.enc.json", { cache: "no-store" });
    if (!resp.ok) throw new Error("nodata");
    const blob = await resp.json();
    try { DATA = await decrypt(blob, password); }
    catch (e) { throw new Error("password"); }
    try { sessionStorage.setItem("fr-cs", password); } catch (e) { /* приватный режим */ }
    $("#gate").hidden = true; $("#app").hidden = false;
    start();
  } catch (e) {
    msg.className = "err";
    msg.textContent = e.message === "password" ? "Неверный пароль"
      : "Данные пока не опубликованы — попробуйте позже";
    try { sessionStorage.removeItem("fr-cs"); } catch (x) { /* ничего */ }
  } finally { btn.disabled = false; }
}

// ── Периоды ────────────────────────────────────────────────────────────────
const PERIODS = [
  { id: "1d", label: "Вчера" }, { id: "7d", label: "7 дней" },
  { id: "30d", label: "30 дней" }, { id: "mtd", label: "С начала месяца" },
];
function yesterday() { return addDays(DATA.today, -1); }
function periodDays(p = state.period) {
  const end = yesterday();
  if (p === "1d") return [end];
  if (p === "7d") return dayRange(addDays(end, -6), end);
  if (p === "30d") return dayRange(addDays(end, -29), end);
  return dayRange(end.slice(0, 8) + "01", end);
}
const prevDays = days => dayRange(addDays(days[0], -days.length), addDays(days[0], -1));
function periodCaption(days = periodDays()) {
  return days.length === 1 ? longDay(days[0]) : `${short(days[0])} — ${short(days[days.length - 1])}`;
}
// Для графика — не меньше двух недель, иначе у «вчера» нет динамики.
function chartDays() {
  const days = periodDays();
  return days.length >= 14 ? days : dayRange(addDays(yesterday(), -13), yesterday());
}

// ── Выборки ────────────────────────────────────────────────────────────────
const studioNames = () => (state.studio ? [state.studio] : DATA.studios);

// С какого дня в срезах появилось поле: правила счёта менялись, и за дни «до»
// цифры считались иначе — это надо подписывать, а не молча смешивать.
function firstDayWith(channel, field) {
  const days = Object.keys(DATA.conversion[channel]).sort();
  return days.find(d => Object.values(DATA.conversion[channel][d].studios || {}).some(r => field in r)) || null;
}

function convTotals(channel, days, studio = state.studio) {
  const t = { clients: 0, booked: 0, excluded: 0, reasons: {}, primary: 0, primaryBooked: 0,
              primaryUnknown: 0, daysWithData: 0 };
  for (const day of days) {
    const snap = DATA.conversion[channel][day];
    if (!snap) continue;
    t.daysWithData++;
    for (const [name, r] of Object.entries(snap.studios || {})) {
      if (studio && name !== studio) continue;
      t.clients += r.clients || 0; t.booked += r.booked || 0;
      t.primary += r.primary || 0; t.primaryBooked += r.primary_booked || 0;
      t.primaryUnknown += r.primary_unknown || 0;
      for (const [k, n] of Object.entries(r.no_booking_expected || {})) {
        t.reasons[k] = (t.reasons[k] || 0) + n; t.excluded += n;
      }
    }
  }
  return t;
}

const CALL_FIELDS = ["in_total", "in_missed", "in_missed_callback", "in_booked", "out_total", "out_noanswer", "out_booked"];
function callTotals(days, studio = state.studio) {
  const t = Object.fromEntries(CALL_FIELDS.map(f => [f, 0]));
  t.noCallback = 0; t.daysWithData = 0;
  for (const day of days) {
    const snap = DATA.calls[day];
    if (!snap) continue;
    t.daysWithData++;
    for (const [name, r] of Object.entries(snap.studios || {})) {
      if (studio && name !== studio) continue;
      for (const f of CALL_FIELDS) t[f] += r[f] || 0;
      t.noCallback += (r.missed_no_callback || []).length;
    }
  }
  return t;
}

// ── Плитки ─────────────────────────────────────────────────────────────────
// delta: {now, before, unit: "pp"|"pct"|"abs", better: "up"|"down", label}
function deltaNode(d) {
  if (!d || d.now === null || d.before === null || d.before === undefined) return null;
  let diff, text;
  if (d.unit === "pp") { diff = d.now - d.before; text = `${Math.abs(diff)} п.п.`; }
  else if (d.unit === "abs") { diff = Math.round((d.now - d.before) * 10) / 10; text = ruNum(Math.abs(diff)); }
  else {
    if (!d.before) return null;
    diff = Math.round(100 * (d.now - d.before) / d.before); text = `${Math.abs(diff)}%`;
  }
  if (!diff) return el("div", { class: "delta flat" }, `= ${d.label}`);
  const up = diff > 0;
  const good = (up && d.better === "up") || (!up && d.better === "down");
  return el("div", { class: `delta ${up ? "up" : "down"}-${good ? "good" : "bad"}` },
            `${up ? "↑" : "↓"} ${text} ${d.label}`);
}

function tile({ label, value, sub, delta, key }) {
  return el("div", { class: "tile" },
    el("div", { class: "lbl" }, key ? el("i", { class: "key", style: `background:var(${key})` }) : null, label),
    el("div", { class: "val" }, value),
    sub ? el("div", { class: "sub" }, sub) : null,
    deltaNode(delta));
}

// ── Графики (SVG) ──────────────────────────────────────────────────────────
// Одна ось, тонкие линии 2px, маркеры 8px с кольцом цвета поверхности, волосяная
// сетка. Подсказка показывает все серии в точке; стрелки ← → на клавиатуре
// двигают её так же, как мышь. У каждого графика есть таблица-двойник.
// Круглые деления: шаг из ряда 1–2–2,5–5 × 10ⁿ, не больше пяти делений, а для
// целых величин (звонки, отзывы) — только целый шаг. Иначе на оси «11,3 · 7,5 · 3,8».
function niceScale(maxValue, integer) {
  if (maxValue <= 0) return { max: integer ? 4 : 1, step: integer ? 1 : 0.25 };
  const raw = maxValue / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = 10 * p;
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) { step = m * p; break; }
  if (integer) step = Math.max(1, Math.round(step));
  return { max: Math.ceil(maxValue / step) * step, step };
}
const ruNum = v => String(Math.round(v * 10) / 10).replace(".", ",");

function chart(opts) {
  // opts: {kind: "line"|"stack", labels, series: [{name, color, values, detail?}], yMax, fmt, height, tipTitle}
  // detail — подпись к значению в подсказке и в таблице («37 из 70»): за
  // процентом должно быть видно, сколько это людей.
  const box = el("div", { class: "chart", tabindex: "0", role: "img" });
  const legend = opts.series.length > 1
    ? el("div", { class: "legend" }, opts.series.map(s => el("span", {},
        el("i", { class: opts.kind === "line" ? "line" : "rect", style: `background:var(${s.color})` }), s.name)))
    : null;
  const tableBtn = el("button", { class: "as-table", type: "button" }, "Показать таблицей");
  const tableBox = el("div", { class: "tbl-wrap", hidden: true });
  tableBtn.addEventListener("click", () => {
    tableBox.hidden = !tableBox.hidden;
    tableBtn.textContent = tableBox.hidden ? "Показать таблицей" : "Скрыть таблицу";
  });
  const fmt = opts.fmt || ruNum;
  tableBox.append(el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "Дата"), opts.series.map(s => el("th", {}, s.name)))),
    el("tbody", {}, opts.labels.map((lab, i) => el("tr", {},
      el("td", {}, opts.tipTitle ? opts.tipTitle(i) : lab),
      opts.series.map(s => el("td", {}, s.values[i] === null || s.values[i] === undefined ? "—"
        : [fmt(s.values[i]), s.detail && s.detail[i] ? el("span", { class: "pct" }, s.detail[i]) : null])))))));
  const wrap = el("div", {}, legend, box, tableBtn, tableBox);
  // Рисуется, когда раздел уже в документе (renderContent), — ширину нужно
  // измерить. Не через requestAnimationFrame: в фоновой вкладке кадров нет.
  charts.push(() => drawChart(box, opts));
  box.setAttribute("aria-label", opts.aria || "график");
  return wrap;
}
let charts = [];

function drawChart(box, o) {
  box.textContent = "";
  const W = Math.max(280, box.clientWidth || 600), H = o.height || 190;
  const padL = 36, padR = o.kind === "line" && o.series.length === 1 ? 40 : 10, padT = 8, padB = 24;
  const n = o.labels.length, plotW = W - padL - padR, plotH = H - padT - padB;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, height: H });
  const surface = cssVar("--card");
  const values = o.kind === "stack"
    ? o.labels.map((_, i) => sum(o.series.map(s => s.values[i] || 0)))
    : o.series.flatMap(s => s.values.filter(v => v !== null && v !== undefined));
  const integer = o.kind === "stack" || o.integer;
  const scale = o.yMax ? { max: o.yMax, step: o.yMax / 4 } : niceScale(Math.max(0, ...values), integer);
  const yMax = scale.max;
  const y = v => padT + plotH - (v / yMax) * plotH;
  const band = plotW / Math.max(1, n);
  const x = i => padL + band * (i + 0.5);
  const fmt = o.fmt || ruNum;

  // сетка и ось
  for (let v = 0, k = 0; v <= yMax + 1e-9; v += scale.step, k++) {
    const yy = Math.round(y(v)) + 0.5;
    svg.append(svgEl("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, class: k ? "gridline" : "baseline" }));
    const t = svgEl("text", { x: padL - 6, y: yy + 4, "text-anchor": "end", class: "tick" });
    t.textContent = fmt(Math.round(v * 100) / 100); svg.append(t);
  }
  const every = Math.ceil(n / Math.max(1, Math.floor(plotW / 44)));
  o.labels.forEach((lab, i) => {
    if (i % every && i !== n - 1) return;
    if (i !== n - 1 && n - 1 - i < every) return;   // последняя подпись всегда видна — соседнюю не рисуем, чтобы не наехали
    const t = svgEl("text", { x: x(i), y: H - 6, "text-anchor": "middle", class: "tick" });
    t.textContent = lab; svg.append(t);
  });
  if (!values.length) {
    const t = svgEl("text", { x: padL + plotW / 2, y: padT + plotH / 2, "text-anchor": "middle", class: "empty" });
    t.textContent = "Нет данных за этот период"; svg.append(t);
    box.append(svg); return;
  }

  if (o.kind === "stack") {
    // Столбцы не толще 24px, 2px просвета между сегментами, 4px скругление сверху.
    const bw = Math.min(24, band * 0.62);
    o.labels.forEach((_, i) => {
      let acc = 0;
      const segs = o.series.map(s => ({ v: s.values[i] || 0, color: s.color })).filter(s => s.v > 0);
      segs.forEach((s, j) => {
        const y0 = y(acc), y1 = y(acc + s.v);
        const top = j === segs.length - 1;
        const h = Math.max(0, y0 - y1 - (j ? 2 : 0));
        const yTop = y0 - (j ? 2 : 0) - h;
        const r = top ? Math.min(4, h, bw / 2) : 0;
        const x0 = x(i) - bw / 2;
        const d = `M${x0},${yTop + h} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + bw - r} ` +
                  `Q${x0 + bw},${yTop} ${x0 + bw},${yTop + r} V${yTop + h} Z`;
        svg.append(svgEl("path", { d, fill: `var(${s.color})` }));
        acc += s.v;
      });
    });
  } else {
    o.series.forEach(s => {
      let d = "", pen = false;
      s.values.forEach((v, i) => {
        if (v === null || v === undefined) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i)},${y(v)} `; pen = true;
      });
      svg.append(svgEl("path", { d, fill: "none", stroke: `var(${s.color})`, "stroke-width": 2,
                                 "stroke-linejoin": "round", "stroke-linecap": "round" }));
      const dots = n <= 16;
      s.values.forEach((v, i) => {
        if (v === null || v === undefined) return;
        const last = s.values.slice(i + 1).every(u => u === null || u === undefined);
        const isolated = (s.values[i - 1] ?? null) === null && (s.values[i + 1] ?? null) === null;
        if (dots || last || isolated) {
          svg.append(svgEl("circle", { cx: x(i), cy: y(v), r: 4, fill: `var(${s.color})`, stroke: surface, "stroke-width": 2 }));
        }
        if (last && o.series.length === 1) {
          const t = svgEl("text", { x: x(i) + 8, y: y(v) + 4, class: "endlabel" });
          t.textContent = fmt(v); svg.append(t);
        }
      });
    });
  }

  // подсказка: вертикальная линия прилипает к ближайшему дню
  const cross = svgEl("line", { y1: padT, y2: padT + plotH, class: "cross", visibility: "hidden" });
  const hover = svgEl("g", {});
  svg.append(cross, hover);
  const tip = el("div", { class: "tip", hidden: true });
  box.append(svg, tip);
  let active = -1;
  const show = i => {
    active = Math.max(0, Math.min(n - 1, i));
    const cx = x(active);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    hover.textContent = "";
    if (o.kind === "line") o.series.forEach(s => {
      const v = s.values[active];
      if (v === null || v === undefined) return;
      hover.append(svgEl("circle", { cx, cy: y(v), r: 5, fill: `var(${s.color})`, stroke: surface, "stroke-width": 2 }));
    });
    tip.textContent = "";
    tip.append(el("div", { class: "h" }, o.tipTitle ? o.tipTitle(active) : o.labels[active]));
    o.series.forEach(s => {
      const v = s.values[active];
      tip.append(el("div", { class: "r" }, el("i", { style: `background:var(${s.color})` }),
        el("b", {}, v === null || v === undefined ? "—" : fmt(v)), el("span", {}, s.name),
        s.detail && s.detail[active] ? el("span", { class: "d" }, `· ${s.detail[active]}`) : null));
    });
    if (o.kind === "stack" && o.totalName) {
      tip.append(el("div", { class: "r" }, el("i", { style: "background:transparent" }),
        el("b", {}, fmt(sum(o.series.map(s => s.values[active] || 0)))), el("span", {}, o.totalName)));
    }
    tip.hidden = false;
    const scale = box.clientWidth / W;
    const left = cx * scale, tw = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(box.clientWidth - tw, left + 12 > box.clientWidth - tw ? left - tw - 12 : left + 12))}px`;
    tip.style.top = `${padT * scale}px`;
  };
  const hide = () => { cross.setAttribute("visibility", "hidden"); hover.textContent = ""; tip.hidden = true; };
  svg.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect();
    show(Math.floor(((e.clientX - r.left) * W / r.width - padL) / band));
  });
  svg.addEventListener("pointerleave", hide);
  box.onkeydown = e => {
    if (e.key === "ArrowRight") { show(active < 0 ? n - 1 : active + 1); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { show(active < 0 ? n - 1 : active - 1); e.preventDefault(); }
    else if (e.key === "Escape") hide();
  };
  box.onfocus = () => show(n - 1);
  box.onblur = hide;
}

// ── Таблицы ────────────────────────────────────────────────────────────────
function frac(a, b) {
  return b ? [`${a}/${b}`, el("span", { class: "pct" }, fmtPct(pct(a, b)))] : "—";
}
function table(head, rows) {
  return el("div", { class: "tbl-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, head.map(h => el("th", {}, h)))),
    el("tbody", {}, rows)));
}

// ── Конверсия: общие куски «Звонков» и «Переписок» ─────────────────────────
// С 29.09.2026 отдельных вкладок «Конверсия» и «Не записались» нет (просьба
// заказчицы): конверсия и люди, с которыми надо поработать, живут в разделе
// своего канала, рядом с остальными цифрами по нему.
const REASONS = { service: "уточняли по своей записи", confirm: "подтверждали запись",
                  late: "предупреждали об опоздании", feedback: "отвечали на запрос впечатлений",
                  not_client: "писали не клиенты", other: "обращались не по услугам" };
const CH_COLOR = { calls: "--calls", messages: "--messages" };

function reasonsText(t) {
  // Все причины, а не две самые частые: иначе число «Не считали» не сходится
  // с расшифровкой под ним.
  return Object.entries(t.reasons).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${REASONS[k] || k} ${n}`).join(", ");
}
const periodLabel = days => `к пред. ${days.length} ${plural(days.length, "дню", "дням", "дням")}`;
const sinceNote = (first, days) => (first && first > days[0] ? ` · считаются с ${short(first)}` : "");

function convTiles(ch, days) {
  const before = prevDays(days), label = periodLabel(days);
  const c = convTotals(ch, days), cb = convTotals(ch, before);
  return [
    tile({ label: "Конверсия в запись", key: CH_COLOR[ch], value: fmtPct(pct(c.booked, c.clients)),
           sub: c.clients ? `${c.booked} из ${c.clients} записались` : "нет данных",
           delta: { now: pct(c.booked, c.clients), before: pct(cb.booked, cb.clients), unit: "pp", better: "up", label } }),
    tile({ label: "Первичные", key: "--primary", value: fmtPct(pct(c.primaryBooked, c.primary)),
           sub: c.primary ? `${c.primaryBooked} из ${c.primary} записались${sinceNote(firstDayWith(ch, "primary"), days)}` : "нет данных",
           delta: { now: pct(c.primaryBooked, c.primary), before: pct(cb.primaryBooked, cb.primary), unit: "pp", better: "up", label } }),
    tile({ label: "Не считали", value: String(c.excluded),
           sub: c.excluded ? reasonsText(c) : "запись и не предполагалась" }),
  ];
}

function convChart(ch) {
  const cd = chartDays();
  const at = d => (DATA.conversion[ch][d] ? convTotals(ch, [d]) : null);
  const totals = cd.map(at);
  const line = (num, den) => totals.map(t => (t && t[den] ? pct(t[num], t[den]) : null));
  const detail = (num, den) => totals.map(t => (t && t[den] ? `${t[num]} из ${t[den]}` : null));
  const firstPrimary = firstDayWith(ch, "primary");
  return el("div", { class: "card" },
    el("h2", {}, "Конверсия в запись по дням, %"),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · записались из обратившихся · ${periodCaption(cd)}` +
      (firstPrimary && firstPrimary > cd[0] ? ` · первичные — с ${short(firstPrimary)}` : "")),
    chart({ kind: "line", labels: cd.map(short), tipTitle: i => longDay(cd[i]), yMax: 100, fmt: v => `${ruNum(v)}%`,
            aria: `Конверсия ${ch === "calls" ? "звонков" : "переписок"} в запись по дням: все обратившиеся и первичные`,
            series: [{ name: "Все обратившиеся", color: CH_COLOR[ch], values: line("booked", "clients"), detail: detail("booked", "clients") },
                     { name: "Первичные", color: "--primary", values: line("primaryBooked", "primary"), detail: detail("primaryBooked", "primary") }] }));
}

function convByStudio(ch, days) {
  if (state.studio) return null;
  // У переписок рядом с конверсией — без ответа и замечания, доля от диалогов.
  const withProblems = ch === "messages";
  const cells = (t, p) => [el("td", {}, frac(t.booked, t.clients)),
    el("td", {}, t.primary ? frac(t.primaryBooked, t.primary) : "—"),
    withProblems ? el("td", {}, p.n_dialogs ? frac(p.n_unanswered, p.n_dialogs) : "—") : null,
    withProblems ? el("td", {}, p.n_dialogs ? frac(p.n_ai_issues, p.n_dialogs) : "—") : null,
    el("td", {}, String(t.excluded || "—"))];
  const rows = DATA.studios.map(s => {
    const t = convTotals(ch, days, s), p = msgTotals(days, s);
    if (!t.clients && !t.excluded && !(withProblems && p.n_dialogs)) return null;
    return el("tr", { class: "click", onclick: () => setStudio(s) }, el("td", {}, s), cells(t, p));
  }).filter(Boolean);
  if (!rows.length) return null;
  rows.push(el("tr", { class: "total" }, el("td", {}, "Вся сеть"), cells(convTotals(ch, days), msgTotals(days))));
  return el("div", { class: "card" }, el("h2", {}, "По студиям"),
    el("p", { class: "cap" }, `${periodCaption(days)} · нажмите на студию, чтобы посмотреть только её`),
    table(["Студия", "Записались", "Первичные", ...(withProblems ? ["Без ответа", "С замечаниями"] : []), "Не считали"], rows));
}

// Проблемы переписок по дням (msgstats/): диалоги, без ответа, с замечаниями.
function msgTotals(days, studio = state.studio) {
  const t = { n_dialogs: 0, n_unanswered: 0, n_ai_issues: 0, daysWithData: 0 };
  for (const day of days) {
    const snap = (DATA.msgstats || {})[day];
    if (!snap) continue;
    t.daysWithData++;
    for (const [name, r] of Object.entries(snap.studios || {})) {
      if (studio && name !== studio) continue;
      t.n_dialogs += r.n_dialogs || 0; t.n_unanswered += r.n_unanswered || 0; t.n_ai_issues += r.n_ai_issues || 0;
    }
  }
  return t;
}

function convNote(ch, days) {
  const first = firstDayWith(ch, "no_booking_expected");
  return el("div", { class: "note-box" },
    "Запись — новая запись в YClients, созданная в день обращения; перенос визита по просьбе клиента тоже считается записью. ",
    "В конверсию не входят обращения, где записи и не ждали («Не считали»). Отмены остаются — это шанс перезаписать клиента.",
    first && first > days[0]
      ? ` Такие обращения вычёркиваются с ${short(first)}; за более ранние дни они входят в расчёт, и конверсия там ниже.` : "");
}

// ── Кто требует внимания: таблица с тегами ─────────────────────────────────
// Строка — человек за день: студия, телефон (или имя, если номера нет), теги
// и комментарий. Тегов у строки может быть несколько: пропустили, не
// перезвонили и не записался — это один и тот же человек.
const TAGS = {
  unbooked:   { label: "не записался", cls: "t-unbooked" },
  unanswered: { label: "не ответили", cls: "t-bad" },
  nocallback: { label: "не перезвонили", cls: "t-bad" },
  critical:   { label: "⚠ критичное замечание", cls: "t-bad" },
  issue:      { label: "замечание", cls: "t-issue" },
};
const TAG_FILTERS = {
  calls: [["all", "Все"], ["unbooked", "Не записались"], ["nocallback", "Не перезвонили"], ["issue", "Замечания"]],
  messages: [["all", "Все"], ["unbooked", "Не записались"], ["unanswered", "Не ответили"], ["issue", "Замечания"]],
};
const tagMatches = (row, f) => f === "all" || row.tags.has(f) || (f === "issue" && row.tags.has("critical"));

function peopleRows(ch, days) {
  const out = [];
  let trimmed = false;
  for (const day of [...days].reverse()) {
    const conv = DATA.conversion[ch][day];
    if (conv && conv.lists_trimmed) trimmed = true;
    const cs = ch === "calls" ? DATA.calls[day] : null;
    const ms = ch === "messages" ? (DATA.msgstats || {})[day] : null;
    for (const studio of studioNames()) {
      const byKey = new Map();
      const row = (phone, name) => {
        const key = phone || `имя:${name}`;
        if (!byKey.has(key)) byKey.set(key, { day, studio, phone: phone || "", name: name || "", tags: new Set(), notes: [] });
        const r = byKey.get(key);
        if (!r.name && name) r.name = name;
        return r;
      };
      for (const u of ((conv && conv.studios) || {})[studio]?.unbooked || []) {
        const r = row(u.phone, u.name);
        r.tags.add("unbooked");
        if (u.note) r.notes.push(u.note);
      }
      const s = ((cs && cs.studios) || {})[studio] || {};
      for (const p of s.missed_no_callback || []) row(p, "").tags.add("nocallback");
      if (cs && cs.source !== "backfill") {
        for (const it of s.issues || []) {
          const r = row(it.phone, "");
          r.tags.add(it.severity >= 3 ? "critical" : "issue");
          r.notes.push(it);
        }
      }
      // Переписки: без ответа и замечания модели (со 2-го этапа, 29.09.2026)
      const m = ((ms && ms.studios) || {})[studio] || {};
      for (const u of m.unanswered || []) {
        const r = row(u.phone, u.name);
        r.tags.add("unanswered");
        r.notes.push({ kind: "unanswered", time: u.time, text: u.preview });
      }
      for (const it of m.issues || []) {
        const r = row(it.phone, it.name);
        r.tags.add("issue");
        r.notes.push({ kind: "msg-issue", time: it.time, text: it.text });
      }
      // Заметка конверсии «без ответа — «…»» повторяет строку «не ответили»,
      // у которой есть ещё и время, — оставляем одну.
      for (const r of byKey.values()) {
        if (r.tags.has("unanswered")) r.notes = r.notes.filter(n => !(typeof n === "string" && n.startsWith("без ответа")));
      }
      out.push(...byKey.values());
    }
  }
  return { rows: out, trimmed };
}

function noteNode(n) {
  if (typeof n === "string") return el("div", { class: "cm" }, n);
  if (n.kind === "unanswered") return el("div", { class: "cm" },
    n.time ? el("span", { class: "time" }, n.time) : null, `«${n.text || ""}» — без ответа`);
  if (n.kind === "msg-issue") return el("div", { class: "cm" },
    n.time ? el("span", { class: "time" }, n.time) : null, n.text || "");
  // замечание по звонку: время, направление, итог разговора и сами замечания
  return el("div", { class: "cm" },
    el("span", { class: "time" }, `${n.time || ""} ${n.direction === "in" ? "↙ входящий" : "↗ исходящий"}`),
    n.summary ? ` ${n.summary}` : "",
    (n.issues || []).length ? el("ul", {}, n.issues.map(x => el("li", {}, x))) : null);
}

const PAGE = 100;
function peopleCard(ch, days) {
  const { rows, trimmed } = peopleRows(ch, days);
  const filters = TAG_FILTERS[ch];
  if (!filters.some(([id]) => id === state.tagFilter[ch])) state.tagFilter[ch] = "all";
  const card = el("div", { class: "card people" });
  const title = "Кто требует внимания";
  card.append(el("h2", {}, title),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · ${periodCaption(days)} · строка — человек за день`));

  const chips = el("div", { class: "chips", role: "group", "aria-label": "Показать" });
  const search = el("input", { class: "search", type: "search", placeholder: "Телефон, имя, текст",
                               value: state.query, "aria-label": "Поиск по таблице" });
  const body = el("div", {});
  card.append(el("div", { class: "tools" }, filters.length > 1 ? chips : null, search), body);

  const draw = (limit = PAGE) => {
    const q = state.query.trim().toLowerCase();
    const noteText = n => (typeof n === "string" ? n : `${n.summary || ""} ${n.text || ""} ${(n.issues || []).join(" ")}`);
    const hay = r => `${r.phone} ${r.name} ${r.notes.map(noteText).join(" ")}`.toLowerCase();
    const searched = q ? rows.filter(r => hay(r).includes(q)) : rows;
    chips.textContent = "";
    filters.forEach(([id, lab]) => {
      const n = searched.filter(r => tagMatches(r, id)).length;
      chips.append(el("button", { type: "button", "aria-pressed": String(id === state.tagFilter[ch]),
        onclick: () => { state.tagFilter[ch] = id; draw(); } }, lab, el("span", { class: "n" }, String(n))));
    });
    const shown = searched.filter(r => tagMatches(r, state.tagFilter[ch]));
    body.textContent = "";
    if (!shown.length) {
      body.append(el("div", { class: "empty-box" }, rows.length ? "Ничего не нашлось" : "За этот период никого нет"));
      return;
    }
    body.append(el("div", { class: "tbl-wrap" }, el("table", { class: "ppl" },
      el("thead", {}, el("tr", {}, ["Дата", "Студия", "Клиент", "Теги", "Комментарий"].map(h => el("th", {}, h)))),
      el("tbody", {}, shown.slice(0, limit).map(r => el("tr", {},
        el("td", { "data-l": "Дата" }, short(r.day)),
        el("td", { "data-l": "Студия" }, r.studio),
        el("td", { "data-l": "Клиент", class: "who" }, phoneLink(r.phone) || r.name || "без номера",
          r.phone && r.name ? el("span", { class: "nm" }, r.name) : null),
        el("td", { "data-l": "Теги", class: "tags" }, Object.keys(TAGS).filter(t => r.tags.has(t))
          .map(t => el("span", { class: `tag ${TAGS[t].cls}` }, TAGS[t].label))),
        el("td", { "data-l": "Комментарий", class: "cmt" }, r.notes.length ? r.notes.map(noteNode) : "—")))))));
    if (shown.length > limit) {
      body.append(el("button", { class: "more", type: "button", onclick: () => draw(limit + PAGE) },
        `Показать ещё (${shown.length - limit})`));
    }
  };
  search.addEventListener("input", () => { state.query = search.value; draw(); });
  draw();
  if (trimmed) card.append(el("p", { class: "cap", style: "margin-top:8px" },
    "Списки хранятся за последние 62 дня, по более ранним дням остались только цифры."));
  return card;
}

// ── Раздел «Звонки» ────────────────────────────────────────────────────────
function viewCalls(root) {
  const days = periodDays(), before = prevDays(days);
  const label = periodLabel(days);
  const t = callTotals(days), tb = callTotals(before);
  const [convTile, primaryTile, exclTile] = convTiles("calls", days);
  const answered = t.in_total - t.in_missed, answeredB = tb.in_total - tb.in_missed;
  root.append(el("div", { class: "tiles six" },
    tile({ label: "Входящие", value: t.daysWithData ? String(t.in_total) : "—",
           sub: t.daysWithData ? `исходящих ${t.out_total}, без ответа ${t.out_noanswer}` : "нет данных",
           delta: { now: t.in_total, before: tb.daysWithData ? tb.in_total : null, unit: "pct", better: "up", label } }),
    tile({ label: "Принято", value: fmtPct(pct(answered, t.in_total)), sub: t.in_total ? `${answered} из ${t.in_total}` : "",
           delta: { now: pct(answered, t.in_total), before: tb.daysWithData ? pct(answeredB, tb.in_total) : null, unit: "pp", better: "up", label } }),
    tile({ label: "Пропущено", key: "--bad", value: String(t.in_missed),
           sub: `не перезвонили ${t.noCallback}, перезвонили ${t.in_missed_callback}`,
           delta: { now: t.in_missed, before: tb.daysWithData ? tb.in_missed : null, unit: "pct", better: "down", label } }),
    convTile, primaryTile, exclTile));

  const cd = chartDays();
  const val = (d, f) => (DATA.calls[d] ? callTotals([d])[f] : null);
  root.append(el("div", { class: "card" },
    el("h2", {}, "Входящие по дням"),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · ${periodCaption(cd)}`),
    chart({ kind: "stack", labels: cd.map(short), tipTitle: i => longDay(cd[i]), totalName: "всего",
            aria: "Входящие звонки по дням: принято и пропущено",
            series: [{ name: "Принято", color: "--neutral", values: cd.map(d => { const v = val(d, "in_total"); return v === null ? null : v - val(d, "in_missed"); }) },
                     { name: "⚠ Пропущено", color: "--bad", values: cd.map(d => val(d, "in_missed")) }] })));
  root.append(convChart("calls"));
  const byStudio = convByStudio("calls", days);
  if (byStudio) root.append(byStudio);
  root.append(peopleCard("calls", days));

  const restored = [...days].filter(d => DATA.calls[d] && DATA.calls[d].source === "backfill");
  if (restored.length) root.append(el("div", { class: "note-box" },
    `По ${restored.length} ${plural(restored.length, "дню", "дням", "дням")} (${restored.map(short).join(", ")}) звонки восстановлены задним числом: ` +
    "цифры есть, а разбора разговоров тогда ещё не было."));
  root.append(convNote("calls", days));
}

// ── Раздел «Переписки» ─────────────────────────────────────────────────────
const MQ = ["n_dialogs", "n_new_bookings", "n_unanswered", "n_first_time", "n_first_time_booked", "n_ai_issues"];
function mqTotals(rows) {
  const t = Object.fromEntries(MQ.map(f => [f, 0]));
  let resp = 0;
  for (const [name, r] of Object.entries(rows || {})) {
    if (state.studio && name !== state.studio) continue;
    for (const f of MQ) t[f] += r[f] || 0;
    resp += (r.avg_response_sec || 0) * (r.n_dialogs || 0);
  }
  t.respMin = t.n_dialogs ? Math.round(resp / t.n_dialogs / 6) / 10 : null;
  return t;
}
const weekLabel = w => `${short(w.start)}–${short(w.end)}`;

function viewMessages(root) {
  // Конверсия — по дням, за выбранный период, как в «Звонках».
  const days = periodDays();
  // У «Обратились» нет сравнения с прошлым периодом: число зависит от того,
  // за сколько дней есть срезы и вычёркивались ли «не считали» (с 20.09), —
  // стрелка показала бы не поток клиентов, а смену правил счёта.
  const c = convTotals("messages", days);
  root.append(el("div", { class: "tiles" },
    tile({ label: "Обратились", value: c.daysWithData ? String(c.clients) : "—",
           sub: c.daysWithData ? `написали сами, без «не считали» · данных за ${c.daysWithData} из ${days.length} дн.` : "нет данных" }),
    ...convTiles("messages", days)));
  root.append(convChart("messages"));

  // Без ответа и замечания — доля от диалогов, по дням (msgstats/: цифры с
  // июля, списки людей — с 29.09.2026).
  const p = msgTotals(days), pb = msgTotals(prevDays(days));
  const plabel = periodLabel(days);
  root.append(el("div", { class: "tiles three" },
    tile({ label: "Диалогов", value: p.daysWithData ? String(p.n_dialogs) : "—",
           sub: p.daysWithData ? `данных за ${p.daysWithData} из ${days.length} дн.` : "нет данных" }),
    tile({ label: "⚠ Без ответа", key: "--bad", value: fmtPct(pct(p.n_unanswered, p.n_dialogs)),
           sub: p.n_dialogs ? `${p.n_unanswered} из ${p.n_dialogs} диалогов` : "",
           delta: { now: pct(p.n_unanswered, p.n_dialogs), before: pb.n_dialogs ? pct(pb.n_unanswered, pb.n_dialogs) : null,
                    unit: "pp", better: "down", label: plabel } }),
    tile({ label: "С замечаниями", key: "--issue", value: fmtPct(pct(p.n_ai_issues, p.n_dialogs)),
           sub: p.n_dialogs ? `${p.n_ai_issues} из ${p.n_dialogs} диалогов` : "",
           delta: { now: pct(p.n_ai_issues, p.n_dialogs), before: pb.n_dialogs ? pct(pb.n_ai_issues, pb.n_dialogs) : null,
                    unit: "pp", better: "down", label: plabel } })));
  const cd = chartDays();
  const pt = cd.map(d => ((DATA.msgstats || {})[d] ? msgTotals([d]) : null));
  const share = f => pt.map(t => (t && t.n_dialogs ? pct(t[f], t.n_dialogs) : null));
  const count = f => pt.map(t => (t && t.n_dialogs ? `${t[f]} из ${t.n_dialogs}` : null));
  root.append(el("div", { class: "card" },
    el("h2", {}, "Без ответа и замечания по дням, % от диалогов"),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · ${periodCaption(cd)}`),
    chart({ kind: "line", labels: cd.map(short), tipTitle: i => longDay(cd[i]), fmt: v => `${ruNum(v)}%`,
            aria: "Доля диалогов без ответа и с замечаниями по дням",
            series: [{ name: "⚠ Без ответа", color: "--bad", values: share("n_unanswered"), detail: count("n_unanswered") },
                     { name: "С замечаниями", color: "--issue", values: share("n_ai_issues"), detail: count("n_ai_issues") }] })));

  const byStudio = convByStudio("messages", days);
  if (byStudio) root.append(byStudio);
  root.append(peopleCard("messages", days));
  root.append(convNote("messages", days));

  // Качество — по неделям: так его считает недельный отчёт.
  root.append(el("div", { class: "section-title" }, "Качество переписок по неделям"));
  const weeks = (DATA.messages_quality.weeks || []).slice(-12);
  if (!weeks.length) { root.append(el("div", { class: "empty-box" }, "Нет недельной статистики")); return; }
  const cur = mqTotals(weeks[weeks.length - 1].studios), prev = weeks.length > 1 ? mqTotals(weeks[weeks.length - 2].studios) : null;
  const label = "к пред. неделе";
  const d = (now, before, unit, better) => ({ now, before: prev ? before : null, unit, better, label });
  root.append(el("div", { class: "note-box" }, `Последняя полная неделя — ${weekLabel(weeks[weeks.length - 1])}.`));
  root.append(el("div", { class: "tiles six" },
    tile({ label: "Диалоги", value: String(cur.n_dialogs), delta: d(cur.n_dialogs, prev && prev.n_dialogs, "pct", "up") }),
    tile({ label: "Записи", value: String(cur.n_new_bookings), sub: `${fmtPct(pct(cur.n_new_bookings, cur.n_dialogs))} от диалогов`,
           delta: d(pct(cur.n_new_bookings, cur.n_dialogs), prev && pct(prev.n_new_bookings, prev.n_dialogs), "pp", "up") }),
    tile({ label: "Конверсия первичных", value: fmtPct(pct(cur.n_first_time_booked, cur.n_first_time)),
           sub: `${cur.n_first_time_booked} из ${cur.n_first_time}`,
           delta: d(pct(cur.n_first_time_booked, cur.n_first_time), prev && pct(prev.n_first_time_booked, prev.n_first_time), "pp", "up") }),
    tile({ label: "Без ответа", value: String(cur.n_unanswered), sub: `${fmtPct(pct(cur.n_unanswered, cur.n_dialogs))} от диалогов`,
           delta: d(pct(cur.n_unanswered, cur.n_dialogs), prev && pct(prev.n_unanswered, prev.n_dialogs), "pp", "down") }),
    tile({ label: "Замечания", value: String(cur.n_ai_issues), sub: `${fmtPct(pct(cur.n_ai_issues, cur.n_dialogs))} от диалогов`,
           delta: d(pct(cur.n_ai_issues, cur.n_dialogs), prev && pct(prev.n_ai_issues, prev.n_dialogs), "pp", "down") }),
    tile({ label: "Время ответа", value: cur.respMin === null ? "—" : `${ruNum(cur.respMin)} мин`,
           delta: d(cur.respMin, prev && prev.respMin, "abs", "down") })));

  const labels = weeks.map(w => short(w.start));
  const tipTitle = i => `Неделя ${weekLabel(weeks[i])}`;
  const series = f => weeks.map(w => { const t = mqTotals(w.studios); return t.n_dialogs ? f(t) : null; });
  const small = (title, name, f, fmt, yMax, integer) => el("div", { class: "card" }, el("h2", {}, title),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · по неделям`),
    chart({ kind: "line", labels, tipTitle, fmt, yMax, integer, height: 160, aria: title,
            series: [{ name, color: "--messages", values: series(f) }] }));
  // Без ответа и замечания — выше, по дням; здесь — то, что есть только по неделям.
  root.append(el("div", { class: "grid2" },
    small("Диалоги", "диалогов", t => t.n_dialogs, ruNum, undefined, true),
    small("Время ответа, мин", "минут", t => t.respMin, ruNum)));

  const card = el("div", { class: "card" }, el("h2", {}, `По студиям · неделя ${weekLabel(weeks[weeks.length - 1])}`));
  const last = weeks[weeks.length - 1].studios;
  const rows = DATA.studios.filter(s => last[s]).map(s => {
    const r = last[s];
    return el("tr", { class: state.studio ? "" : "click", onclick: state.studio ? null : () => setStudio(s) },
      el("td", {}, s), el("td", {}, frac(r.n_new_bookings, r.n_dialogs)), el("td", {}, frac(r.n_first_time_booked, r.n_first_time)),
      el("td", {}, String(r.n_unanswered)), el("td", {}, String(r.n_ai_issues)),
      el("td", {}, `${ruNum((r.avg_response_sec || 0) / 60)} мин`));
  });
  card.append(table(["Студия", "Записи", "Первичные", "Без ответа", "Замечания", "Ответ"], rows));
  root.append(card);

  const cw = (DATA.messages_quality.days || []).filter(x => x.date > weeks[weeks.length - 1].end);
  if (cw.length) {
    const t = { n_dialogs: 0, n_new_bookings: 0 };
    for (const x of cw) { const s = mqTotals(x.studios); t.n_dialogs += s.n_dialogs; t.n_new_bookings += s.n_new_bookings; }
    root.append(el("div", { class: "note-box" },
      `Текущая неделя, ${cw.length} ${plural(cw.length, "день", "дня", "дней")}: ${t.n_dialogs} диалогов, ${t.n_new_bookings} записей. ` +
      "В недельные графики она войдёт, когда закончится."));
  }
}

// ── Раздел «Отзывы» ────────────────────────────────────────────────────────
function starsNode(n) {
  return el("span", { class: "stars", title: `${n} из 5`, "aria-label": `${n} из 5` },
    "★".repeat(Math.max(0, n)), el("span", { class: "off" }, "★".repeat(Math.max(0, 5 - n))));
}
const mondayOf = s => { const d = parseDay(s); const k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return iso(d); };

function viewReviews(root) {
  const days = periodDays();
  const inPeriod = r => r.date >= days[0] && r.date <= days[days.length - 1] && (!state.studio || r.studio === state.studio);
  const list = DATA.reviews.filter(inPeriod);
  const neg = list.filter(r => r.stars && r.stars <= 3);
  const rated = list.filter(r => r.stars);
  const avg = rated.length ? Math.round(10 * sum(rated.map(r => r.stars)) / rated.length) / 10 : null;
  root.append(el("div", { class: "tiles" },
    tile({ label: "Средняя оценка", value: avg === null ? "—" : ruNum(avg), sub: `${rated.length} ${plural(rated.length, "оценка", "оценки", "оценок")}` }),
    tile({ label: "Отзывов", value: String(list.length), sub: periodCaption(days) }),
    tile({ label: "Негативных (1–3★)", key: "--bad", value: String(neg.length) }),
    tile({ label: "Площадки", value: String(new Set(list.map(r => r.source).filter(Boolean)).size),
           sub: [...new Set(list.map(r => r.source).filter(Boolean))].join(", ") || "—" })));

  // По неделям: последние 12, 4–5★ фоном, 1–3★ — статусным красным.
  const lastMon = mondayOf(yesterday());
  const weeks = Array.from({ length: 12 }, (_, i) => addDays(lastMon, -7 * (11 - i)));
  const bucket = (w, pred) => DATA.reviews.filter(r => r.date >= w && r.date <= addDays(w, 6)
    && (!state.studio || r.studio === state.studio) && pred(r)).length;
  root.append(el("div", { class: "card" }, el("h2", {}, "Отзывы по неделям"),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · последние 12 недель`),
    chart({ kind: "stack", labels: weeks.map(short), tipTitle: i => `Неделя с ${short(weeks[i])}`, totalName: "всего",
            aria: "Отзывы по неделям: 4–5 звёзд и 1–3 звезды",
            series: [{ name: "4–5★", color: "--neutral", values: weeks.map(w => bucket(w, r => r.stars >= 4)) },
                     { name: "⚠ 1–3★", color: "--bad", values: weeks.map(w => bucket(w, r => r.stars && r.stars <= 3)) }] })));

  root.append(el("div", { class: "section-title" }, "Отзывы за период"));
  if (!list.length) { root.append(el("div", { class: "empty-box" }, "Отзывов за этот период нет")); return; }
  root.append(el("div", { class: "group" }, list.map(r => el("div", { class: `person${r.stars && r.stars <= 3 ? " neg" : ""}` },
    el("span", { class: "ch" }, ""),
    el("div", { class: "who" }, starsNode(r.stars), el("span", { class: "nm" }, `${r.studio} · ${r.source} · ${longDay(r.date)}`)),
    el("div", { class: "note" }, r.text || "без текста",
      r.client || r.phone ? el("div", { style: "margin-top:4px;color:var(--muted)" }, r.client, " ", phoneLink(r.phone)) : null)))));
}

// ── Каркас ─────────────────────────────────────────────────────────────────
const TABS = [
  { id: "calls", label: "Звонки", view: viewCalls },
  { id: "messages", label: "Переписки", view: viewMessages },
  { id: "reviews", label: "Отзывы", view: viewReviews },
];

function setStudio(s) { state.studio = s; save(); render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
function save() {
  try { localStorage.setItem("fr-cs-view", JSON.stringify({ tab: state.tab, studio: state.studio, period: state.period })); }
  catch (e) { /* не страшно */ }
}
function restore() {
  try {
    const v = JSON.parse(localStorage.getItem("fr-cs-view") || "{}");
    if (TABS.some(t => t.id === v.tab)) state.tab = v.tab;
    if (!v.studio || DATA.studios.includes(v.studio)) state.studio = v.studio || "";
    if (PERIODS.some(p => p.id === v.period)) state.period = v.period;
  } catch (e) { /* по умолчанию */ }
}

function renderFilters() {
  const f = $("#filters");
  f.textContent = "";
  const sel = el("select", { "aria-label": "Студия" },
    el("option", { value: "" }, "Вся сеть"),
    DATA.studios.map(s => el("option", { value: s, selected: s === state.studio }, s)));
  sel.addEventListener("change", () => setStudio(sel.value));
  f.append(sel);
  f.append(el("div", { class: "seg", role: "group", "aria-label": "Период" },
    PERIODS.map(p => el("button", { type: "button", "aria-pressed": String(p.id === state.period),
      onclick: () => { state.period = p.id; save(); render(); } }, p.label))));
}

function renderTabs() {
  const t = $("#tabs");
  t.textContent = "";
  TABS.forEach(tab => t.append(el("button", { class: "tab", role: "tab", type: "button",
    "aria-selected": String(tab.id === state.tab),
    onclick: () => { state.tab = tab.id; save(); render(); } }, tab.label)));
}

function renderContent() {
  charts = [];
  const root = $("#content");
  root.textContent = "";
  TABS.find(t => t.id === state.tab).view(root);
  charts.forEach(f => f());
}

function render() { renderTabs(); renderFilters(); renderContent(); }

function start() {
  restore();
  const gen = new Date(DATA.generated_at);
  $("#updated").textContent = `Данные по ${longDay(yesterday())}\nобновлено ${gen.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`;
  render();
  let t = 0;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => charts.forEach(f => f()), 150); });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  if (mq.addEventListener) mq.addEventListener("change", () => charts.forEach(f => f()));
}

// ── Тема ───────────────────────────────────────────────────────────────────
function applyTheme(t) {
  if (t) document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
  if (DATA) charts.forEach(f => f());
}
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem("fr-cs-theme"); } catch (e) { /* нет хранилища */ }
  applyTheme(t);
  const btn = $("#theme");
  btn.addEventListener("click", () => {
    const dark = document.documentElement.getAttribute("data-theme") === "dark"
      || (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    try { localStorage.setItem("fr-cs-theme", next); } catch (e) { /* не страшно */ }
    applyTheme(next);
  });
})();

// ── Вход ───────────────────────────────────────────────────────────────────
$("#enter").addEventListener("click", () => enter($("#pwd").value));
$("#pwd").addEventListener("keydown", e => { if (e.key === "Enter") enter($("#pwd").value); });
$("#logout").addEventListener("click", () => {
  try { sessionStorage.removeItem("fr-cs"); } catch (e) { /* ничего */ }
  location.reload();
});
(function autoEnter() {
  let saved = null;
  try { saved = sessionStorage.getItem("fr-cs"); } catch (e) { /* ничего */ }
  if (saved) { $("#pwd").value = saved; enter(saved); }
})();
