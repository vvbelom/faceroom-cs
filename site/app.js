/* FaceRoom · кабинет управляющего.

   Данные лежат рядом в data.enc.json зашифрованными (PBKDF2-SHA256 + AES-256-GCM):
   репозиторий публичный, а в данных телефоны клиентов. Расшифровка — здесь, в
   браузере, паролем управляющих; наружу ничего не отправляется.

   Весь текст из данных (имена, заметки, отзывы) вставляется через textContent:
   это чужой текст, и разметкой он быть не должен. */
"use strict";

let DATA = null;
const state = { tab: "calls", studio: "", period: "cur_week", query: "",
                tagFilter: { calls: new Set(), messages: new Set() }, listFilter: {}, reviewsKind: "public", admin: "" };

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

// Телефон в таблицах ведёт не на звонок, а в карточку клиента —
// запись разговора в Мегафоне или карточку в YClients. Аккаунт один на всю
// сеть (поправьте MEGAFON_BASE/YCLIENTS_GROUP, если для каких-то студий он другой).
const MEGAFON_BASE = "https://vats758751.megapbx.ru/#/history";
const YCLIENTS_GROUP = "187230";
function externalPhoneLink(ch, raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return null;
  const pretty = d.length === 11 && d[0] === "7"
    ? `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : `+${d}`;
  const href = ch === "calls"
    ? `${MEGAFON_BASE}?type=external&direction=total&searchQuery=${d}`
    : `https://yclients.ru/group_clients/${YCLIENTS_GROUP}?page=1&name=${d}`;
  return el("a", { href, target: "_blank", rel: "noopener" }, pretty);
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
// Календарные периоды вместо скользящих окон: границы понятны (пн–вс, 1-е
// число), поэтому «к пред. периоду» — это неделя к неделе или месяц к месяцу,
// а не произвольные N дней подряд.
const PERIODS = [
  { id: "1d", label: "Вчера" },
  { id: "cur_week", label: "Текущая неделя" },
  { id: "prev_week", label: "Прошлая неделя" },
  { id: "cur_month", label: "Текущий месяц" },
  { id: "prev_month", label: "Прошлый месяц" },
];
function yesterday() { return addDays(DATA.today, -1); }
const mondayOf = s => { const d = parseDay(s); const k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return iso(d); };
const firstOfMonth = s => s.slice(0, 8) + "01";

function periodDays(p = state.period) {
  const end = yesterday();
  if (p === "1d") return [end];
  if (p === "cur_week") return dayRange(mondayOf(end), end);
  if (p === "prev_week") { const sun = addDays(mondayOf(end), -1); return dayRange(mondayOf(sun), sun); }
  if (p === "cur_month") return dayRange(firstOfMonth(end), end);
  if (p === "prev_month") { const last = addDays(firstOfMonth(end), -1); return dayRange(firstOfMonth(last), last); }
  return dayRange(mondayOf(end), end);
}
// Сравнение — всегда с полным предыдущим календарным куском (неделей или
// месяцем), даже если текущий период ещё не закончился: так «к пред. периоду»
// сравнивает сравнимое, а не рвущуюся на середине неделю.
function prevDays(days = periodDays()) {
  const p = state.period;
  if (p === "1d") return [addDays(days[0], -1)];
  if (p === "cur_month" || p === "prev_month") {
    const last = addDays(firstOfMonth(days[0]), -1);
    return dayRange(firstOfMonth(last), last);
  }
  const sun = addDays(mondayOf(days[0]), -1);
  return dayRange(mondayOf(sun), sun);
}
function periodLabel() {
  const p = state.period;
  if (p === "1d") return "к пред. дню";
  if (p === "cur_month" || p === "prev_month") return "к пред. месяцу";
  return "к пред. неделе";
}
function periodCaption(days = periodDays()) {
  return days.length === 1 ? longDay(days[0]) : `${short(days[0])} — ${short(days[days.length - 1])}`;
}
// Окно графика по дням — теперь следует за периодом сверху. «Вчера» и
// «текущая неделя» бывают совсем короткими (1–7 дней) — графику не за что
// зацепиться, поэтому у них минимум 14 дней. У «полных» периодов (прошлая
// неделя, текущий/прошлый месяц) — ровно сам период, без растягивания.
function chartDays() {
  const days = periodDays();
  if ((state.period === "1d" || state.period === "cur_week") && days.length < 14) {
    const end = days[days.length - 1];
    return dayRange(addDays(end, -13), end);
  }
  return days;
}

// ── Выборки ────────────────────────────────────────────────────────────────
const studioNames = () => (state.studio ? [state.studio] : DATA.studios);

// С какого дня в срезах появилось поле: правила счёта менялись, и за дни «до»
// цифры считались иначе — это надо подписывать, а не молча смешивать.
function firstDayWith(channel, field) {
  const days = Object.keys(DATA.conversion[channel]).sort();
  return days.find(d => Object.values(DATA.conversion[channel][d].studios || {}).some(r => field in r)) || null;
}
// То же самое для msgstats/ — там списки по отдельным людям (unanswered,
// issues) появились позже агрегатов (n_unanswered, n_ai_issues), которые
// используются в графике «Без ответа и замечания».
function firstDayWithMsgstats(field) {
  const days = Object.keys(DATA.msgstats || {}).sort();
  return days.find(d => Object.values(DATA.msgstats[d].studios || {}).some(r => field in r)) || null;
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
// delta: {now, before, unit: "pp"|"pct"|"abs", better: "up"|"down", label, suffix?}
function deltaNode(d) {
  if (!d || d.now === null || d.before === null || d.before === undefined) return null;
  let diff, text;
  if (d.unit === "pp") { diff = d.now - d.before; text = `${Math.abs(diff)} п.п.`; }
  else if (d.unit === "abs") { diff = Math.round((d.now - d.before) * 10) / 10; text = ruNum(Math.abs(diff)) + (d.suffix || ""); }
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

// Монотонная кубическая кривая: проходит точно через все точки данных и не
// «перелетает» за соседние экстремумы (в отличие от Catmull-Rom) — безопасно
// для чтения графика, не рисует ложных провалов/пиков между реальными точками.
function monotonePath(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0].x},${pts[0].y}` : "";
  const dx = [], slope = [];
  for (let i = 0; i < pts.length - 1; i++) { dx[i] = pts[i + 1].x - pts[i].x; slope[i] = (pts[i + 1].y - pts[i].y) / dx[i]; }
  const m = [slope[0]];
  for (let i = 1; i < pts.length - 1; i++) m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  m.push(slope[slope.length - 1]);
  let d = `M${pts[0].x},${pts[0].y} `;
  for (let i = 0; i < pts.length - 1; i++) {
    const c1x = pts[i].x + dx[i] / 3, c1y = pts[i].y + m[i] * dx[i] / 3;
    const c2x = pts[i + 1].x - dx[i] / 3, c2y = pts[i + 1].y - m[i + 1] * dx[i] / 3;
    d += `C${c1x},${c1y} ${c2x},${c2y} ${pts[i + 1].x},${pts[i + 1].y} `;
  }
  return d;
}
// Обходит точки серии участками без пропусков (null рвёт линию, как и раньше)
// и вызывает fn(points) на каждом непрерывном куске.
function forEachRun(values, point, fn) {
  let run = [];
  values.forEach((v, i) => {
    if (v === null || v === undefined) { if (run.length) fn(run); run = []; return; }
    run.push(point(i, v));
  });
  if (run.length) fn(run);
}
// То же самое, но возвращает массив кусков — нужен, чтобы соединить соседние
// куски пунктирным «мостиком» через пропуск, а не оставлять пустоту.
function buildRuns(values, point) {
  const runs = [];
  forEachRun(values, point, run => runs.push(run));
  return runs;
}

function chart(opts) {
  // opts: {kind: "line"|"stack", labels, series: [{name, color, values, detail?}], yMax, fmt, height, tipTitle}
  // detail — подпись к значению в подсказке и в таблице («37 из 70»): за
  // процентом должно быть видно, сколько это людей.
  const box = el("div", { class: "chart", tabindex: "0", role: "img" });
  const legend = opts.series.length > 1
    ? el("div", { class: "legend" }, opts.series.map(s => el("span", {},
        el("i", { class: opts.kind === "line" ? "line" : "rect",
                  style: s.dash ? `background:repeating-linear-gradient(90deg, var(${s.color}) 0 5px, transparent 5px 9px)`
                                : `background:var(${s.color})` }), s.name)))
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
    // Заливка — под линией, только у серий с s.fill; рисуется первой, чтобы
    // сами линии остались поверх.
    o.series.forEach(s => {
      if (!s.fill) return;
      forEachRun(s.values, (i, v) => ({ x: x(i), y: y(v) }), pts => {
        if (pts.length < 2) return;
        const d = monotonePath(pts) + `L${pts[pts.length - 1].x},${y(0)} L${pts[0].x},${y(0)} Z`;
        svg.append(svgEl("path", { d, fill: `color-mix(in srgb, var(${s.color}) 16%, transparent)`, stroke: "none" }));
      });
    });
    o.series.forEach(s => {
      const runs = buildRuns(s.values, (i, v) => ({ x: x(i), y: y(v) }));
      let d = "";
      runs.forEach(pts => { d += monotonePath(pts); });
      const lineAttrs = { d, fill: "none", stroke: `var(${s.color})`, "stroke-width": 2,
                          "stroke-linejoin": "round", "stroke-linecap": "round" };
      if (s.dash) lineAttrs["stroke-dasharray"] = "6 5";
      svg.append(svgEl("path", lineAttrs));
      // Мостики через пропуски — нейтральным серым (--axis), а не цветом
      // серии: иначе при редких данных почти вся линия становится пунктирной
      // и перестаёт читаться как «тут данных не было».
      for (let i = 0; i < runs.length - 1; i++) {
        const a = runs[i][runs[i].length - 1], b = runs[i + 1][0];
        svg.append(svgEl("path", { d: `M${a.x},${a.y} L${b.x},${b.y}`, fill: "none", stroke: "var(--axis)",
          "stroke-width": 2, "stroke-linecap": "round", "stroke-dasharray": "6 5" }));
      }
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
// warn — показатель заметно хуже контрольного значения (сейчас только у
// администраторов, сравнение со средним по сети); остальным вызовам frac()
// он не нужен и по умолчанию выключен.
function frac(a, b, warn) {
  return b ? [`${a}/${b}`, el("span", { class: `pct${warn ? " flag-bad" : ""}` }, `${warn ? "⚠ " : ""}${fmtPct(pct(a, b))}`)] : "—";
}
function table(head, rows) {
  return el("div", { class: "tbl-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, head.map(h => el("th", {}, h)))),
    el("tbody", {}, rows)));
}

// ── Экспорт таблиц в CSV ─────────────────────────────────────────────────────
// Разделитель «;» и BOM в начале файла — чтобы Excel с русской локалью
// открывал файл сразу по колонкам, с кириллицей без кракозябр.
function csvField(v) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// Соседние узлы в ячейках часто идут без пробела в разметке (время и текст
// заметки, дробь и процент, несколько заметок друг за другом) — textContent
// просто склеивает их в один ком. Собираем ячейку по текстовым узлам
// рекурсивно, вставляя пробел на каждой границе. «12/14» (дробь) Excel
// норовит принять за дату — меняем «/» на «из» прямо в этом текстовом узле.
function textParts(node) {
  if (node.nodeType === 3) {
    const t = node.nodeValue.trim();
    if (!t) return [];
    return [/^\d+\/\d+$/.test(t) ? t.replace("/", " из ") : t];
  }
  if (node.nodeType !== 1) return [];
  if (node.classList.contains("stars")) { const t = node.getAttribute("title"); return t ? [t] : []; }
  return [...node.childNodes].flatMap(textParts);
}
function cellCSV(td) {
  // «Кто требует внимания»: несколько заметок (.cm) в одной ячейке —
  // разделяем явно, иначе читаются как одно предложение.
  const notes = [...td.children].filter(c => c.classList.contains("cm"));
  const raw = notes.length
    ? notes.map(n => textParts(n).join(" ")).join(" | ")
    : textParts(td).join(" ");
  return csvField(raw);
}
// Раскладывает строки таблицы в прямоугольную сетку, учитывая rowspan/colspan
// (нужно для двухрядного заголовка «Администраторов» — группы «Звонки»/
// «Переписки» над своими колонками): объединённая ячейка пишется один раз,
// остальные клетки, которые она перекрывает, остаются пустыми — как Excel
// сам показывает объединённые ячейки. Для таблиц без span ничего не меняет.
function tableToCSV(container) {
  const tableEl = container.matches("table") ? container : container.querySelector("table");
  if (!tableEl) return "﻿"; // пустой результат фильтра — таблицы нет, скачиваем пустой файл, а не падаем
  const grid = [];
  [...tableEl.querySelectorAll("tr")].forEach((tr, r) => {
    grid[r] = grid[r] || [];
    let col = 0;
    for (const cell of tr.children) {
      while (grid[r][col] !== undefined) col++;
      const text = cellCSV(cell);
      const cs = parseInt(cell.getAttribute("colspan") || "1", 10);
      const rs = parseInt(cell.getAttribute("rowspan") || "1", 10);
      for (let i = 0; i < cs; i++) {
        for (let j = 0; j < rs; j++) {
          grid[r + j] = grid[r + j] || [];
          grid[r + j][col + i] = i === 0 && j === 0 ? text : "";
        }
      }
      col += cs;
    }
  });
  return "﻿" + grid.map(row => row.join(";")).join("\r\n");
}
function downloadCSV(filename, container) {
  const blob = new Blob([tableToCSV(container)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// getContainer — функция, а не готовый узел: таблицу «Кто требует внимания»
// перерисовывают фильтры, и к моменту клика нужна самая свежая версия.
function dlButton(filename, getContainer) {
  return el("button", { class: "as-table", type: "button", onclick: () => downloadCSV(filename, getContainer()) }, "⬇ Скачать CSV");
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
const sinceNote = (first, days) => (first && first > days[0] ? ` · считаются с ${short(first)}` : "");
// Когда за весь период данных нет — не молчим «нет данных», а говорим,
// с какого дня это вообще стало считаться (форматы конверсии менялись).
const noDataNote = (ch, field, days) => {
  const first = firstDayWith(ch, field);
  return first && first > days[0] ? `нет данных · считается с ${short(first)}` : "нет данных";
};

function convTiles(ch, days) {
  const before = prevDays(days), label = periodLabel();
  const c = convTotals(ch, days), cb = convTotals(ch, before);
  return [
    tile({ label: "Конверсия в запись", key: CH_COLOR[ch], value: fmtPct(pct(c.booked, c.clients)),
           sub: c.clients ? `${c.booked} из ${c.clients} записались` : noDataNote(ch, "clients", days),
           delta: { now: pct(c.booked, c.clients), before: pct(cb.booked, cb.clients), unit: "pp", better: "up", label } }),
    tile({ label: "Первичные", key: "--primary", value: fmtPct(pct(c.primaryBooked, c.primary)),
           sub: c.primary ? `${c.primaryBooked} из ${c.primary} записались${sinceNote(firstDayWith(ch, "primary"), days)}` : noDataNote(ch, "primary", days),
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

function convByStudio(ch, days, extra) {
  if (state.studio) return null;
  // У переписок рядом с конверсией — без ответа и замечания, доля от диалогов.
  const withProblems = ch === "messages";
  const cells = (t, p) => [el("td", {}, frac(t.booked, t.clients)),
    el("td", {}, t.primary ? frac(t.primaryBooked, t.primary) : "—"),
    withProblems ? el("td", {}, p.n_dialogs ? frac(p.n_unanswered, p.n_dialogs) : "—") : null,
    withProblems ? el("td", {}, p.n_dialogs ? frac(p.n_ai_issues, p.n_dialogs) : "—") : null,
    withProblems ? el("td", {}, p.respMin === null ? "—" : `${ruNum(p.respMin)} мин`) : null,
    el("td", {}, String(t.excluded || "—"))];
  const rows = DATA.studios.map(s => {
    const t = convTotals(ch, days, s), p = msgTotals(days, s);
    if (!t.clients && !t.excluded && !(withProblems && p.n_dialogs)) return null;
    return el("tr", { class: "click", onclick: () => setStudio(s) }, el("td", {}, s), cells(t, p));
  }).filter(Boolean);
  if (!rows.length) return null;
  rows.push(el("tr", { class: "total" }, el("td", {}, "Вся сеть"), cells(convTotals(ch, days), msgTotals(days))));
  const tbl = table(["Студия", "Записались", "Первичные", ...(withProblems ? ["Без ответа", "С замечаниями", "Ответ"] : []), "Не считали"], rows);
  return el("div", { class: "card" },
    el("div", { class: "card-head" }, el("h2", {}, "По студиям"),
      dlButton(`${ch === "calls" ? "звонки" : "переписки"}-по-студиям.csv`, () => tbl)),
    el("p", { class: "cap" }, `${periodCaption(days)} · нажмите на студию, чтобы посмотреть только её`),
    extra || null, tbl);
}

// Проблемы переписок по дням (msgstats/): диалоги, без ответа, с замечаниями.
function msgTotals(days, studio = state.studio) {
  const t = { n_dialogs: 0, n_unanswered: 0, n_ai_issues: 0, n_first_time: 0, daysWithData: 0 };
  const resp = { sum: 0, weight: 0 };
  for (const day of days) {
    const snap = (DATA.msgstats || {})[day];
    if (!snap) continue;
    t.daysWithData++;
    for (const [name, r] of Object.entries(snap.studios || {})) {
      if (studio && name !== studio) continue;
      t.n_dialogs += r.n_dialogs || 0; t.n_unanswered += r.n_unanswered || 0; t.n_ai_issues += r.n_ai_issues || 0;
      t.n_first_time += r.n_first_time || 0;
      addResponse(resp, r, r.n_responses);
    }
  }
  t.respMin = respMinutes(resp);
  return t;
}
// Время ответа — среднее до первой реакции администратора. Сеть и период
// усредняются с весом: числом диалогов, где ответ был (n_responses, с
// 01.10.2026), а для более ранних дней — числом диалогов. Студия без ответов
// (avg_response_sec = null) в среднее не входит — иначе тянула бы его к нулю.
function addResponse(acc, r, weight) {
  if (typeof r.avg_response_sec !== "number") return;
  const w = typeof weight === "number" ? weight : (r.n_dialogs || 0);
  acc.sum += r.avg_response_sec * w; acc.weight += w;
}
const respMinutes = acc => (acc.weight ? Math.round(acc.sum / acc.weight / 6) / 10 : null);

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
  primary:    { label: "первичный", cls: "t-primary" },
  unbooked:   { label: "не записался", cls: "t-unbooked" },
  unanswered: { label: "не ответили", cls: "t-bad" },
  nocallback: { label: "не перезвонили", cls: "t-bad" },
  critical:   { label: "⚠ критичное замечание", cls: "t-bad" },
  issue:      { label: "замечание", cls: "t-issue" },
};
const TAG_FILTERS = {
  calls: [["unbooked", "Не записались"], ["nocallback", "Не перезвонили"], ["issue", "Замечания"], ["primary", "Первичные"]],
  messages: [["unbooked", "Не записались"], ["unanswered", "Не ответили"], ["issue", "Замечания"], ["primary", "Первичные"]],
};
// Мультивыбор чипов: ничего не выбрано — показываем всё (отдельной кнопки
// «Все» не нужно), несколько выбранных работают как «И» — сужают список до
// строк со всеми выбранными тегами сразу, а не любой из них.
const hasTag = (row, t) => (t === "issue" ? row.tags.has("issue") || row.tags.has("critical") : row.tags.has(t));

function peopleRows(ch, days) {
  const out = [];
  let trimmed = false;
  const firstMsgList = ch === "messages" ? firstDayWithMsgstats("unanswered") : null;
  let untracked = false;
  // Кто именно первичный — в срезах конверсии с 01.10.2026 (primary_phones);
  // раньше сохранялось только число первичных за день.
  const firstPrimary = firstDayWith(ch, "primary_phones");
  let primaryUntracked = false;
  for (const day of [...days].reverse()) {
    const conv = DATA.conversion[ch][day];
    if (conv && conv.lists_trimmed) trimmed = true;
    if (firstMsgList && day < firstMsgList) untracked = true;
    if (conv && (!firstPrimary || day < firstPrimary)) primaryUntracked = true;
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
      const cv = ((conv && conv.studios) || {})[studio] || {};
      for (const u of cv.unbooked || []) {
        const r = row(u.phone, u.name);
        r.tags.add("unbooked");
        if (u.primary) r.tags.add("primary");
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
      // «Первичный» — пометка к строке, а не причина в неё попасть: в таблице
      // только те, с кем что-то не так.
      const primaryPhones = new Set(cv.primary_phones || []);
      for (const r of byKey.values()) {
        if (r.tags.has("unanswered")) r.notes = r.notes.filter(n => !(typeof n === "string" && n.startsWith("без ответа")));
        if (r.phone && primaryPhones.has(r.phone)) r.tags.add("primary");
      }
      out.push(...byKey.values());
    }
  }
  return { rows: out, trimmed, untracked, firstMsgList, primaryUntracked, firstPrimary };
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

const PAGE = 50;
function peopleCard(ch, days) {
  const { rows, trimmed, untracked, firstMsgList, primaryUntracked, firstPrimary } = peopleRows(ch, days);
  const filters = TAG_FILTERS[ch];
  const sel = state.tagFilter[ch];
  const card = el("div", { class: "card people" });
  const title = "Кто требует внимания";
  card.append(el("div", { class: "card-head" }, el("h2", {}, title),
      dlButton(`${ch === "calls" ? "звонки" : "переписки"}-кто-требует-внимания.csv`, () => body)),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · ${periodCaption(days)} · строка — человек за день`));

  const chips = el("div", { class: "chips", role: "group", "aria-label": "Показать" });
  const search = el("input", { class: "search", type: "search", placeholder: "Телефон, имя, текст",
                               value: state.query, "aria-label": "Поиск по таблице" });
  const body = el("div", {});
  card.append(el("div", { class: "tools" }, chips, search), body);

  const draw = (limit = PAGE) => {
    const q = state.query.trim().toLowerCase();
    const noteText = n => (typeof n === "string" ? n : `${n.summary || ""} ${n.text || ""} ${(n.issues || []).join(" ")}`);
    const hay = r => `${r.phone} ${r.name} ${r.notes.map(noteText).join(" ")}`.toLowerCase();
    const searched = q ? rows.filter(r => hay(r).includes(q)) : rows;
    chips.textContent = "";
    filters.forEach(([id, lab]) => {
      const n = searched.filter(r => hasTag(r, id)).length;
      chips.append(el("button", { type: "button", "aria-pressed": String(sel.has(id)),
        onclick: () => { sel.has(id) ? sel.delete(id) : sel.add(id); draw(); } }, lab, el("span", { class: "n" }, String(n))));
    });
    const shown = searched.filter(r => [...sel].every(t => hasTag(r, t)));
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
        el("td", { "data-l": "Клиент", class: "who" }, externalPhoneLink(ch, r.phone) || r.name || "без номера",
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
  if (untracked) card.append(el("p", { class: "cap", style: "margin-top:8px" },
    `Без ответа и замечания по людям собираются с ${short(firstMsgList)} — за более ранние дни есть только общая доля, на графике выше.`));
  if (primaryUntracked) card.append(el("p", { class: "cap", style: "margin-top:8px" },
    firstPrimary
      ? `Тег «первичный» ставится с ${short(firstPrimary)} — за более ранние дни известно только число первичных, без имён.`
      : "Тег «первичный» начнёт ставиться со следующего отчёта — до этого сохранялось только число первичных, без имён."));
  return card;
}

// ── Раздел «Звонки» ────────────────────────────────────────────────────────
function viewCalls(root) {
  const days = periodDays(), before = prevDays(days);
  const label = periodLabel();
  const t = callTotals(days), tb = callTotals(before);
  const [convTile, primaryTile, exclTile] = convTiles("calls", days);
  const answered = t.in_total - t.in_missed, answeredB = tb.in_total - tb.in_missed;
  root.append(el("div", { class: "tiles six" },
    tile({ label: "Входящие", value: t.daysWithData ? String(t.in_total) : "—",
           delta: { now: t.in_total, before: tb.daysWithData ? tb.in_total : null, unit: "pct", better: "up", label } }),
    tile({ label: "Принято", value: fmtPct(pct(answered, t.in_total)),
           sub: t.in_total ? [`${answered} из ${t.in_total}`, el("br"),
             `пропущено ${t.in_missed} · не перезвонили ${t.noCallback}, перезвонили ${t.in_missed_callback}`] : "",
           delta: { now: pct(answered, t.in_total), before: tb.daysWithData ? pct(answeredB, tb.in_total) : null, unit: "pp", better: "up", label } }),
    tile({ label: "Исходящие", value: t.daysWithData ? String(t.out_total) : "—",
           sub: t.out_total ? `${fmtPct(pct(t.out_total - t.out_noanswer, t.out_total))} дозвонились · без ответа ${t.out_noanswer}` : "нет данных",
           delta: { now: t.out_total, before: tb.daysWithData ? tb.out_total : null, unit: "pct", better: "up", label } }),
    convTile, primaryTile, exclTile));

  const cd = chartDays();
  const val = (d, f) => (DATA.calls[d] ? callTotals([d])[f] : null);
  const callsCard = el("div", { class: "card" },
    el("h2", {}, "Звонки по дням"),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · ${periodCaption(cd)}`),
    chart({ kind: "line", labels: cd.map(short), tipTitle: i => longDay(cd[i]), integer: true,
            aria: "Звонки по дням: входящие, исходящие и первичные",
            series: [{ name: "Входящие", color: "--calls", values: cd.map(d => val(d, "in_total")), fill: true },
                     { name: "Исходящие", color: "--accent", values: cd.map(d => val(d, "out_total")) },
                     { name: "Первичные", color: "--primary", values: cd.map(d => (DATA.conversion.calls[d] ? convTotals("calls", [d]).primary : null)), dash: true }] }));
  root.append(el("div", { class: "grid2" }, callsCard, convChart("calls")));
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
  const resp = { sum: 0, weight: 0 };
  for (const [name, r] of Object.entries(rows || {})) {
    if (state.studio && name !== state.studio) continue;
    for (const f of MQ) t[f] += r[f] || 0;
    addResponse(resp, r);
  }
  t.respMin = respMinutes(resp);
  return t;
}
const weekLabel = w => `${short(w.start)}–${short(w.end)}`;

// Диалоги по дням: всего и первичные — счётом, не в процентах (в отличие от
// конверсии/качества ниже). Первичные — пунктиром: так виднее, что это
// разрез того же «Всего», а не отдельная метрика.
function dialogsChart() {
  const cd = chartDays();
  const pt = cd.map(d => ((DATA.msgstats || {})[d] ? msgTotals([d]) : null));
  // Первичные — n_first_time дневного среза msgstats (с 01.10.2026 пишется
  // каждый вечер, за 06.07–30.09 восстановлен из истории дневной статистики).
  return el("div", { class: "card" },
    el("h2", {}, "Диалоги по дням"),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · ${periodCaption(cd)}`),
    chart({ kind: "line", labels: cd.map(short), tipTitle: i => longDay(cd[i]), integer: true,
            aria: "Диалоги по дням: всего и первичные",
            series: [{ name: "Все диалоги", color: "--messages", values: pt.map(t => (t ? t.n_dialogs : null)), fill: true },
                     { name: "Первичные", color: "--primary", values: pt.map(t => (t ? t.n_first_time : null)), dash: true }] }));
}

