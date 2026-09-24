/* FaceRoom · кабинет управляющего.

   Данные лежат рядом в data.enc.json зашифрованными (PBKDF2-SHA256 + AES-256-GCM):
   репозиторий публичный, а в данных телефоны клиентов. Расшифровка — здесь, в
   браузере, паролем управляющих; наружу ничего не отправляется.

   Весь текст из данных (имена, заметки, отзывы) вставляется через textContent:
   это чужой текст, и разметкой он быть не должен. */
"use strict";

let DATA = null;
const state = { tab: "conversion", studio: "", period: "7d", channel: "all", query: "" };

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
  // opts: {kind: "line"|"stack", labels, series: [{name, color, values}], yMax, fmt, height, tipTitle}
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
      opts.series.map(s => el("td", {}, s.values[i] === null || s.values[i] === undefined ? "—" : fmt(s.values[i]))))))));
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
        el("b", {}, v === null || v === undefined ? "—" : fmt(v)), el("span", {}, s.name)));
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

// ── Раздел «Конверсия» ─────────────────────────────────────────────────────
const REASONS = { service: "уточняли по своей записи", confirm: "подтверждали запись",
                  late: "предупреждали об опоздании", feedback: "отвечали на запрос впечатлений",
                  not_client: "писали не клиенты", other: "обращались не по услугам" };

