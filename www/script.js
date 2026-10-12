/* ============================== CONSTANTS ============================== */
const KEY_LOG = "timeTracker.v1";
const KEY_SETTINGS = "timeTracker.settings.v1";
const KEY_BACKUP = "timeTracker.backup.v1";

const DEFAULT_SETTINGS = {
    dailyNorm: 8.5,
    monthlyNorm: 182
};
let settings = { ...DEFAULT_SETTINGS };

let log = [];
let startTs = null;
let tick = null;
let ref = null;
let lastJson = "";
let pendingImport = [];

let filter = { kind: "all", from: null, to: null };

/* ============================== HELPERS ============================== */
const $ = id => document.getElementById(id);
const p2 = n => String(n).padStart(2, "0");
const dur = ms => {
    const s = Math.floor(ms / 1000);
    return p2(Math.floor(s / 3600)) + ":" + p2(Math.floor(s % 3600 / 60)) + ":" + p2(s % 60);
};
const durHours = ms => (ms / 3600000).toFixed(2) + " ч";
const dt = ts => { const d = new Date(ts); return p2(d.getDate()) + "." + p2(d.getMonth() + 1) + "." + d.getFullYear(); };
const tm = ts => { const d = new Date(ts); return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()); };
const tmv = ts => { const d = new Date(ts); return p2(d.getHours()) + ":" + p2(d.getMinutes()); };
const buzz = () => { try { navigator.vibrate && navigator.vibrate(30); } catch (e) { } };
const dayKey = ts => dt(ts);

const HOUR = 3600000;
function normMs() { return settings.dailyNorm * HOUR; }
function norm125Ms() { return (settings.dailyNorm + 2) * HOUR; }

const MONTH_NAMES = ["Январь","Февраль","Март","Апрель","Май","Июнь",
    "Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

/* ============================== SETTINGS ============================== */
function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(KEY_SETTINGS) || "{}");
        settings = {
            dailyNorm: parseFloat(s.dailyNorm) > 0 ? parseFloat(s.dailyNorm) : DEFAULT_SETTINGS.dailyNorm,
            monthlyNorm: parseFloat(s.monthlyNorm) > 0 ? parseFloat(s.monthlyNorm) : DEFAULT_SETTINGS.monthlyNorm
        };
    } catch (e) { settings = { ...DEFAULT_SETTINGS }; }
    applySettingsUI();
}
function saveSettings() {
    try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings)); } catch (e) { }
    applySettingsUI();
}
function applySettingsUI() {
    const T1 = settings.dailyNorm;
    const T2 = settings.dailyNorm + 2;
    $("legend").innerHTML =
        `<span><i style="background:var(--go2)"></i>до ${T1.toFixed(2)} ч</span>` +
        `<span><i style="background:var(--acc)"></i>${T1.toFixed(2)}–${T2.toFixed(2)} ч (125%)</span>` +
        `<span><i style="background:var(--stop)"></i>свыше ${T2.toFixed(2)} ч (150%)</span>`;
}

/* ============================== CALC ============================== */
function calc() {
    const out = {}, acc = {};
    const T1 = normMs(), T2 = norm125Ms();
    log.slice().sort((a, b) => a.start - b.start).forEach(r => {
        const k = dayKey(r.start);
        let d = r.end - r.start;

        // Спец. типы: Выходной и Больничный считаются как 0 мс
        if (r.type === "off" || r.type === "sick") {
            d = 0;
        }

        const before = acc[k] || 0, after = before + d;
        const a = Math.max(0, Math.min(after, T1) - Math.min(before, T1));
        const b = Math.max(0, Math.min(after, T2) - Math.max(before, T1));
        const c = d - a - b;
        out[r.id] = { d, a, b, c };
        acc[k] = after;
    });
    return out;
}
const z = v => v > 0 ? dur(v) : "–";

/* ============================== RING ============================== */
function ring(cur) {
    const T1 = normMs(), T2 = norm125Ms();
    const g = Math.min(cur, T1) / T2 * 100;
    const y = Math.max(0, Math.min(cur, T2) - T1) / T2 * 100;
    const r = Math.min(1, Math.max(0, cur - T2) / (3 * HOUR)) * 100;
    $("rg").style.strokeDasharray = g + " " + (100 - g);
    $("ry").style.strokeDasharray = y + " " + (100 - y);
    $("ry").style.strokeDashoffset = -(T1 / T2 * 100);
    $("rr").style.strokeDasharray = r + " " + (100 - r);
}

/* ============================== STORAGE ============================== */
let tsumLog = 0;
function load() {
    try {
        const d = JSON.parse(localStorage.getItem(KEY_LOG) || "{}");
        log = d.log || [];
        startTs = d.startTs || null;
    } catch (e) { log = []; startTs = null; }
}
function local() {
    try { localStorage.setItem(KEY_LOG, JSON.stringify({ log, startTs })); } catch (e) { }
}
function save() {
    local();
    if (ref) {
        lastJson = JSON.stringify({ log, startTs });
        ref.set({ log, startTs }).catch(() => setSync("Ошибка синхронизации"));
    }
}
function setSync(t) { $("sync").textContent = t; }