function msgProblemsChart() {
  const cd = chartDays();
  const pt = cd.map(d => ((DATA.msgstats || {})[d] ? msgTotals([d]) : null));
  const share = f => pt.map(t => (t && t.n_dialogs ? pct(t[f], t.n_dialogs) : null));
  const count = f => pt.map(t => (t && t.n_dialogs ? `${t[f]} из ${t.n_dialogs}` : null));
  return el("div", { class: "card" },
    el("h2", {}, "Без ответа и замечания по дням, %"),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · ${periodCaption(cd)}`),
    chart({ kind: "line", labels: cd.map(short), tipTitle: i => longDay(cd[i]), fmt: v => `${ruNum(v)}%`,
            aria: "Доля диалогов без ответа и с замечаниями по дням",
            series: [{ name: "⚠ Без ответа", color: "--bad", values: share("n_unanswered"), detail: count("n_unanswered") },
                     { name: "Замечания", color: "--issue", values: share("n_ai_issues"), detail: count("n_ai_issues") }] }));
}

// Диалоги по неделям — долгосрочный тренд (12 недель), независимо от периода
// сверху. Первичные — тем же пунктиром, что и в «Диалогах по дням».
function weeklyDialogsChart(weeks) {
  const labels = weeks.map(w => short(w.start));
  const tipTitle = i => `Неделя ${weekLabel(weeks[i])}`;
  const at = f => weeks.map(w => { const t = mqTotals(w.studios); return t.n_dialogs ? f(t) : null; });
  return el("div", { class: "card" }, el("h2", {}, "Диалоги по неделям"),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · по неделям`),
    chart({ kind: "line", labels, tipTitle, fmt: ruNum, integer: true, height: 160,
            aria: "Диалоги по неделям: всего и первичные",
            series: [{ name: "Все диалоги", color: "--messages", values: at(t => t.n_dialogs), fill: true },
                     { name: "Первичные", color: "--primary", values: at(t => t.n_first_time), dash: true }] }));
}