function viewConversion(root) {
  const days = periodDays(), before = prevDays(days);
  const label = `к пред. ${days.length} ${plural(days.length, "дню", "дням", "дням")}`;
  const c = convTotals("calls", days), cb = convTotals("calls", before);
  const m = convTotals("messages", days), mb = convTotals("messages", before);
  const excluded = c.excluded + m.excluded;
  const reasons = {};
  for (const t of [c, m]) for (const [k, n] of Object.entries(t.reasons)) reasons[k] = (reasons[k] || 0) + n;
  const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([k, n]) => `${REASONS[k] || k} ${n}`).join(", ");
  const firstPrimary = firstDayWith("calls", "primary");
  const firstExcl = [firstDayWith("calls", "no_booking_expected"), firstDayWith("messages", "no_booking_expected")]
    .filter(Boolean).sort().pop() || null;

  root.append(el("div", { class: "tiles" },
    tile({ label: "Звонки", key: "--calls", value: fmtPct(pct(c.booked, c.clients)),
           sub: c.clients ? `${c.booked} из ${c.clients} записались` : "нет данных",
           delta: { now: pct(c.booked, c.clients), before: pct(cb.booked, cb.clients), unit: "pp", better: "up", label } }),
    tile({ label: "Переписки", key: "--messages", value: fmtPct(pct(m.booked, m.clients)),
           sub: m.clients ? `${m.booked} из ${m.clients} записались` : "нет данных",
           delta: { now: pct(m.booked, m.clients), before: pct(mb.booked, mb.clients), unit: "pp", better: "up", label } }),
    tile({ label: "Первичные по звонкам", value: fmtPct(pct(c.primaryBooked, c.primary)),
           sub: c.primary ? `${c.primaryBooked} из ${c.primary} записались` +
                  (firstPrimary && firstPrimary > days[0] ? ` · считаются с ${short(firstPrimary)}` : "")
                : "нет данных",
           delta: { now: pct(c.primaryBooked, c.primary), before: pct(cb.primaryBooked, cb.primary), unit: "pp", better: "up", label } }),
    tile({ label: "Не считали", value: String(excluded),
           sub: excluded ? topReasons : "запись и не предполагалась" })));

  const cd = chartDays();
  const series = ch => cd.map(d => {
    if (!DATA.conversion[ch][d]) return null;
    const t = convTotals(ch, [d]);
    return t.clients ? pct(t.booked, t.clients) : null;
  });
  root.append(el("div", { class: "card" },
    el("h2", {}, "Конверсия по дням, %"),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · записались из обратившихся · ${periodCaption(cd)}`),
    chart({ kind: "line", labels: cd.map(short), tipTitle: i => longDay(cd[i]), yMax: 100, fmt: v => `${ruNum(v)}%`,
            aria: "Конверсия звонков и переписок по дням",
            series: [{ name: "Звонки", color: "--calls", values: series("calls") },
                     { name: "Переписки", color: "--messages", values: series("messages") }] })));

  // По студиям — или по дням, если студия выбрана.
  const card = el("div", { class: "card" });
  if (!state.studio) {
    card.append(el("h2", {}, "По студиям"), el("p", { class: "cap" }, `${periodCaption(days)} · нажмите на студию, чтобы посмотреть только её`));
    const rows = DATA.studios.map(s => {
      const sc = convTotals("calls", days, s), sm = convTotals("messages", days, s);
      if (!sc.clients && !sm.clients) return null;
      return el("tr", { class: "click", onclick: () => setStudio(s) },
        el("td", {}, s), el("td", {}, frac(sc.booked, sc.clients)), el("td", {}, frac(sm.booked, sm.clients)),
        el("td", {}, sc.primary ? frac(sc.primaryBooked, sc.primary) : "—"));
    }).filter(Boolean);
    rows.push(el("tr", { class: "total" }, el("td", {}, "Вся сеть"), el("td", {}, frac(c.booked, c.clients)),
      el("td", {}, frac(m.booked, m.clients)), el("td", {}, c.primary ? frac(c.primaryBooked, c.primary) : "—")));
    card.append(table(["Студия", "Звонки", "Переписки", "Первичные (зв.)"], rows));
  } else {
    card.append(el("h2", {}, `${state.studio} по дням`), el("p", { class: "cap" }, periodCaption(days)));
    const rows = [...days].reverse().map(d => {
      const sc = convTotals("calls", [d]), sm = convTotals("messages", [d]);
      if (!sc.daysWithData && !sm.daysWithData) return null;
      return el("tr", {}, el("td", {}, longDay(d)), el("td", {}, frac(sc.booked, sc.clients)),
        el("td", {}, frac(sm.booked, sm.clients)));
    }).filter(Boolean);
    card.append(rows.length ? table(["День", "Звонки", "Переписки"], rows) : el("div", { class: "empty-box" }, "Нет данных за период"));
  }
  root.append(card);
  root.append(el("div", { class: "note-box" },
    "Запись — новая запись в YClients, созданная в день обращения. В конверсию не входят обращения, где записи ",
    "и не ждали: подтверждение визита, опоздание, ответ на запрос впечатлений, коллеги и поставщики. ",
    "Отмены и переносы остаются — это шанс перезаписать клиента.",
    firstExcl && firstExcl > days[0]
      ? ` Такие обращения вычёркиваются с ${short(firstExcl)}; за более ранние дни они входят в расчёт, и конверсия там ниже.`
      : ""));
}

// ── Раздел «Не записались» ─────────────────────────────────────────────────
function viewUnbooked(root) {
  const days = [...periodDays()].reverse();
  const q = state.query.trim().toLowerCase();
  let total = 0, trimmed = false;
  const out = el("div", {});
  for (const day of days) {
    const groups = [];
    for (const studio of studioNames()) {
      const people = [];
      for (const ch of ["calls", "messages"]) {
        if (state.channel !== "all" && state.channel !== ch) continue;
        const snap = DATA.conversion[ch][day];
        if (!snap) continue;
        if (snap.lists_trimmed) trimmed = true;
        for (const u of ((snap.studios || {})[studio] || {}).unbooked || []) {
          const hay = `${u.phone} ${u.name} ${u.note}`.toLowerCase();
          if (q && !hay.includes(q)) continue;
          people.push({ ...u, ch });
        }
      }
      if (people.length) groups.push({ studio, people });
    }
    if (!groups.length) continue;
    const n = sum(groups.map(g => g.people.length));
    total += n;
    out.append(el("div", { class: "day" },
      el("h3", {}, longDay(day), el("span", {}, `· ${n}`)),
      groups.map(g => el("div", { class: "group" },
        el("h4", {}, g.studio, el("span", { class: "cnt" }, String(g.people.length))),
        g.people.map(p => el("div", { class: "person" },
          el("span", { class: "ch", title: p.ch === "calls" ? "Звонок" : "Переписка" }, p.ch === "calls" ? "📞" : "💬"),
          el("div", { class: "who" }, phoneLink(p.phone) || "без номера", p.name ? el("span", { class: "nm" }, p.name) : null),
          p.note ? el("div", { class: "note" }, p.note) : null))))));
  }
  root.append(el("div", { class: "note-box" },
    total ? `За ${periodCaption()} — ${total} ${plural(total, "человек", "человека", "человек")}: обратились и не записались в тот же день.`
          : "За этот период никого нет.",
    trimmed ? " Списки хранятся за последние 62 дня, по более ранним дням остались только цифры." : ""));
  root.append(out);
}

// ── Раздел «Звонки» ────────────────────────────────────────────────────────
function viewCalls(root) {
  const days = periodDays(), before = prevDays(days);
  const label = `к пред. ${days.length} ${plural(days.length, "дню", "дням", "дням")}`;
  const t = callTotals(days), tb = callTotals(before);
  if (!t.daysWithData) {
    root.append(el("div", { class: "empty-box" }, "Нет данных по звонкам за этот период")); return;
  }
  const answered = t.in_total - t.in_missed, answeredB = tb.in_total - tb.in_missed;
  root.append(el("div", { class: "tiles six" },
    tile({ label: "Входящие", value: String(t.in_total),
           delta: { now: t.in_total, before: tb.daysWithData ? tb.in_total : null, unit: "pct", better: "up", label } }),
    tile({ label: "Принято", value: fmtPct(pct(answered, t.in_total)), sub: `${answered} из ${t.in_total}`,
           delta: { now: pct(answered, t.in_total), before: tb.daysWithData ? pct(answeredB, tb.in_total) : null, unit: "pp", better: "up", label } }),
    tile({ label: "Пропущено", key: "--bad", value: String(t.in_missed), sub: "не перезвонили за 10 минут",
           delta: { now: t.in_missed, before: tb.daysWithData ? tb.in_missed : null, unit: "pct", better: "down", label } }),
    tile({ label: "Не перезвонили", value: String(t.noCallback), sub: `перезвонили ${t.in_missed_callback}` }),
    tile({ label: "Исходящие", value: String(t.out_total), sub: `без ответа ${t.out_noanswer}` }),
    tile({ label: "Записались", value: String(t.in_booked), sub: "из входящих, по YClients" })));

  const cd = chartDays();
  const val = (d, f) => (DATA.calls[d] ? callTotals([d])[f] : null);
  root.append(el("div", { class: "card" },
    el("h2", {}, "Входящие по дням"),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · ${periodCaption(cd)}`),
    chart({ kind: "stack", labels: cd.map(short), tipTitle: i => longDay(cd[i]), totalName: "всего",
            aria: "Входящие звонки по дням: принято и пропущено",
            series: [{ name: "Принято", color: "--neutral", values: cd.map(d => { const v = val(d, "in_total"); return v === null ? null : v - val(d, "in_missed"); }) },
                     { name: "⚠ Пропущено", color: "--bad", values: cd.map(d => val(d, "in_missed")) }] })));

  // Не перезвонили — номера, по дням и студиям.
  const lateDays = [...days].reverse();
  const missed = el("div", {});
  for (const day of lateDays) {
    const snap = DATA.calls[day];
    if (!snap) continue;
    const groups = studioNames().map(s => ({ s, phones: ((snap.studios || {})[s] || {}).missed_no_callback || [] }))
      .filter(g => g.phones.length);
    if (!groups.length) continue;
    missed.append(el("div", { class: "day" }, el("h3", {}, longDay(day)),
      groups.map(g => el("div", { class: "group" },
        el("h4", {}, g.s, el("span", { class: "cnt" }, String(g.phones.length))),
        el("div", { class: "phones" }, g.phones.map(phoneLink))))));
  }
  root.append(el("div", { class: "section-title" }, "Пропустили и не перезвонили"),
    missed.childNodes.length ? missed : el("div", { class: "empty-box" }, "Таких звонков нет"));

  // Замечания по звонкам.
  const issues = el("div", {});
  const notes = [];
  for (const day of lateDays) {
    const snap = DATA.calls[day];
    if (!snap) continue;
    if (snap.source === "backfill") { notes.push(day); continue; }
    const groups = studioNames().map(s => ({ s, items: ((snap.studios || {})[s] || {}).issues || [] }))
      .filter(g => g.items.length);
    const a = snap.analysis || {};
    const partial = a.selected && a.done < a.selected
      ? el("span", {}, `· разобрано ${a.done} из ${a.selected} звонков`) : null;
    if (!groups.length && !partial) continue;
    issues.append(el("div", { class: "day" }, el("h3", {}, longDay(day), partial),
      groups.map(g => el("div", { class: "group" },
        el("h4", {}, g.s, el("span", { class: "cnt" }, String(g.items.length))),
        g.items.map(it => el("div", { class: "person" },
          el("span", { class: "ch", title: it.direction === "in" ? "Входящий" : "Исходящий" }, it.direction === "in" ? "↙" : "↗"),
          el("div", { class: "who" }, el("span", { class: "time" }, it.time), phoneLink(it.phone) || "без номера",
            el("span", { class: `sev s${it.severity >= 3 ? 3 : 2}` }, it.severity >= 3 ? "⚠ критично" : "важно")),
          el("div", { class: "note" }, it.summary,
            el("ul", {}, (it.issues || []).map(x => el("li", {}, x))))))))));
  }
  root.append(el("div", { class: "section-title" }, "Замечания по звонкам"),
    issues.childNodes.length ? issues : el("div", { class: "empty-box" }, "Замечаний нет"));
  if (notes.length) root.append(el("div", { class: "note-box" },
    `По ${notes.length} ${plural(notes.length, "дню", "дням", "дням")} (${notes.map(short).join(", ")}) звонки восстановлены задним числом: ` +
    "цифры есть, а разбора разговоров тогда ещё не было."));
}