async function initSync() {
    try {
        if (typeof claude === "undefined") {
            setSync("Только это устройство");
            return;
        }
        const db = await claude.use("db"), user = await claude.use("user");
        if (!db || !user) { setSync("Только это устройство"); return; }
        const id = await user.id();
        if (!id) { setSync("Только это устройство"); return; }
        ref = db.doc("data/users/" + id + "/tracker");
        let first = true;
        ref.onSnapshot(snap => {
            const r = snap.exists ? snap.data() : null;
            if (first) {
                first = false;
                if (r) {
                    const m = new Map();
                    (r.log || []).concat(log).forEach(x => m.set(x.id, x));
                    log = [...m.values()].sort((a, b) => a.start - b.start);
                    startTs = r.startTs !== undefined && r.startTs !== null ? r.startTs : startTs;
                }
                save(); render(); loop();
            } else if (r && JSON.stringify({ log: r.log || [], startTs: r.startTs ?? null }) !== lastJson) {
                log = r.log || [];
                startTs = r.startTs ?? null;
                lastJson = JSON.stringify({ log, startTs });
                local(); render(); loop();
            }
            setSync("Синхронизировано");
        }, () => setSync("Только это устройство"));
    } catch (e) { setSync("Только это устройство"); }
}

/* ============================== FILTERS ============================== */
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfMonth(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(1); return x; }
function endOfDay(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

function applyChip(kind) {
    const now = new Date();
    if (kind === "today") {
        filter = { kind, from: startOfDay(now).getTime(), to: endOfDay(now).getTime() };
        $("flt-from").value = dateInputValue(startOfDay(now));
        $("flt-to").value = dateInputValue(endOfDay(now));
    } else if (kind === "month") {
        filter = { kind, from: startOfMonth(now).getTime(), to: endOfDay(now).getTime() };
        $("flt-from").value = dateInputValue(startOfMonth(now));
        $("flt-to").value = dateInputValue(endOfDay(now));
    } else {
        filter = { kind: "all", from: null, to: null };
        $("flt-from").value = "";
        $("flt-to").value = "";
    }
    document.querySelectorAll(".filters .chip").forEach(b => b.classList.toggle("on", b.dataset.range === filter.kind));
    render();
}

function dateInputValue(d) {
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}

function filteredLog() {
    if (filter.kind === "all" || filter.from === null) return log.slice();
    return log.filter(r => r.start >= filter.from && r.start <= filter.to);
}

/* ============================== RENDER ============================== */
function render() {
    const run = startTs !== null;
    $("toggle").textContent = run ? "Стоп" : "Старт";
    $("toggle").classList.toggle("run", run);
    $("since").textContent = run ? "Начато в " + tm(startTs) : "Нажмите, чтобы начать";
    $("clock").textContent = dur(run ? Date.now() - startTs : 0);
    $("stl").textContent = run ? "Начало" : "Начать с";
    if (document.activeElement !== $("st")) {
        $("st").value = run ? p2(new Date(startTs).getHours()) + ":" + p2(new Date(startTs).getMinutes()) : ($("st").value || "");
    }
    $("clr").hidden = run || !$("st").value;

    const today = dt(Date.now());
    const T1 = normMs();
    const tsum = log.filter(r => dayKey(r.start) === today).reduce((a, r) => {
        if (r.type === "off" || r.type === "sick") return a;
        return a + (r.end - r.start);
    }, 0);
    const cur = tsum + (run ? Date.now() - startTs : 0);
    tsumLog = tsum;
    ring(cur);
    $("today").innerHTML = "Сегодня: <b>" + dur(cur) + "</b><div id=\"bl\">" +
        (cur < T1 ? "До нормы " + settings.dailyNorm.toFixed(2) + " ч осталось " + dur(T1 - cur) : "Норма дня выполнена") +
        "</div>";

    const mStart = startOfMonth(new Date()).getTime();
    const mEnd = endOfDay(new Date()).getTime();
    const mMs = log.filter(r => r.start >= mStart && r.start <= mEnd).reduce((a, r) => {
        if (r.type === "off" || r.type === "sick") return a;
        return a + (r.end - r.start);
    }, 0);
    const mNormMs = settings.monthlyNorm * HOUR;
    const pct = Math.min(100, Math.round(mMs / mNormMs * 100));
    $("month-sum").innerHTML =
        `Месяц: <b>${durHours(mMs)}</b> из <b>${settings.monthlyNorm} ч</b> ` +
        (mMs < mNormMs ? `— осталось <b>${durHours(mNormMs - mMs)}</b>` : `— норма выполнена 🎉`) +
        `<div class="mbar"><i style="width:${pct}%"></i></div>`;

    const list = filteredLog();
    const totalMs = list.reduce((a, r) => {
        if (r.type === "off" || r.type === "sick") return a;
        return a + (r.end - r.start);
    }, 0);
    $("cnt").textContent = list.length ? "Записей: " + list.length + " / " + log.length : "";
    $("total").textContent = list.length ? "Всего: " + dur(totalMs) : "";
    $("clear").hidden = !log.length;

    $("empty").textContent = log.length
        ? (list.length ? "" : "В выбранном периоде записей нет.")
        : "Записей пока нет. Запустите таймер или нажмите «Импорт».";

    const rows = $("rows");
    rows.innerHTML = "";
    const cc = calc();
    const T = { d: 0, a: 0, b: 0, c: 0 };
    list.forEach((r, i) => {
        const c = cc[r.id] || { d: r.end - r.start, a: 0, b: 0, c: 0 };
        T.d += c.d; T.a += c.a; T.b += c.b; T.c += c.c;
        const tr = document.createElement("tr");

        let startText = tm(r.start);
        let endText = tm(r.end);

        if (r.type === "off") {
            startText = "🌴 Выходной";
            endText = "—";
        } else if (r.type === "sick") {
            startText = "🏥 Больничный";
            endText = "—";
        } else if (r.type === "holiday") {
            startText = "🎉 Праздник";
            endText = "8.5 ч";
        }

        const vals = [i + 1, dt(r.start), startText, endText, dur(c.d), z(c.a), z(c.b), z(c.c)];
        vals.forEach((v, k) => {
            const td = document.createElement("td");
            td.textContent = v;
            if (k === 4) td.className = "du";
            if (k === 5) td.className = "c100";
            if (k === 6) td.className = "c125";
            if (k === 7) td.className = "c150";
            tr.appendChild(td);
        });
        const td = document.createElement("td");
        td.className = "row-btns";
        const bEdit = document.createElement("button");
        bEdit.className = "edit"; bEdit.textContent = "✎"; bEdit.title = "Редактировать";
        bEdit.onclick = () => openEdit(r.id);
        const bDel = document.createElement("button");
        bDel.className = "del"; bDel.textContent = "×"; bDel.title = "Удалить";
        bDel.onclick = () => {
            if (!confirm("Удалить запись " + dt(r.start) + " " + tm(r.start) + "—" + tm(r.end) + "?")) return;
            log = log.filter(x => x.id !== r.id); save(); render();
        };
        td.appendChild(bEdit); td.appendChild(bDel);
        tr.appendChild(td);
        rows.appendChild(tr);
    });

    const ft = $("foot");
    ft.innerHTML = "";
    if (list.length) {
        const tr = document.createElement("tr");
        ["", "Итого", "", "", dur(T.d), z(T.a), z(T.b), z(T.c), ""].forEach(v => {
            const td = document.createElement("td");
            td.textContent = v;
            tr.appendChild(td);
        });
        ft.appendChild(tr);
    }

    drawHeatmap();
}

/* ============================== HEATMAP ============================== */
function drawHeatmap() {
    const grid = $("heat-grid");
    grid.innerHTML = "";
    const weeks = 26;
    const today = startOfDay(new Date());
    const end = new Date(today);
    const dayEnd = end.getDay();
    end.setDate(end.getDate() + (6 - dayEnd));
    const start = new Date(end);
    start.setDate(start.getDate() - (weeks * 7 - 1));

    const perDay = {};
    log.forEach(r => {
        if (r.type === "off" || r.type === "sick") return;
        const k = dayKey(r.start);
        perDay[k] = (perDay[k] || 0) + (r.end - r.start);
    });

    const T1 = normMs();
    const T2 = norm125Ms();
    const todayKey = dt(today.getTime());
    const frag = document.createDocumentFragment();
    for (let i = 0; i < weeks * 7; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        const cell = document.createElement("div");
        cell.className = "heat-cell";
        const k = dt(d.getTime());
        const ms = perDay[k] || 0;
        let lvl = 0;
        if (ms > 0) {
            if (ms < T1 * 0.5) lvl = 1;
            else if (ms < T1) lvl = 2;
            else if (ms < T2) lvl = 3;
            else if (ms < T2 + 2 * HOUR) lvl = 4;
            else lvl = 5;
        }
        cell.classList.add("h" + lvl);
        if (k === todayKey) cell.classList.add("today");
        cell.title = k + ": " + durHours(ms);
        cell.onclick = () => {
            const from = startOfDay(d).getTime();
            const to = endOfDay(d).getTime();
            filter = { kind: "custom", from, to };
            $("flt-from").value = dateInputValue(new Date(from));
            $("flt-to").value = dateInputValue(new Date(to));
            document.querySelectorAll(".filters .chip").forEach(b => b.classList.remove("on"));
            render();
            $("tbl").scrollIntoView({ behavior: "smooth", block: "start" });
        };
        frag.appendChild(cell);
    }
    grid.appendChild(frag);
    $("heat-range").textContent = dt(start.getTime()) + " — " + dt(end.getTime());
}

/* ============================== TIMER & REAL CLOCK LOOP ============================== */
let raf = null;

function frame() {
    if (startTs === null) { raf = null; return; }
    const f = ((Date.now() - startTs) % 60000) / 60000, a = f * 2 * Math.PI;
    $("sw").style.strokeDasharray = (f * 100) + " " + (100 - f * 100);
    const d = $("dot");
    d.setAttribute("cx", (100 + 98 * Math.cos(a)).toFixed(2));
    d.setAttribute("cy", (100 + 98 * Math.sin(a)).toFixed(2));
    d.setAttribute("opacity", "1");
    raf = requestAnimationFrame(frame);
}

function updateRealClock() {
    const rc = $("real-clock");
    if (rc) rc.textContent = tm(Date.now());
}

function loop() {
    document.body.classList.toggle("running", startTs !== null);
    if (startTs === null) {
        $("sw").style.strokeDasharray = "0 100";
        $("dot").setAttribute("opacity", "0");
    } else if (!raf) {
        raf = requestAnimationFrame(frame);
    }

    clearInterval(tick);
    updateRealClock();
    tick = setInterval(() => {
        updateRealClock();
        if (startTs !== null) {
            $("clock").textContent = dur(Date.now() - startTs);
            ring(tsumLog + Date.now() - startTs);
            if (Date.now() % 5000 < 260) render();
        }
    }, 250);
}

/* ============================== TABS ============================== */
function tab(n) {
    const screens = { t: $("t-screen"), h: $("h-screen"), m: $("m-screen") };
    const buttons = { t: $("n-t"), h: $("n-h"), m: $("n-m") };

    ["t", "h", "m"].forEach(k => {
        if (screens[k]) {
            if (k === n) {
                screens[k].removeAttribute("hidden");
                screens[k].scrollTop = 0;
            } else {
                screens[k].setAttribute("hidden", "");
            }
        }
        if (buttons[k]) {
            buttons[k].classList.toggle("on", k === n);
        }
    });
}

/* ============================== MANUAL ============================== */
function manual() {
    const d = $("md").value;
    const type = $("m-type") ? $("m-type").value : "work";
    if (!d) return null;

    const [y, mo, da] = d.split("-").map(Number);

    if (type !== "work") {
        const st = new Date(y, mo - 1, da, 8, 0, 0, 0).getTime();
        let duration = 0;
        if (type === "holiday") {
            duration = 8.5 * HOUR;
        }
        return {
            id: Date.now() + Math.floor(Math.random() * 10000),
            start: st,
            end: st + duration,
            type: type
        };
    }

    const a = $("ms").value, b = $("me").value;
    if (!a || !b) return null;

    const st = new Date(y, mo - 1, da, +a.slice(0, 2), +a.slice(3, 5), 0, 0).getTime();
    let en = new Date(y, mo - 1, da, +b.slice(0, 2), +b.slice(3, 5), 0, 0).getTime(), next = false;
    if (en <= st) { en += 864e5; next = true; }
    return { id: Date.now() + Math.floor(Math.random() * 10000), start: st, end: en, type: "work", next };
}

function preview() {
    const type = $("m-type") ? $("m-type").value : "work";
    const timeRow = $("m-time-row");
    if (timeRow) {
        timeRow.style.display = type === "work" ? "grid" : "none";
    }

    const r = manual();
    if (!r) {
        $("pv").textContent = type === "work" ? "Введите число, начало и конец" : "Выберите число";
        $("add").disabled = true;
        return;
    }

    if (r.type === "off") {
        $("pv").innerHTML = "Тип: <b>Выходной</b><br>Длительность: <b>0 ч</b>";
    } else if (r.type === "sick") {
        $("pv").innerHTML = "Тип: <b>Больничный</b><br>Длительность: <b>0 ч</b>";
    } else if (r.type === "holiday") {
        $("pv").innerHTML = "Тип: <b>Праздник</b><br>Длительность: <b>8.5 ч</b> (100%: 8.5 ч)";
    } else {
        const keep = log; log = log.concat([r]); const c = calc()[r.id]; log = keep;
        $("pv").innerHTML = "Длительность: <b>" + dur(c.d) + "</b>" + (r.next ? " (конец на следующий день)" : "") +
            "<br>100%: " + z(c.a) + " · 125%: " + z(c.b) + " · 150%: " + z(c.c);
    }
    $("add").disabled = false;
}

/* ============================== EDIT ============================== */
let editId = null;

function openEdit(id) {
    const r = log.find(x => x.id === id);
    if (!r) return;
    editId = id;
    $("ed-date").value = dateInputValue(new Date(r.start));
    $("ed-start").value = tmv(r.start);
    $("ed-end").value = tmv(r.end);
    $("edit-modal").hidden = false;
}

function saveEdit() {
    const r = log.find(x => x.id === editId);
    if (!r) { $("edit-modal").hidden = true; return; }
    const d = $("ed-date").value, a = $("ed-start").value, b = $("ed-end").value;
    if (!d || !a || !b) { alert("Заполните дату, начало и конец"); return; }
    const [y, mo, da] = d.split("-").map(Number);
    const st = new Date(y, mo - 1, da, +a.slice(0, 2), +a.slice(3, 5), 0, 0).getTime();
    let en = new Date(y, mo - 1, da, +b.slice(0, 2), +b.slice(3, 5), 0, 0).getTime();
    if (en <= st) en += 864e5;
    r.start = st; r.end = en;
    log.sort((x, y) => x.start - y.start);
    save(); render();
    $("edit-modal").hidden = true;
}

/* ============================== EXPORT ============================== */
function buildMonthList() {
    const set = new Set();
    log.forEach(r => {
        const d = new Date(r.start);
        set.add(d.getFullYear() + "-" + p2(d.getMonth() + 1));
    });
    const arr = [...set].sort().reverse();
    const sel = $("exp-month");
    sel.innerHTML = "";
    if (!arr.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "Нет данных";
        sel.appendChild(opt);
        return;
    }
    arr.forEach(key => {
        const [y, m] = key.split("-").map(Number);
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = MONTH_NAMES[m - 1] + " " + y;
        sel.appendChild(opt);
    });
}

function openExportModal() {
    if (!log.length) { alert("Нет записей для экспорта"); return; }
    buildMonthList();
    $("export-modal").hidden = false;
}
function closeExportModal() { $("export-modal").hidden = true; }

function exportList() {
    const v = document.querySelector('input[name="exp-range"]:checked').value;
    if (v === "month") {
        const key = $("exp-month").value;
        if (!key) { alert("Выберите месяц"); return null; }
        const [y, m] = key.split("-").map(Number);
        const from = new Date(y, m - 1, 1, 0, 0, 0, 0).getTime();
        const to = new Date(y, m, 0, 23, 59, 59, 999).getTime();
        return log.filter(r => r.start >= from && r.start <= to);
    }
    return log.slice();
}

async function exportXlsx() {
    const list = exportList();
    if (list === null) return;
    if (!list.length) { alert("В выбранном периоде нет записей"); return; }
    if (typeof XLSX === "undefined") { alert("Не удалось загрузить Excel-модуль"); return; }

    const cc = calc();
    const tot = { d: 0, a: 0, b: 0, c: 0 };

    const aoa = [];
    aoa.push(["Учёт рабочего времени"]);
    aoa.push(["Период:", dt(list[0].start) + " — " + dt(list[list.length - 1].start)]);
    aoa.push(["Сформировано:", new Date().toLocaleString("ru-RU")]);
    aoa.push(["Норма дня, ч:", settings.dailyNorm]);
    aoa.push(["Норма месяца, ч:", settings.monthlyNorm]);
    aoa.push([]);
    aoa.push(["№", "Число", "Начало", "Конец", "За день", "100%", "125%", "150%"]);
    const headerRowIdx = aoa.length - 1;

    list.forEach((r, i) => {
        const c = cc[r.id] || { d: r.end - r.start, a: 0, b: 0, c: 0 };
        tot.d += c.d; tot.a += c.a; tot.b += c.b; tot.c += c.c;

        let stVal = tmv(r.start);
        let enVal = tmv(r.end);
        if (r.type === "off") { stVal = "Выходной"; enVal = "-"; }
        else if (r.type === "sick") { stVal = "Больничный"; enVal = "-"; }
        else if (r.type === "holiday") { stVal = "Праздник"; enVal = "8.5 ч"; }

        aoa.push([
            i + 1,
            dt(r.start),
            stVal,
            enVal,
            dur(c.d).slice(0, 5),
            z(c.a) !== "–" ? z(c.a).slice(0, 5) : "–",
            z(c.b) !== "–" ? z(c.b).slice(0, 5) : "–",
            z(c.c) !== "–" ? z(c.c).slice(0, 5) : "–"
        ]);
    });

    const totalRowIdx = aoa.length;
    aoa.push([
        "", "Итого", "", "",
        dur(tot.d),
        z(tot.a),
        z(tot.b),
        z(tot.c)
    ]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [
        { wch: 5 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
        { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }
    ];
    ws["!rows"] = [];
    ws["!rows"][headerRowIdx] = { hpt: 22 };
    ws["!rows"][totalRowIdx] = { hpt: 22 };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Время");

    const name = "uchet-vremeni.xlsx";
    const P = window.Capacitor && Capacitor.Plugins;
    if (P && P.Filesystem && P.Share) {
        const b64 = XLSX.write(wb, { bookType: "xlsx", type: "base64", cellStyles: true });
        await P.Filesystem.writeFile({ path: name, data: b64, directory: "CACHE" });
        const u = await P.Filesystem.getUri({ path: name, directory: "CACHE" });
        await P.Share.share({ title: "Учёт времени", url: u.uri });
    } else {
        XLSX.writeFile(wb, name, { cellStyles: true });
    }
    closeExportModal();
}

async function exportJson() {
    const list = exportList();
    if (list === null) return;
    if (!list.length) { alert("В выбранном периоде нет записей"); return; }
    const name = "uchet-vremeni-backup.json";
    const jsonStr = JSON.stringify({ version: 1, exportedAt: Date.now(), settings, log: list }, null, 2);
    const P = window.Capacitor && Capacitor.Plugins;
    if (P && P.Filesystem && P.Share) {
        const bytes = new TextEncoder().encode(jsonStr);
        let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const b64 = btoa(bin);
        await P.Filesystem.writeFile({ path: name, data: b64, directory: "CACHE" });
        const u = await P.Filesystem.getUri({ path: name, directory: "CACHE" });
        await P.Share.share({ title: "Резервная копия", url: u.uri });
    } else {
        const blob = new Blob([jsonStr], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    closeExportModal();
}

async function exportCsv() {
    const list = exportList();
    if (list === null) return;
    if (!list.length) { alert("В выбранном периоде нет записей"); return; }
    const cc = calc();
    const escapeCsv = (val) => `"${String(val).replace(/"/g, '""')}"`;

    const lines = [["№", "Число", "Начало", "Конец", "За день", "100%", "125%", "150%"].map(escapeCsv).join(",")];
    list.forEach((r, i) => {
        const c = cc[r.id] || { d: r.end - r.start, a: 0, b: 0, c: 0 };
        let stVal = tmv(r.start);
        let enVal = tmv(r.end);
        if (r.type === "off") { stVal = "Выходной"; enVal = "-"; }
        else if (r.type === "sick") { stVal = "Больничный"; enVal = "-"; }
        else if (r.type === "holiday") { stVal = "Праздник"; enVal = "8.5 ч"; }

        lines.push([
            i + 1, dt(r.start), stVal, enVal,
            dur(c.d).slice(0, 5),
            z(c.a) !== "–" ? z(c.a).slice(0, 5) : "–",
            z(c.b) !== "–" ? z(c.b).slice(0, 5) : "–",
            z(c.c) !== "–" ? z(c.c).slice(0, 5) : "–"
        ].map(escapeCsv).join(","));
    });
    const text = lines.join("\n");
    try {
        await navigator.clipboard.writeText(text);
        alert("CSV скопирован. Открой Google Таблицы и вставь (Ctrl+V / ⌘V).");
    } catch (e) {
        alert("Не удалось скопировать. Вот данные:\n\n" + text);
    }
    closeExportModal();
}

/* ============================== IMPORT ============================== */
$("btn-import").onclick = () => { $("file-import").value = ""; $("file-import").click(); buzz(); };
$("file-import").onchange = e => { const f = e.target.files && e.target.files[0]; if (f) handleFileImport(f); };

function parseDateCell(val) {
    if (val === undefined || val === null || val === "") return null;
    if (val instanceof Date) return { y: val.getFullYear(), m: val.getMonth(), d: val.getDate() };
    if (typeof val === "number" && typeof XLSX !== "undefined" && XLSX.SSF) {
        const p = XLSX.SSF.parse_date_code(val);
        if (p && p.y >= 2000) return { y: p.y, m: p.m - 1, d: p.d };
    }
    const s = String(val).trim();
    const m1 = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (m1) { const yr = +m1[3] < 100 ? 2000 + Number(m1[3]) : +m1[3]; return { y: yr, m: +m1[2] - 1, d: +m1[1] }; }
    const m2 = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
    if (m2) return { y: +m2[1], m: +m2[2] - 1, d: +m2[3] };
    return null;
}

function parseTimeCell(val) {
    if (val === undefined || val === null || val === "") return null;
    if (val instanceof Date) return { h: val.getHours(), m: val.getMinutes(), s: val.getSeconds() };
    if (typeof val === "number" && typeof XLSX !== "undefined" && XLSX.SSF) {
        const p = XLSX.SSF.parse_date_code(val);
        if (p) return { h: p.H, m: p.M, s: p.S };
    }
    const s = String(val).trim();
    const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return { h: +m[1], m: +m[2], s: m[3] ? +m[3] : 0 };
    return null;
}

function parseExcelRows(rawRows) {
    if (!rawRows || !rawRows.length) return [];
    let dateCol = -1, startCol = -1, endCol = -1, startRow = 0;
    for (let r = 0; r < Math.min(10, rawRows.length); r++) {
        const row = rawRows[r] || [];
        for (let c = 0; c < row.length; c++) {
            const cell = String(row[c] || "").toLowerCase().trim();
            if (cell.includes("числ") || cell.includes("дат") || cell === "date") dateCol = c;
            if (cell.includes("нач") || cell.includes("старт") || cell === "start") startCol = c;
            if (cell.includes("кон") || cell.includes("стоп") || cell === "end") endCol = c;
        }
        if (dateCol !== -1 && startCol !== -1 && endCol !== -1) { startRow = r + 1; break; }
    }
    if (dateCol === -1) dateCol = 1;
    if (startCol === -1) startCol = 2;
    if (endCol === -1) endCol = 3;
    const result = [];
    for (let r = startRow; r < rawRows.length; r++) {
        const row = rawRows[r] || [];
        const rowText = row.join(" ").toLowerCase();
        if (rowText.includes("итого") || rowText.includes("всего") || rowText.includes("total")) continue;
        const dObj = parseDateCell(row[dateCol]);
        const sObj = parseTimeCell(row[startCol]);
        const eObj = parseTimeCell(row[endCol]);
        if (!dObj || !sObj || !eObj) continue;
        const startTs = new Date(dObj.y, dObj.m, dObj.d, sObj.h, sObj.m, sObj.s).getTime();
        let endTs = new Date(dObj.y, dObj.m, dObj.d, eObj.h, eObj.m, eObj.s).getTime();
        if (endTs <= startTs) endTs += 86400000;
        result.push({ id: startTs + Math.floor(Math.random() * 10000), start: startTs, end: endTs, type: "work" });
    }
    return result;
}

function handleFileImport(file) {
    if (!file) return;
    const isJson = file.name.toLowerCase().endsWith(".json");
    const reader = new FileReader();
    if (isJson) {
        reader.onload = e => {
            try {
                const parsed = JSON.parse(e.target.result);
                const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.log) ? parsed.log : []);
                const valid = list.filter(x => x && x.start && x.end !== undefined).map(x => ({
                    id: x.id || (x.start + Math.floor(Math.random() * 10000)),
                    start: +x.start,
                    end: +x.end,
                    type: x.type || "work"
                }));
                if (parsed && parsed.settings) {
                    const s = parsed.settings;
                    settings = {
                        dailyNorm: parseFloat(s.dailyNorm) > 0 ? parseFloat(s.dailyNorm) : DEFAULT_SETTINGS.dailyNorm,
                        monthlyNorm: parseFloat(s.monthlyNorm) > 0 ? parseFloat(s.monthlyNorm) : DEFAULT_SETTINGS.monthlyNorm
                    };
                    saveSettings();
                }
                showImportModal(file.name, valid);
            } catch (err) { alert("Ошибка чтения JSON: " + err.message); }
        };
        reader.readAsText(file);
    } else {
        reader.onload = e => {
            try {
                if (typeof XLSX === "undefined") { alert("Модуль Excel не загружен"); return; }
                const data = new Uint8Array(e.target.result);
                const wb = XLSX.read(data, { type: "array" });
                const sheet = wb.Sheets[wb.SheetNames[0]];
                const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                const valid = parseExcelRows(rawRows);
                showImportModal(file.name, valid);
            } catch (err) { alert("Ошибка чтения Excel: " + err.message); }
        };
        reader.readAsArrayBuffer(file);
    }
}

function showImportModal(fileName, records) {
    if (!records.length) {
        alert("В файле «" + fileName + "» не найдено записей. Проверьте столбцы «Число», «Начало», «Конец».");
        return;
    }
    pendingImport = records.sort((a, b) => a.start - b.start);
    const totalMs = pendingImport.reduce((acc, r) => acc + (r.end - r.start), 0);
    const firstD = dt(pendingImport[0].start), lastD = dt(pendingImport[pendingImport.length - 1].start);
    $("import-summary").innerHTML =
        `<b>Файл:</b> ${fileName}<br>` +
        `<b>Найдено смен:</b> ${pendingImport.length}<br>` +
        `<b>Период:</b> ${firstD} — ${lastD}<br>` +
        `<b>Суммарно:</b> ${dur(totalMs)}<br>` +
        `<span style="color:var(--mute)">Текущих записей: ${log.length}</span>`;
    $("import-modal").hidden = false;
    buzz();
}

/* ============================== AUTOBACKUP ============================== */
async function tryAutoBackup() {
    if (!window.showDirectoryPicker) return;
    const last = +localStorage.getItem(KEY_BACKUP) || 0;
    const week = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - last < week) return;
    if (!log.length) return;

    const ok = confirm("Прошла неделя с последнего бэкапа. Сохранить резервную копию в папку?");
    if (!ok) { localStorage.setItem(KEY_BACKUP, String(Date.now())); return; }
    try {
        const dir = await window.showDirectoryPicker({ mode: "readwrite" });
        const name = "uchet-vremeni-" + new Date().toISOString().slice(0, 10) + ".json";
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify({ version: 1, exportedAt: Date.now(), settings, log }, null, 2));
        await w.close();
        localStorage.setItem(KEY_BACKUP, String(Date.now()));
        alert("Бэкап сохранён: " + name);
    } catch (e) {}
}

/* ============================== EVENTS ============================== */
$("toggle").onclick = () => {
    buzz();
    if (startTs === null) {
        const v = $("st").value;
        let t = Date.now();
        if (v) {
            const d = new Date();
            d.setHours(+v.slice(0, 2), +v.slice(3, 5), 0, 0);
            if (d.getTime() > t) { alert("Время начала не может быть позже текущего"); return; }
            t = d.getTime();
        }
        startTs = t; $("st").value = "";
    } else {
        const end = Date.now();
        log.push({ id: end + Math.floor(Math.random() * 10000), start: startTs, end, type: "work" });
        startTs = null;
    }
    save(); render(); loop();
};

$("st").onchange = () => {
    const v = $("st").value;
    if (startTs === null) { render(); return; }
    if (!v) { render(); return; }
    const d = new Date(startTs);
    d.setHours(+v.slice(0, 2), +v.slice(3, 5), 0, 0);
    if (d.getTime() > Date.now()) { alert("Время начала не может быть позже текущего"); render(); return; }
    startTs = d.getTime(); save(); render(); loop();
};

$("clr").onclick = () => { $("st").value = ""; render(); };
$("n-t").onclick = () => tab("t");
$("n-h").onclick = () => tab("h");
$("n-m").onclick = () => {
    if (!$("md").value) { const n = new Date(); $("md").value = dateInputValue(n); }
    tab("m"); preview();
};

["md", "ms", "me"].forEach(i => {
    if ($(i))$(i).oninput = preview;
});
if ($("m-type")) $("m-type").onchange = preview;

$("add").onclick = () => {
    const r = manual(); if (!r) return;
    log.push({ id: r.id, start: r.start, end: r.end, type: r.type });
    log.sort((x, y) => x.start - y.start);
    $("ms").value = ""; $("me").value = "";
    save(); render(); preview(); tab("h"); buzz();
};

$("clear").onclick = () => {
    if (confirm("Удалить все записи без возможности отмены?")) {
        log = []; save(); render();
    }
};

document.querySelectorAll(".filters .chip").forEach(b => {
    b.onclick = () => applyChip(b.dataset.range);
});

$("flt-from").onchange = $("flt-to").onchange = () => {
    const f = $("flt-from").value, t = $("flt-to").value;
    if (!f || !t) { applyChip("all"); return; }

    const [y1, m1, d1] = f.split("-").map(Number);
    const [y2, m2, d2] = t.split("-").map(Number);

    filter = {
        kind: "custom",
        from: new Date(y1, m1 - 1, d1, 0, 0, 0, 0).getTime(),
        to: new Date(y2, m2 - 1, d2, 23, 59, 59, 999).getTime()
    };
    document.querySelectorAll(".filters .chip").forEach(b => b.classList.remove("on"));
    render();
};

$("btn-settings").onclick = () => {
    $("cfg-daily").value = settings.dailyNorm;
    $("cfg-monthly").value = settings.monthlyNorm;
    $("settings-modal").hidden = false;
};
$("settings-close").onclick = $("settings-cancel").onclick = () => { $("settings-modal").hidden = true; };
$("settings-save").onclick = () => {
    const d = parseFloat($("cfg-daily").value);
    const m = parseFloat($("cfg-monthly").value);
    if (!(d > 0 && d <= 24)) { alert("Норма дня должна быть 0–24 ч"); return; }
    if (!(m > 0 && m <= 1000)) { alert("Норма месяца должна быть 0–1000 ч"); return; }
    settings.dailyNorm = d;
    settings.monthlyNorm = m;
    saveSettings();
    $("settings-modal").hidden = true;
    render();
};

$("edit-close").onclick = $("edit-cancel").onclick = () => { $("edit-modal").hidden = true; };
$("edit-save").onclick = saveEdit;

$("btn-export").onclick = openExportModal;
$("export-close").onclick = $("export-cancel").onclick = closeExportModal;
document.querySelectorAll('input[name="exp-range"]').forEach(r => {
    r.onchange = () => {
        const v = document.querySelector('input[name="exp-range"]:checked').value;
        $("exp-month-wrap").hidden = v !== "month";
    };
});
$("export-xlsx-btn").onclick = exportXlsx;
$("export-json-btn").onclick = exportJson;
$("export-csv-btn").onclick = exportCsv;

$("import-close").onclick = $("import-cancel").onclick = () => { $("import-modal").hidden = true; pendingImport = []; };
$("import-apply").onclick = () => {
    if (!pendingImport || !pendingImport.length) return;
    const mode = document.querySelector('input[name="import-mode"]:checked')?.value || "merge";
    let count = 0;
    if (mode === "replace") { log = pendingImport.slice(); count = log.length; }
    else {
        const existing = new Set(log.map(r => r.start));
        const toAdd = pendingImport.filter(r => !existing.has(r.start));
        log = log.concat(toAdd).sort((a, b) => a.start - b.start);
        count = toAdd.length;
    }
    save(); render();
    $("import-modal").hidden = true; buzz();
    alert(`Импортировано смен: ${count} (всего: ${log.length})`);
    pendingImport = [];
};

document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });

/* ============================== INIT ============================== */
loadSettings();
load();
render();
loop();
setSync("Хранится на телефоне");
applyChip("all");
initSync();
setTimeout(tryAutoBackup, 2000);