function viewMessages(root) {
  const days = periodDays(), before = prevDays(days);
  const label = periodLabel();
  const c = convTotals("messages", days), cb = convTotals("messages", before);
  const p = msgTotals(days), pb = msgTotals(before);
  // Первичные — берём готовую плитку из convTiles (та же логика, что и в
  // «Звонках»); «Конверсию» и «Не считали» строим сами — у переписок для них
  // отдельная, двухстрочная подпись (см. ниже).
  const [, primaryTile] = convTiles("messages", days);

  const convSub = c.clients
    ? [`${c.booked} из ${c.clients} обратившихся по записи`,
       c.excluded ? el("br") : null,
       c.excluded ? `не считали ${c.excluded} · запись не предполагалась` : null]
    : noDataNote("messages", "clients", days);
  const convTile = tile({ label: "Конверсия в запись", key: CH_COLOR.messages, value: fmtPct(pct(c.booked, c.clients)),
    sub: convSub,
    delta: { now: pct(c.booked, c.clients), before: pct(cb.booked, cb.clients), unit: "pp", better: "up", label } });

  root.append(el("div", { class: "tiles six" },
    tile({ label: "Диалогов", value: p.daysWithData ? String(p.n_dialogs) : "—",
           sub: p.daysWithData ? `данных за ${p.daysWithData} из ${days.length} дн.` : "нет данных" }),
    tile({ label: "⚠ Без ответа", key: "--bad", value: fmtPct(pct(p.n_unanswered, p.n_dialogs)),
           sub: p.n_dialogs ? `${p.n_unanswered} из ${p.n_dialogs} диалогов` : "",
           delta: { now: pct(p.n_unanswered, p.n_dialogs), before: pb.n_dialogs ? pct(pb.n_unanswered, pb.n_dialogs) : null,
                    unit: "pp", better: "down", label } }),
    tile({ label: "Замечания", key: "--issue", value: fmtPct(pct(p.n_ai_issues, p.n_dialogs)),
           sub: p.n_dialogs ? `${p.n_ai_issues} из ${p.n_dialogs} диалогов` : "",
           delta: { now: pct(p.n_ai_issues, p.n_dialogs), before: pb.n_dialogs ? pct(pb.n_ai_issues, pb.n_dialogs) : null,
                    unit: "pp", better: "down", label } }),
    convTile, primaryTile,
    tile({ label: "Время ответа", value: p.respMin === null ? "—" : `${ruNum(p.respMin)} мин`,
           sub: p.respMin === null ? "нет данных" : "в среднем до первого ответа",
           delta: { now: p.respMin, before: pb.respMin, unit: "abs", suffix: " мин", better: "down", label } })));

  root.append(el("div", { class: "subgroup" }, "По дням"));
  root.append(el("div", { class: "grid2" }, dialogsChart(), convChart("messages"), msgProblemsChart()));

  const weeks = (DATA.messages_quality.weeks || []).slice(-12);
  if (weeks.length) {
    root.append(el("div", { class: "subgroup" }, "По неделям · долгосрочный тренд"));
    const series = f => weeks.map(w => { const t = mqTotals(w.studios); return t.n_dialogs ? f(t) : null; });
    const respChart = el("div", { class: "card" }, el("h2", {}, "Время ответа по неделям, мин"),
      el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · по неделям`),
      chart({ kind: "line", labels: weeks.map(w => short(w.start)), tipTitle: i => `Неделя ${weekLabel(weeks[i])}`,
              fmt: ruNum, height: 160, aria: "Время ответа по неделям",
              series: [{ name: "минут", color: "--calls", values: series(t => t.respMin) }] }));
    root.append(el("div", { class: "grid2" }, weeklyDialogsChart(weeks), respChart));
  }

  const byStudio = convByStudio("messages", days);
  if (byStudio) root.append(byStudio);
  root.append(peopleCard("messages", days));
  root.append(convNote("messages", days));
}

// ── Раздел «Отзывы» ────────────────────────────────────────────────────────
// Этап 3 правок заказчицы 29.09: два вида отзывов переключателем —
// публичные (YClients и площадки через Поинтер) и из переписок (оценка визита
// 1–5 в ответ на запрос бота; по студиям — с 30.09.2026, раньше только по сети).
function starsNode(n) {
  return el("span", { class: "stars", title: `${n} из 5`, "aria-label": `${n} из 5` },
    "★".repeat(Math.max(0, n)), el("span", { class: "off" }, "★".repeat(Math.max(0, 5 - n))));
}

function chatRatings(days, studio = state.studio) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const list = [];
  let networkOnlyDays = 0, perStudioFrom = null;
  for (const day of days) {
    const snap = (DATA.msgstats || {})[day];
    if (!snap) continue;
    const studios = snap.studios || {};
    if (Object.values(studios).some(r => r.rating_counts)) {
      if (!perStudioFrom) perStudioFrom = day;
      for (const [name, r] of Object.entries(studios)) {
        if (studio && name !== studio) continue;
        for (const [k, n] of Object.entries(r.rating_counts || {})) counts[k] = (counts[k] || 0) + n;
        for (const x of r.ratings || []) list.push({ ...x, day, studio: name });
      }
    } else if (snap.rating_counts_network) {
      if (studio) { networkOnlyDays++; continue; }       // по студиям раньше не сохранялось
      for (const [k, n] of Object.entries(snap.rating_counts_network)) counts[k] = (counts[k] || 0) + n;
    }
  }
  return { counts, list, networkOnlyDays, perStudioFrom };
}
function ratingSummary(counts) {
  const total = sum(Object.values(counts));
  const avg = total ? Math.round(10 * sum(Object.entries(counts).map(([k, n]) => k * n)) / total) / 10 : null;
  return { total, avg, neg: (counts[1] || 0) + (counts[2] || 0) + (counts[3] || 0) };
}

// Таблица со счётчиками-фильтрами, поиском и «показать ещё» — для отзывов.
function listCard({ id, title, cap, head, rows, chips, hay, render }) {
  const card = el("div", { class: "card people" }, el("h2", {}, title), el("p", { class: "cap" }, cap));
  if (!chips.some(([k]) => k === state.listFilter[id])) state.listFilter[id] = chips[0][0];
  const chipBox = el("div", { class: "chips", role: "group", "aria-label": "Показать" });
  const search = el("input", { class: "search", type: "search", placeholder: "Имя, телефон, текст",
                               value: state.query, "aria-label": "Поиск по таблице" });
  const body = el("div", {});
  card.append(el("div", { class: "tools" }, chipBox, search), body);
  const draw = (limit = PAGE) => {
    const q = state.query.trim().toLowerCase();
    const searched = q ? rows.filter(r => hay(r).toLowerCase().includes(q)) : rows;
    chipBox.textContent = "";
    chips.forEach(([k, lab, pred]) => chipBox.append(el("button", { type: "button", "aria-pressed": String(k === state.listFilter[id]),
      onclick: () => { state.listFilter[id] = k; draw(); } }, lab, el("span", { class: "n" }, String(searched.filter(pred).length)))));
    const pred = chips.find(([k]) => k === state.listFilter[id])[2];
    const shown = searched.filter(pred);
    body.textContent = "";
    if (!shown.length) { body.append(el("div", { class: "empty-box" }, rows.length ? "Ничего не нашлось" : "За этот период ничего нет")); return; }
    body.append(el("div", { class: "tbl-wrap" }, el("table", { class: "ppl" },
      el("thead", {}, el("tr", {}, head.map(h => el("th", {}, h)))),
      el("tbody", {}, shown.slice(0, limit).map(render)))));
    if (shown.length > limit) body.append(el("button", { class: "more", type: "button", onclick: () => draw(limit + PAGE) },
      `Показать ещё (${shown.length - limit})`));
  };
  search.addEventListener("input", () => { state.query = search.value; draw(); });
  draw();
  return card;
}
const isNeg = r => r.stars ? r.stars <= 3 : r.rating <= 3;
const clientCell = (phone, name) => el("td", { "data-l": "Клиент", class: "who" },
  externalPhoneLink("messages", phone) || name || "—", phone && name ? el("span", { class: "nm" }, name) : null);

function viewReviews(root) {
  const days = periodDays();
  const inPeriod = r => r.date >= days[0] && r.date <= days[days.length - 1] && (!state.studio || r.studio === state.studio);
  const pub = DATA.reviews.filter(inPeriod);
  const pubRated = pub.filter(r => r.stars);
  const pubAvg = pubRated.length ? Math.round(10 * sum(pubRated.map(r => r.stars)) / pubRated.length) / 10 : null;
  const sources = [...new Set(pub.map(r => r.source).filter(Boolean))];
  const chat = chatRatings(days), cs = ratingSummary(chat.counts);
  const chatNote = state.studio && chat.networkOnlyDays ? " · по студиям — с 30.09" : "";

  root.append(el("div", { class: "tiles six" },
    tile({ label: "Публичные — количество", value: String(pubRated.length),
           sub: sources.length ? sources.join(", ") : "нет данных" }),
    tile({ label: "Публичные — средняя оценка", value: pubAvg === null ? "—" : ruNum(pubAvg) }),
    tile({ label: "Публичные — негативные", key: "--bad", value: String(pub.filter(isNeg).length), sub: "1–3★" }),
    tile({ label: "Из переписок — количество", value: String(cs.total),
           sub: `${plural(cs.total, "оценка", "оценки", "оценок")} визитов${chatNote}` }),
    tile({ label: "Из переписок — средняя оценка", value: cs.avg === null ? "—" : ruNum(cs.avg) }),
    tile({ label: "Из переписок — негативные", key: "--bad", value: String(cs.neg), sub: "1–3★" })));

  root.append(el("div", { class: "seg kind", role: "group", "aria-label": "Вид отзывов" },
    [["all", "Все"], ["public", "Публичные"], ["chat", "Из переписок"]].map(([k, lab]) => el("button", { type: "button",
      "aria-pressed": String(state.reviewsKind === k), onclick: () => { state.reviewsKind = k; save(); renderContent(); } }, lab))));

  // Считалки по произвольному набору дней — используются и для дневного
  // окна (chartDays), и для недельных вёдер (weekDays) ниже. «Все» —
  // публичные и из переписок складываются в одни и те же 1–5★.
  function pubRatingCounts(ds) {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of DATA.reviews) if (ds.includes(r.date) && (!state.studio || r.studio === state.studio) && r.stars) counts[r.stars]++;
    return counts;
  }
  function reviewCounts(ds) {
    if (state.reviewsKind === "chat") return chatRatings(ds).counts;
    if (state.reviewsKind === "public") return pubRatingCounts(ds);
    const a = pubRatingCounts(ds), b = chatRatings(ds).counts, out = {};
    for (const k of [1, 2, 3, 4, 5]) out[k] = (a[k] || 0) + (b[k] || 0);
    return out;
  }
  const reviewBucket = (ds, good) => { const c = reviewCounts(ds); return good ? c[4] + c[5] : c[1] + c[2] + c[3]; };
  const reviewAvg = ds => ratingSummary(reviewCounts(ds)).avg;
  const what = state.reviewsKind === "chat" ? "Оценки визитов из переписок"
    : state.reviewsKind === "public" ? "Публичные отзывы" : "Все отзывы";
  const studioNote = state.reviewsKind !== "public" && state.studio ? " · по студиям оценки из переписок сохраняются с 30.09, раньше — только по сети" : "";

  // По дням — окно следует за периодом сверху, как в «Звонках»/«Перепиках».
  const cd = chartDays();
  const dailyCap = `${state.studio || "Вся сеть"} · ${periodCaption(cd)}${studioNote}`;
  root.append(el("div", { class: "subgroup" }, "По дням"));
  root.append(el("div", { class: "grid2" },
    el("div", { class: "card" }, el("h2", {}, `${what} по дням`), el("p", { class: "cap" }, dailyCap),
      chart({ kind: "stack", labels: cd.map(short), tipTitle: i => longDay(cd[i]), integer: true, totalName: "всего",
              aria: `${what} по дням: количество`,
              series: [{ name: "4–5★", color: "--primary", values: cd.map(d => reviewBucket([d], true)) },
                       { name: "⚠ 1–3★", color: "--bad", values: cd.map(d => reviewBucket([d], false)) }] })),
    el("div", { class: "card" }, el("h2", {}, "Средняя оценка по дням"), el("p", { class: "cap" }, dailyCap),
      chart({ kind: "line", labels: cd.map(short), tipTitle: i => longDay(cd[i]), yMax: 5, fmt: ruNum,
              aria: "Средняя оценка по дням",
              series: [{ name: "Средняя", color: "--accent", values: cd.map(d => reviewAvg([d])) }] }))));

  // По неделям — долгосрочный тренд, последние 12, независимо от периода.
  const lastMon = mondayOf(yesterday());
  const weeks = Array.from({ length: 12 }, (_, i) => addDays(lastMon, -7 * (11 - i)));
  const weekDays = w => dayRange(w, addDays(w, 6));
  const weeksCap = `${state.studio || "Вся сеть"} · последние 12 недель${studioNote}`;
  root.append(el("div", { class: "subgroup" }, "По неделям · долгосрочный тренд"));
  root.append(el("div", { class: "grid2" },
    el("div", { class: "card" }, el("h2", {}, `${what} по неделям`), el("p", { class: "cap" }, weeksCap),
      chart({ kind: "stack", labels: weeks.map(short), tipTitle: i => `Неделя с ${short(weeks[i])}`, integer: true, totalName: "всего",
              aria: `${what} по неделям: количество`,
              series: [{ name: "4–5★", color: "--primary", values: weeks.map(w => reviewBucket(weekDays(w), true)) },
                       { name: "⚠ 1–3★", color: "--bad", values: weeks.map(w => reviewBucket(weekDays(w), false)) }] })),
    el("div", { class: "card" }, el("h2", {}, "Средняя оценка по неделям"), el("p", { class: "cap" }, weeksCap),
      chart({ kind: "line", labels: weeks.map(short), tipTitle: i => `Неделя с ${short(weeks[i])}`, yMax: 5, fmt: ruNum,
              aria: "Средняя оценка по неделям",
              series: [{ name: "Средняя", color: "--accent", values: weeks.map(w => reviewAvg(weekDays(w))) }] }))));

  const hasText = r => !!(r.text && r.text.trim());
  const textChips = [["text", "С текстом", hasText], ["notext", "Без текста", r => !hasText(r)]];
  // В переписках клиент отвечает на запрос оценки текстом всегда — даже
  // голой цифрой («5»). «Без текста» здесь значит «ничего содержательного
  // не дописал», поэтому порог по длине, а не просто наличие поля.
  const hasComment = r => !!(r.text && r.text.trim().length >= 5);
  const commentChips = [["text", "С текстом", hasComment], ["notext", "Без текста", r => !hasComment(r)]];

  if (state.reviewsKind !== "chat") {
    root.append(listCard({ id: "public", title: "Публичные отзывы",
      cap: `${state.studio || "Вся сеть"} · ${periodCaption(days)} · YClients и площадки (Яндекс Карты, 2ГИС и др.)`,
      head: ["Дата", "Студия", "Откуда", "Оценка", "Клиент", "Отзыв"], rows: pub,
      chips: [["all", "Все", () => true], ["neg", "1–3★", isNeg], ...textChips,
              ...sources.map(s => [`src:${s}`, s, r => r.source === s])],
      hay: r => `${r.phone} ${r.client} ${r.text} ${r.source} ${r.studio} ${r.specialist}`,
      render: r => el("tr", { class: isNeg(r) ? "neg" : "" },
        el("td", { "data-l": "Дата" }, short(r.date)), el("td", { "data-l": "Студия" }, r.studio),
        el("td", { "data-l": "Откуда" }, r.source || "—"), el("td", { "data-l": "Оценка" }, r.stars ? starsNode(r.stars) : "—"),
        clientCell(r.phone, r.client),
        el("td", { "data-l": "Отзыв", class: "cmt" }, r.text || "без текста",
          r.specialist ? el("div", { class: "sp" }, `мастер: ${r.specialist}`) : null)) }));
  }
  if (state.reviewsKind !== "public") {
    const rows = chat.list.sort((a, b) => (b.day + b.time).localeCompare(a.day + a.time));
    root.append(listCard({ id: "chat", title: "Оценки визитов из переписок",
      cap: `${state.studio || "Вся сеть"} · ${periodCaption(days)} · ответ клиента на запрос оценки и что он дописал в течение часа`,
      head: ["Дата", "Студия", "Оценка", "Клиент", "Сообщение"], rows,
      chips: [["all", "Все", () => true], ["neg", "1–3★", isNeg], ...commentChips],
      hay: r => `${r.phone} ${r.name} ${r.text} ${r.studio}`,
      render: r => el("tr", { class: isNeg(r) ? "neg" : "" },
        el("td", { "data-l": "Дата" }, `${short(r.day)} ${r.time || ""}`), el("td", { "data-l": "Студия" }, r.studio),
        el("td", { "data-l": "Оценка" }, starsNode(r.rating)), clientCell(r.phone, r.name),
        el("td", { "data-l": "Сообщение", class: "cmt" }, r.text || "—")) }));
    if (!rows.length) root.append(el("div", { class: "note-box" },
      "Оценки из переписок по отдельным клиентам сохраняются с 30.09.2026. За более ранние дни есть только общий счёт по сети — он в плитках и на графике."));
  }
}

// ── Раздел «Администраторы» ────────────────────────────────────────────────
// Просьба заказчицы 06.10.2026: личная динамика администраторов. Звонки и
// переписки у нас считаются по студии за день, а не по человеку, поэтому день
// студии приписывается тому, кто стоит на него в графике YClients (Филиал →
// Настройки → График работы). Двое в графике за день — день идёт обоим и
// считается «сменой вдвоём». Строка таблицы — человек в студии: в разных
// студиях разная база, сравнивать имеет смысл внутри одной.
const shiftData = () => DATA.shifts || null;
const shiftsOn = (day, studio) => ((shiftData().days || {})[day] || {})[studio] || [];
const personName = who => ((shiftData().people || {})[who] || {}).name || "без имени";
const inShiftRange = day => { const s = shiftData(); return !!s && day >= s.from && day <= s.to; };

function adminAcc() {
  return { shifts: 0, shared: 0, cClients: 0, cBooked: 0, cIssues: 0, cAnalyzed: 0, cCalls: 0, cDays: 0, noCallback: 0, cMissed: 0,
           mClients: 0, mBooked: 0, dialogs: 0, unanswered: 0, msgIssues: 0, resp: { sum: 0, weight: 0 } };
}
// Добавляет в накопитель день студии: все её показатели за этот день.
function addStudioDay(a, day, studio) {
  const cc = ((DATA.conversion.calls[day] || {}).studios || {})[studio];
  if (cc) { a.cClients += cc.clients || 0; a.cBooked += cc.booked || 0; }
  const cs = DATA.calls[day], st = ((cs || {}).studios || {})[studio];
  if (st) {
    a.cDays++;
    a.noCallback += (st.missed_no_callback || []).length;
    a.cMissed += st.in_missed || 0;
    // Восстановленные задним числом дни (01–24.09) — без разбора разговоров.
    if (cs.source !== "backfill") {
      a.cIssues += (st.issues || []).length; a.cAnalyzed++;
      a.cCalls += (st.in_total || 0) + (st.out_total || 0);
    }
  }
  const mc = ((DATA.conversion.messages[day] || {}).studios || {})[studio];
  if (mc) { a.mClients += mc.clients || 0; a.mBooked += mc.booked || 0; }
  const ms = (((DATA.msgstats || {})[day] || {}).studios || {})[studio];
  if (ms) {
    a.dialogs += ms.n_dialogs || 0; a.unanswered += ms.n_unanswered || 0; a.msgIssues += ms.n_ai_issues || 0;
    addResponse(a.resp, ms, ms.n_responses);
  }
}

// Администраторы за дни: Map «кто|студия» → {who, studio, acc, days}.
// Плюс дни студий без администратора в графике — их показатели ни на кого не
// записываются, и это надо показать, а не потерять молча.
function adminRows(days) {
  const rows = new Map(), unassigned = {};
  for (const day of days) {
    if (!inShiftRange(day)) continue;
    for (const studio of studioNames()) {
      if ((shiftData().failed || []).includes(studio)) continue;
      const on = shiftsOn(day, studio);
      if (!on.length) {
        const hasData = (DATA.conversion.calls[day] || {}).studios?.[studio] || (DATA.msgstats || {})[day]?.studios?.[studio];
        if (hasData) unassigned[studio] = (unassigned[studio] || 0) + 1;
        continue;
      }
      for (const s of on) {
        const key = `${s.who}|${studio}`;
        if (!rows.has(key)) rows.set(key, { key, who: s.who, studio, acc: adminAcc(), days: [] });
        const r = rows.get(key);
        r.acc.shifts++;
        if (on.length > 1) r.acc.shared++;
        r.days.push(day);
        addStudioDay(r.acc, day, studio);
      }
    }
  }
  const order = s => (DATA.studios.indexOf(s) + 1 || 99);
  return { rows: [...rows.values()].sort((a, b) => order(a.studio) - order(b.studio) || b.acc.shifts - a.acc.shifts),
           unassigned };
}
function studioAcc(days, studio) {
  const a = adminAcc();
  for (const day of days) for (const s of studio ? [studio] : studioNames()) addStudioDay(a, day, s);
  return a;
}

// Порог подсветки «хуже сети»: просадка показателя относительно среднего по
// ВСЕЙ сети — даже если сверху выбрана одна студия (studioNames() тут не
// годится, он уважает фильтр; обходим его явным DATA.studios).
const WARN_PP = 3;       // процентных пунктов — для долей (конверсия, замечания, …)
const WARN_RESP_MIN = 5; // минут сверх сетевого среднего — для времени ответа
function networkBaseline(days) {
  const a = adminAcc();
  for (const day of days) for (const s of DATA.studios) addStudioDay(a, day, s);
  return {
    conv: pct(a.cBooked + a.mBooked, a.cClients + a.mClients),
    callsBooked: pct(a.cBooked, a.cClients),
    callIssues: a.cAnalyzed ? pct(a.cIssues, a.cCalls) : null,
    noCallback: a.cMissed ? pct(a.noCallback, a.cMissed) : null,
    msgBooked: pct(a.mBooked, a.mClients),
    unanswered: a.dialogs ? pct(a.unanswered, a.dialogs) : null,
    msgIssues: a.dialogs ? pct(a.msgIssues, a.dialogs) : null,
    resp: respMinutes(a.resp),
  };
}

// net — сетевой бейзлайн (networkBaseline), всегда по всей сети, независимо
// от фильтра студии сверху. lowBad/highBad — просадка относительно него на
// WARN_PP п.п. и больше: lowBad для долей, где больше — лучше (конверсия),
// highBad — где меньше — лучше (замечания, не перезвонили, без ответа).
function adminCells(a, net) {
  const resp = respMinutes(a.resp);
  const conv = pct(a.cBooked + a.mBooked, a.cClients + a.mClients);
  const callsBooked = pct(a.cBooked, a.cClients);
  const callIssues = a.cAnalyzed ? pct(a.cIssues, a.cCalls) : null;
  const noCallback = a.cMissed ? pct(a.noCallback, a.cMissed) : null;
  const msgBooked = pct(a.mBooked, a.mClients);
  const unanswered = a.dialogs ? pct(a.unanswered, a.dialogs) : null;
  const msgIssues = a.dialogs ? pct(a.msgIssues, a.dialogs) : null;
  const lowBad = (v, base) => v !== null && base !== null && base - v >= WARN_PP;
  const highBad = (v, base) => v !== null && base !== null && v - base >= WARN_PP;
  const respBad = resp !== null && net.resp !== null && resp - net.resp >= WARN_RESP_MIN;
  return [
    el("td", { "data-l": "Смен" }, String(a.shifts), a.shared ? el("span", { class: "pct" }, `вдвоём ${a.shared}`) : null),
    el("td", { "data-l": "Общая конверсия" }, frac(a.cBooked + a.mBooked, a.cClients + a.mClients, lowBad(conv, net.conv))),
    el("td", { "data-l": "Звонки · записались", class: "grp" }, frac(a.cBooked, a.cClients, lowBad(callsBooked, net.callsBooked))),
    el("td", { "data-l": "Замечания по звонкам" }, a.cAnalyzed ? frac(a.cIssues, a.cCalls, highBad(callIssues, net.callIssues)) : "—"),
    el("td", { "data-l": "Не перезвонили" }, a.cMissed ? frac(a.noCallback, a.cMissed, highBad(noCallback, net.noCallback)) : "—"),
    el("td", { "data-l": "Переписки · записались", class: "grp" }, frac(a.mBooked, a.mClients, lowBad(msgBooked, net.msgBooked))),
    el("td", { "data-l": "Без ответа" }, a.dialogs ? frac(a.unanswered, a.dialogs, highBad(unanswered, net.unanswered)) : "—"),
    el("td", { "data-l": "С замечаниями" }, a.dialogs ? frac(a.msgIssues, a.dialogs, highBad(msgIssues, net.msgIssues)) : "—"),
    el("td", { "data-l": "Ответ" }, resp === null ? "—"
      : respBad ? el("span", { class: "flag-bad" }, `⚠ ${ruNum(resp)} мин`) : `${ruNum(resp)} мин`),
  ];
}
// Два ряда заголовков: «Звонки»/«Переписки» группируют свои колонки одной
// подписью сверху, чтобы не повторять слово в каждом заголовке колонки.
function adminHead() {
  return el("thead", {},
    el("tr", {},
      el("th", { rowspan: "2" }, "Администратор"), el("th", { rowspan: "2" }, "Смен"),
      el("th", { rowspan: "2" }, "Общая конверсия"),
      el("th", { colspan: "3", class: "grp" }, "Звонки"), el("th", { colspan: "4", class: "grp" }, "Переписки")),
    el("tr", {},
      el("th", { class: "grp" }, "Записи"), el("th", {}, "Замечания"), el("th", {}, "Не перезвонили"),
      el("th", { class: "grp" }, "Записи"), el("th", {}, "Без ответа"), el("th", {}, "Замечания"), el("th", {}, "Ответ")));
}

// Личная динамика: последние 12 недель по сменам этого человека в этой
// студии, независимо от периода сверху — как «по неделям» в других разделах.
function adminTrend(r) {
  const lastMon = mondayOf(yesterday());
  const weeks = Array.from({ length: 12 }, (_, i) => addDays(lastMon, -7 * (11 - i)));
  const accs = weeks.map(w => {
    const a = adminAcc();
    for (const day of dayRange(w, addDays(w, 6))) {
      if (!inShiftRange(day) || !shiftsOn(day, r.studio).some(s => s.who === r.who)) continue;
      a.shifts++;
      addStudioDay(a, day, r.studio);
    }
    return a.shifts ? a : null;
  });
  const val = f => accs.map(a => (a ? f(a) : null));
  const share = (num, den) => val(a => (a[den] ? pct(a[num], a[den]) : null));
  const detail = (num, den) => val(a => (a[den] ? `${a[num]} из ${a[den]} · ${a.shifts} ${plural(a.shifts, "смена", "смены", "смен")}` : null));
  const labels = weeks.map(short), tipTitle = i => `Неделя с ${short(weeks[i])}`;
  const cap = `${personName(r.who)} · ${r.studio} · по неделям, только его смены`;
  const card = (title, c) => el("div", { class: "card" }, el("h2", {}, title), el("p", { class: "cap" }, cap), c);
  return el("div", { class: "grid2" },
    card("Конверсия в запись, %", chart({ kind: "line", labels, tipTitle, yMax: 100, fmt: v => `${ruNum(v)}%`,
      aria: "Конверсия в запись по неделям: звонки и переписки",
      series: [{ name: "Звонки", color: "--calls", values: share("cBooked", "cClients"), detail: detail("cBooked", "cClients") },
               { name: "Переписки", color: "--messages", values: share("mBooked", "mClients"), detail: detail("mBooked", "mClients") }] })),
    card("Переписки: без ответа и замечания, %", chart({ kind: "line", labels, tipTitle, fmt: v => `${ruNum(v)}%`,
      aria: "Доля переписок без ответа и с замечаниями по неделям",
      series: [{ name: "⚠ Без ответа", color: "--bad", values: share("unanswered", "dialogs"), detail: detail("unanswered", "dialogs") },
               { name: "Замечания", color: "--issue", values: share("msgIssues", "dialogs"), detail: detail("msgIssues", "dialogs") }] })),
    card("Время ответа в переписках, мин", chart({ kind: "line", labels, tipTitle, fmt: ruNum,
      aria: "Среднее время ответа по неделям",
      series: [{ name: "минут", color: "--messages", values: val(a => respMinutes(a.resp)) }] })),
    card("Звонки: замечания и не перезвонили, %", chart({ kind: "line", labels, tipTitle, fmt: v => `${ruNum(v)}%`,
      aria: "Доля звонков с замечаниями и доля пропущенных без перезвона по неделям",
      series: [{ name: "Замечания", color: "--issue", values: share("cIssues", "cCalls"), detail: detail("cIssues", "cCalls") },
               { name: "⚠ Не перезвонили", color: "--bad", values: share("noCallback", "cMissed"), detail: detail("noCallback", "cMissed") }] })));
}

const ADMIN_ISSUE_CH = [["calls", "Звонок"], ["messages", "Переписка"]];
// Общий список тегов обоих каналов (у звонков и переписок частично разные —
// см. TAG_FILTERS) — чипы ниже показывают только те, что реально встретились.
const ADMIN_ISSUE_TAGS = [["primary", "Первичный"], ["unbooked", "Не записался"], ["unanswered", "Не ответили"],
                          ["nocallback", "Не перезвонили"], ["issue", "Замечание"]];

// Конкретные случаи (не агрегаты): те же данные, что в общей «Кто требует
// внимания», но отфильтрованные на смены этого администратора — r.days и
// r.studio пришли из adminRows() для текущего периода сверху. Чипы канала и
// тегов — мультивыбор, и работают вместе как «И»: «Звонок» + «Не записался» +
// «Первичный» одновременно сузят список до строк со всеми тремя признаками.
function adminIssuesCard(r) {
  const rowsOf = ch => peopleRows(ch, r.days).rows.filter(x => x.studio === r.studio).map(x => ({ ...x, ch }));
  const rows = [...rowsOf("calls"), ...rowsOf("messages")].sort((a, b) => b.day.localeCompare(a.day));
  const selCh = new Set(), selTags = new Set();
  const matches = x => (!selCh.size || selCh.has(x.ch)) && [...selTags].every(t => hasTag(x, t));

  const chChips = el("div", { class: "chips", role: "group", "aria-label": "Канал" });
  const tagChips = el("div", { class: "chips", role: "group", "aria-label": "Тип" });
  const body = el("div", {});
  const card = el("div", { class: "card people" });
  card.append(el("div", { class: "card-head" }, el("h2", {}, "Ошибки и пропуски"),
      dlButton("ошибки-администратора.csv", () => body)),
    el("p", { class: "cap" }, `${personName(r.who)} · ${r.studio} · его смены за ${periodCaption(r.days)}`),
    el("div", { class: "tools" }, chChips, tagChips), body);

  const draw = () => {
    chChips.textContent = "";
    ADMIN_ISSUE_CH.forEach(([id, lab]) => {
      const n = rows.filter(x => x.ch === id).length;
      if (!n) return;
      chChips.append(el("button", { type: "button", "aria-pressed": String(selCh.has(id)),
        onclick: () => { selCh.has(id) ? selCh.delete(id) : selCh.add(id); draw(); } }, lab, el("span", { class: "n" }, String(n))));
    });
    tagChips.textContent = "";
    ADMIN_ISSUE_TAGS.forEach(([id, lab]) => {
      const n = rows.filter(x => hasTag(x, id)).length;
      if (!n) return;
      tagChips.append(el("button", { type: "button", "aria-pressed": String(selTags.has(id)),
        onclick: () => { selTags.has(id) ? selTags.delete(id) : selTags.add(id); draw(); } }, lab, el("span", { class: "n" }, String(n))));
    });
    const shown = rows.filter(matches);
    body.textContent = "";
    if (!shown.length) {
      body.append(el("div", { class: "empty-box" }, rows.length ? "Ничего не нашлось" : "За эти смены ошибок и пропусков не найдено"));
      return;
    }
    body.append(el("div", { class: "tbl-wrap" }, el("table", { class: "ppl" },
      el("thead", {}, el("tr", {}, ["Дата", "Канал", "Клиент", "Теги", "Комментарий"].map(h => el("th", {}, h)))),
      el("tbody", {}, shown.map(x => el("tr", {},
        el("td", { "data-l": "Дата" }, short(x.day)),
        el("td", { "data-l": "Канал" }, x.ch === "calls" ? "Звонок" : "Переписка"),
        el("td", { "data-l": "Клиент", class: "who" }, externalPhoneLink(x.ch, x.phone) || x.name || "без номера",
          x.phone && x.name ? el("span", { class: "nm" }, x.name) : null),
        el("td", { "data-l": "Теги", class: "tags" }, Object.keys(TAGS).filter(t => x.tags.has(t))
          .map(t => el("span", { class: `tag ${TAGS[t].cls}` }, TAGS[t].label))),
        el("td", { "data-l": "Комментарий", class: "cmt" }, x.notes.length ? x.notes.map(noteNode) : "—")))))));
  };
  draw();
  return card;
}

function viewAdmins(root) {
  if (!shiftData()) {
    root.append(el("div", { class: "empty-box" },
      "График администраторов из YClients пока не загружен — раздел заполнится со следующим обновлением данных."));
    return;
  }
  const days = periodDays();
  const { rows, unassigned } = adminRows(days);
  const card = el("div", { class: "card people" });
  const body = el("div", {});
  card.append(el("div", { class: "card-head" }, el("h2", {}, "Администраторы"),
      dlButton("администраторы.csv", () => body)),
    el("p", { class: "cap" }, `${state.studio || "Вся сеть"} · ${periodCaption(days)} · смены по графику YClients · нажмите на строку — личная динамика`),
    body);
  if (!rows.length) {
    body.append(el("div", { class: "empty-box" }, "В графике YClients за этот период нет смен администраторов"));
  } else {
    const total = studioAcc(days.filter(inShiftRange), state.studio);
    total.shifts = sum(rows.map(r => r.acc.shifts));
    const net = networkBaseline(days.filter(inShiftRange));
    const tr = rows.map(r => el("tr", { class: `click${state.admin === r.key ? " sel" : ""}`,
        onclick: () => { state.admin = state.admin === r.key ? "" : r.key; renderContent();
                         if (state.admin) $("#admin-trend")?.scrollIntoView({ behavior: "smooth", block: "start" }); } },
      el("td", { "data-l": "Администратор", class: "who" }, personName(r.who), el("span", { class: "nm" }, r.studio)),
      adminCells(r.acc, net)));
    tr.push(el("tr", { class: "total" }, el("td", { "data-l": "", class: "who" }, state.studio || "Вся сеть",
      el("span", { class: "nm" }, "все дни, для сравнения")), adminCells(total, net)));
    body.append(el("div", { class: "tbl-wrap" }, el("table", { class: "ppl adm" }, adminHead(), el("tbody", {}, tr))));
  }
  root.append(card);

  const gaps = Object.entries(unassigned);
  if (gaps.length) root.append(el("div", { class: "note-box" },
    `Нет администратора в графике YClients: ${gaps.map(([s, n]) => `${s} — ${n} ${plural(n, "день", "дня", "дней")}`).join(", ")}. ` +
    "Показатели этих дней ни на кого не записаны — проверьте график работы в YClients."));
  if ((shiftData().failed || []).length) root.append(el("div", { class: "note-box" },
    `YClients не отдал график: ${shiftData().failed.join(", ")} — эти студии сейчас без администраторов.`));

  const sel = rows.find(r => r.key === state.admin);
  if (sel) {
    root.append(el("div", { class: "subgroup", id: "admin-trend" }, `${personName(sel.who)} · динамика`));
    root.append(adminTrend(sel));
    root.append(adminIssuesCard(sel));
  }
  root.append(el("div", { class: "note-box" },
    "Звонки и переписки считаются по студии за день, поэтому день приписывается администратору, который стоит в графике " +
    "работы YClients (Филиал → Настройки → График работы). Если в графике двое — день засчитан обоим («вдвоём»). " +
    "Замечания по звонкам — разговоры, где модель нашла ошибки администратора, в процентах от звонков за дни с разбором. " +
    "Строка «Вся сеть» или студии — все дни периода, для сравнения. " +
    `⚠ — показатель заметно хуже среднего по всей сети (${WARN_PP} п.п. и больше для долей, ${WARN_RESP_MIN} мин и больше ` +
    "для времени ответа) — сравнение всегда со всей сетью, даже если выше выбрана одна студия."));
}

// ── Каркас ─────────────────────────────────────────────────────────────────
const TABS = [
  { id: "calls", label: "Звонки", view: viewCalls },
  { id: "messages", label: "Переписки", view: viewMessages },
  { id: "reviews", label: "Отзывы", view: viewReviews },
  { id: "admins", label: "Администраторы", view: viewAdmins },
];

function setStudio(s) { state.studio = s; save(); render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
function save() {
  try { localStorage.setItem("fr-cs-view", JSON.stringify({ tab: state.tab, studio: state.studio, period: state.period,
    reviewsKind: state.reviewsKind })); }
  catch (e) { /* не страшно */ }
}
function restore() {
  try {
    const v = JSON.parse(localStorage.getItem("fr-cs-view") || "{}");
    if (TABS.some(t => t.id === v.tab)) state.tab = v.tab;
    if (!v.studio || DATA.studios.includes(v.studio)) state.studio = v.studio || "";
    if (PERIODS.some(p => p.id === v.period)) state.period = v.period;
    if (v.reviewsKind === "chat" || v.reviewsKind === "public" || v.reviewsKind === "all") state.reviewsKind = v.reviewsKind;
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