// ── Раздел «Переписки» (по неделям) ────────────────────────────────────────
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
  const weeks = (DATA.messages_quality.weeks || []).slice(-12);
  if (!weeks.length) { root.append(el("div", { class: "empty-box" }, "Нет недельной статистики")); return; }
  const cur = mqTotals(weeks[weeks.length - 1].studios), prev = weeks.length > 1 ? mqTotals(weeks[weeks.length - 2].studios) : null;
  const label = "к пред. неделе";
  const d = (now, before, unit, better) => ({ now, before: prev ? before : null, unit, better, label });
  root.append(el("div", { class: "note-box" }, `Качество переписок считается по неделям. Последняя полная неделя — ${weekLabel(weeks[weeks.length - 1])}.`));
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
  root.append(el("div", { class: "grid2" },
    small("Диалоги", "диалогов", t => t.n_dialogs, ruNum, undefined, true),
    small("Конверсия первичных, %", "конверсия", t => pct(t.n_first_time_booked, t.n_first_time), v => `${ruNum(v)}%`, 100),
    small("Без ответа, % от диалогов", "без ответа", t => pct(t.n_unanswered, t.n_dialogs), v => `${ruNum(v)}%`),
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

  const days = (DATA.messages_quality.days || []).filter(x => x.date > weeks[weeks.length - 1].end);
  if (days.length) {
    const t = { n_dialogs: 0, n_new_bookings: 0 };
    for (const x of days) { const s = mqTotals(x.studios); t.n_dialogs += s.n_dialogs; t.n_new_bookings += s.n_new_bookings; }
    root.append(el("div", { class: "note-box" },
      `Текущая неделя, ${days.length} ${plural(days.length, "день", "дня", "дней")}: ${t.n_dialogs} диалогов, ${t.n_new_bookings} записей. ` +
      "В графики она войдёт, когда закончится."));
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
  { id: "conversion", label: "Конверсия", view: viewConversion },
  { id: "unbooked", label: "Не записались", view: viewUnbooked },
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
  if (state.tab === "messages") {
    f.append(el("span", { class: "hint" }, "по неделям"));
  } else {
    f.append(el("div", { class: "seg", role: "group", "aria-label": "Период" },
      PERIODS.map(p => el("button", { type: "button", "aria-pressed": String(p.id === state.period),
        onclick: () => { state.period = p.id; save(); render(); } }, p.label))));
  }
  if (state.tab === "unbooked") {
    f.append(el("div", { class: "seg", role: "group", "aria-label": "Канал" },
      [["all", "Все"], ["calls", "📞 Звонки"], ["messages", "💬 Переписки"]].map(([id, lab]) =>
        el("button", { type: "button", "aria-pressed": String(id === state.channel),
          onclick: () => { state.channel = id; render(); } }, lab))));
    const search = el("input", { class: "search", type: "search", placeholder: "Телефон, имя, текст", value: state.query,
                                 "aria-label": "Поиск" });
    search.addEventListener("input", () => { state.query = search.value; renderContent(); });
    f.append(search);
  }
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
