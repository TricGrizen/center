/* app.js — 经纪中心 · 平台 v1 · 数据 / 状态 / DOM 填充层
 * 工务施工件，依 docs/spec-platform-v1.md。
 *
 * DOM 纪律（司辰军规）：只 cloneNode 司辰预置的 <template>，只改 textContent / dataset /
 * CSS 变量 / 预定义 class / hidden；不拼 innerHTML、不写行内 style。
 * 全站仅三处例外，均为规格明授：
 *   ① #segTip 的 style.left/top 与 style.display（定位与显隐）
 *   ② #pcReport 的 innerHTML —— 内容出自 core.renderMd（先转义、后白名单，无属性）
 *   ③ #dotLive 的 title（规格要求「title 写明」）
 * PAT 只从 localStorage 读，绝不落任何文件、任何仓。
 */
import * as C from './core.mjs';

const OWNER = 'TricGrizen';
const REPO = 'agent-center';
const API = 'https://api.github.com';
const LS_PAT = 'jjzx_pat';
const LS_POLL = 'jjzx_poll';
const LS_CACHE = 'jjzx_cache_v1';
const FRESH_MS = 90 * 1000;          // 最近一次成功轮询在此以内 → live
const BACKOFF = [30, 60, 120];       // 失败退避（秒）
const TOP_APPS = 12;
const FEED_MAX = 30;
const TAG_MIN_HP = 3.5;              // 段高不足此百分比则不留文案
const PC_LOOKBACK = 7;               // PC 日报自昨日起回找天数

const BEACON_CN = {
  'charge-on': '充电起', 'charge-off': '充电止',
  'sleep-on': '睡眠起', 'sleep-off': '睡眠止', 'alarm-stop': '闹钟停',
};
const BEACON_MARK = {
  'charge-on': ['charge', '充'], 'charge-off': ['charge', '充'],
  'sleep-on': ['sleep', '眠'], 'sleep-off': ['sleep', '眠'],
  'alarm-stop': ['alarm', '铃'],
};

/* ---------------------------------------------------------------- 取件 */

const $ = (id) => document.getElementById(id);
const el = {
  mastDay: $('mastDay'), mastShichen: $('mastShichen'), dot: $('dotLive'),
  nowList: $('nowList'), nowEmpty: $('nowEmpty'), nowAge: $('nowAge'),
  todaySum: $('todaySum'), bars: $('bars'), barsEmpty: $('barsEmpty'),
  todayCount: $('todayCount'), todayBeacons: $('todayBeacons'), todayDevices: $('todayDevices'),
  segLayer: $('segLayer'), beaconLayer: $('beaconLayer'), arrowNow: $('arrowNow'), segTip: $('segTip'),
  feedList: $('feedList'), feedEmpty: $('feedEmpty'),
  pcMeta: $('pcMeta'), pcReport: $('pcReport'), secPc: $('secPc'), secSet: $('secSet'),
  patInput: $('patInput'), patSave: $('patSave'), pollSel: $('pollSel'), cacheClear: $('cacheClear'),
  quality: $('quality'),
};
const tpl = {
  now: $('tpl-now'), bar: $('tpl-bar'), feed: $('tpl-feed'),
  seg: $('tpl-seg'), beacon: $('tpl-beacon'),
};
const clone = (t) => t.content.firstElementChild.cloneNode(true);
const pct = (n) => Math.round((Number(n) || 0) * 100) / 100;   // CSS 变量留两位，免浮点长尾

/* ---------------------------------------------------------------- 状态 */

const S = {
  pat: '',
  evs: new Map(),          // 事件键 → 事件（天然去重）
  cursor: new Map(),       // 目录 → 已收最大文件名（字典序游标，仅存内存）
  seen: new Map(),         // 目录 → 已取过的文件名集（护栏，见 pullDir 注）
  etag: new Map(),         // 目录 → ETag
  onePage: new Map(),      // 目录 → 上次是否单页（多页时不敢用条件请求）
  pollSec: 30,
  fails: 0,
  lastOk: 0,
  lastErr: '',
  emptyFiles: 0,
  badLines: 0,
  pcDay: null,
  pcCheckedFor: null,      // 已为哪个北京日查过 PC 日报（每日一查）
  pcChecking: false,
  busy: false,
  timer: null,
  minuteMark: '',
};

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 无痕模式：不缓存亦可 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
};

/* ---------------------------------------------------------------- 网络 */

function b64utf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

async function api(path, opt = {}) {
  const headers = {
    Accept: opt.raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: 'Bearer ' + S.pat,
  };
  const tag = opt.etagKey && S.etag.get(opt.etagKey);
  if (tag) headers['If-None-Match'] = tag;
  const res = await fetch(API + path, { headers, cache: 'no-store' });
  if (res.status === 304) return { status: 304 };
  if (res.status === 404) return { status: 404 };
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const etag = res.headers.get('ETag') || '';
  if (opt.raw) return { status: res.status, data: await res.text(), etag };
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data, etag };
}

/** 列目录：返回条目数组；304（未变）返回 null；404（尚无此目录）返回 []。 */
async function listDir(path) {
  const out = [];
  let page = 1, pages = 1;
  for (;;) {
    const url = `/repos/${OWNER}/${REPO}/contents/${path}?per_page=100&page=${page}`;
    const useEtag = page === 1 && S.onePage.get(path) === true;
    const r = await api(url, { etagKey: useEtag ? path : null });
    if (r.status === 304) return null;
    if (r.status === 404) { S.onePage.set(path, true); return []; }
    if (page === 1 && r.etag) S.etag.set(path, r.etag);
    const arr = Array.isArray(r.data) ? r.data : [];
    out.push(...arr);
    pages = page;
    if (arr.length < 100 || page >= 20) break;
    page++;
  }
  S.onePage.set(path, pages === 1);
  return out;
}

async function fetchText(path) {
  const r = await api(`/repos/${OWNER}/${REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, { raw: true });
  if (r.status === 404) return null;
  if (typeof r.data === 'string') return r.data;
  if (r.data && r.data.content) return b64utf8(r.data.content);   // 万一 raw 媒体类型未生效
  return null;
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/* ---------------------------------------------------------------- 收账 */

function addEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (!ev.ts || !Number.isFinite(C.parseTs(ev.ts))) return false;
  const k = C.eventKey(ev);
  if (S.evs.has(k)) return false;                                  // 按 id 去重
  S.evs.set(k, ev);
  return true;
}

function ingestJson(text) {
  if (text == null || String(text).trim() === '') { S.emptyFiles++; return; }
  let obj;
  try { obj = JSON.parse(text); } catch { S.badLines++; return; }
  if (Array.isArray(obj)) { for (const o of obj) addEvent(o); return; }
  addEvent(obj);
}

function ingestJsonl(text) {
  if (text == null || String(text).trim() === '') { S.emptyFiles++; return; }
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { addEvent(JSON.parse(s)); } catch { S.badLines++; }
  }
}

/** 今日与昨日两个 yyyyMMdd 目录（按北京自然日取，覆盖设备时差）。 */
function watchDirs() {
  const now = Date.now();
  const p = C.bjParts(now);
  const today = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  const q = C.bjParts(now - C.DAY_MS);
  const yest = `${q.y}-${String(q.m).padStart(2, '0')}-${String(q.d).padStart(2, '0')}`;
  return [C.ymd(today), C.ymd(yest)];
}

/**
 * 取一目录的新增文件。
 * 游标依规格为「文件名字典序」；另加一道护栏：名次在游标之下、但从未取过的文件也要取。
 * 因两台设备时区不同而写入同一 yyyyMMdd 目录时，后到的事件文件名可能反而更小
 * （如 -0400 的 19:15 落在 +0800 的 23:18 之后），纯最大值游标会把它永久漏掉。
 * 护栏只会多取、不会少取，且首轮之后无额外请求。
 */
async function pullDir(path, isJsonl) {
  const entries = await listDir(path);
  if (entries === null) return;                                    // 304：无变化
  const re = isJsonl ? /\.jsonl$/i : /\.json$/i;
  const names = entries.filter((e) => e && e.type === 'file' && re.test(e.name))
    .map((e) => e.name).sort();
  if (!names.length) return;
  let seen = S.seen.get(path);
  if (!seen) { seen = new Set(); S.seen.set(path, seen); }
  const cur = S.cursor.get(path) || '';
  const fresh = names.filter((n) => n > cur || !seen.has(n));
  if (!fresh.length) return;
  const got = await mapPool(fresh, 6, async (n) => [n, await fetchText(`${path}/${n}`)]);
  for (const [n, t] of got) {                                      // 取回成功才记账，失败则下轮重来
    (isJsonl ? ingestJsonl : ingestJson)(t);
    seen.add(n);
    if (n > (S.cursor.get(path) || '')) S.cursor.set(path, n);
  }
}

async function poll() {
  for (const d of watchDirs()) await pullDir(`ev/raw/${d}`, false);
  await pullDir('ev/batch', true);
}

async function checkPc() {
  const today = C.beijingDay(Date.now());
  S.pcCheckedFor = today;
  for (let i = 1; i <= PC_LOOKBACK; i++) {
    const day = C.shiftDay(today, -i);
    let text = null;
    try { text = await fetchText(`pc/reports/${day}.md`); } catch { return; }
    if (text != null && String(text).trim() !== '') {
      S.pcDay = day;
      el.pcMeta.textContent = `已到 ${day} 份`;
      el.pcReport.innerHTML = C.renderMd(text);                     // 明授例外：先转义后白名单
      el.pcReport.hidden = false;
      return;
    }
  }
}

function schedule() {
  clearTimeout(S.timer);
  const wait = S.fails > 0
    ? Math.max(S.pollSec, BACKOFF[Math.min(S.fails - 1, BACKOFF.length - 1)])
    : S.pollSec;
  S.timer = setTimeout(runPoll, wait * 1000);
}

async function runPoll() {
  if (!S.pat || S.busy) { renderDot(); return; }
  S.busy = true;
  try {
    await poll();
    S.fails = 0;
    S.lastErr = '';
    S.lastOk = Date.now();
    saveCache();
    render();
    // PC 日报：每个北京日查一轮（自昨日回找 7 天，取最新一份）
    if (!S.pcChecking && S.pcCheckedFor !== C.beijingDay(Date.now())) {
      S.pcChecking = true;
      checkPc().catch(() => { S.pcCheckedFor = null; }).finally(() => { S.pcChecking = false; });
    }
  } catch (e) {
    S.fails++;
    S.lastErr = (e && e.message) || '取数失败';
    renderDot();
  } finally {
    S.busy = false;
    schedule();
  }
}

/* ---------------------------------------------------------------- 缓存 */

function saveCache() {
  const day = C.beijingDay(Date.now());
  const win = C.dayWindow(day);
  const evs = [...S.evs.values()].filter((e) => {
    const t = C.parseTs(e.ts);
    return t >= win.start && t < win.end;
  });
  ls.set(LS_CACHE, JSON.stringify({ day, evs: evs.slice(-2000) }));
}

function loadCache() {
  const raw = ls.get(LS_CACHE);
  if (!raw) return;
  try {
    const o = JSON.parse(raw);
    if (!o || o.day !== C.beijingDay(Date.now())) { ls.del(LS_CACHE); return; }
    for (const ev of o.evs || []) addEvent(ev);
  } catch { ls.del(LS_CACHE); }
}

/* ---------------------------------------------------------------- 算账 */

function compute() {
  const now = Date.now();
  const day = C.beijingDay(now);
  const win = C.dayWindow(day);
  const events = [...S.evs.values()];
  const pr = C.pairSegments(events, { now });
  const agg = C.aggToday(pr.segments, win);
  const beacons = events.filter(C.isBeacon).map((e) => ({ ev: e, t: C.parseTs(e.ts) }))
    .filter((b) => b.t >= win.start && b.t < win.end)
    .sort((a, b) => a.t - b.t);
  const feed = events.map((e) => ({ ev: e, t: C.parseTs(e.ts) }))
    .sort((a, b) => b.t - a.t).slice(0, FEED_MAX);
  const latest = events.reduce((mx, e) => Math.max(mx, C.parseTs(e.ts)), 0);
  return { now, day, win, events, pr, agg, beacons, feed, latest };
}

/* ---------------------------------------------------------------- 填充 */

function renderMast(v) {
  const w = C.dayWindow(v.day);
  el.mastDay.textContent = `${v.day} ${C.weekdayCN(w.start + 12 * 3600 * 1000)} · 北京`;
  el.mastShichen.textContent = ` · ${C.shichenOf(C.bjParts(v.now).H)}时`;
}

function renderDot() {
  const now = Date.now();
  let cls = 'stale';
  let title;
  if (!S.pat) {
    title = '未贴 PAT：账册未开（见「设置」）';
  } else if (S.fails > 0) {
    cls = 'cut';
    title = `断流：连续 ${S.fails} 次取数失败（${S.lastErr}），退避重试中`;
  } else if (S.lastOk && now - S.lastOk < FRESH_MS) {
    cls = 'live';
    title = `实时：${Math.max(0, Math.round((now - S.lastOk) / 1000))} 秒前收讫`;
  } else if (S.lastOk) {
    title = `迟滞：上次收讫在 ${C.fmtSince(now - S.lastOk)}前`;
  } else {
    title = '尚未收讫：首轮取数中';
  }
  el.dot.classList.remove('live', 'stale', 'cut');
  el.dot.classList.add(cls);
  el.dot.title = title;
}

function renderNow(v) {
  el.nowList.replaceChildren();
  for (const seg of v.agg.live) {
    const row = clone(tpl.now);
    row.querySelector('.now-app').textContent = seg.app;
    row.querySelector('.now-dev').textContent = C.devKind(seg.dev);
    row.querySelector('.now-since').textContent =
      `已 ${C.fmtSince(v.now - seg.start)} · ${C.fmtHM(seg.start)} 起`;
    el.nowList.appendChild(row);
  }
  el.nowEmpty.hidden = v.agg.live.length > 0;
  if (!v.latest) { el.nowAge.textContent = ''; return; }
  const gap = v.now - v.latest;
  el.nowAge.textContent = gap < 60000 ? '刚刚' : `${C.fmtSince(gap)}前`;
}

function renderToday(v) {
  el.todaySum.textContent = C.fmtDur(v.agg.totalSec);
  el.bars.replaceChildren();
  const top = v.agg.apps.slice(0, TOP_APPS);
  const max = top.length ? top[0].sec : 0;
  top.forEach((a, i) => {
    const row = clone(tpl.bar);
    if (i === 0) row.classList.add('hot');
    row.style.setProperty('--w', pct(max > 0 ? (a.sec / max) * 100 : 0));
    row.querySelector('.bar-label').textContent = a.app;
    row.querySelector('.bar-val').textContent = C.fmtDur(a.sec);
    el.bars.appendChild(row);
  });
  el.barsEmpty.hidden = top.length > 0;
  el.todayCount.textContent = String(v.agg.count);
  el.todayBeacons.textContent = String(v.beacons.length);

  const kinds = [];
  for (const d of v.agg.devices) { const k = C.devKind(d); if (!kinds.includes(k)) kinds.push(k); }
  for (const b of v.beacons) { const k = C.devKind(b.ev.dev); if (!kinds.includes(k)) kinds.push(k); }
  kinds.sort((a, b) => (a === 'iphone' ? 0 : 1) - (b === 'iphone' ? 0 : 1));
  el.todayDevices.textContent = kinds.join(' / ');
}

function renderLouke(v) {
  const span = v.win.end - v.win.start;
  el.segLayer.replaceChildren();
  for (const seg of v.pr.segments) {
    const s = Math.max(seg.start, v.win.start);
    const e = Math.min(seg.end, v.win.end);
    if (!(e > s)) continue;
    const node = clone(tpl.seg);
    const hp = ((e - s) / span) * 100;
    node.style.setProperty('--p', pct(((s - v.win.start) / span) * 100));
    node.style.setProperty('--hp', pct(hp));
    if (seg.live) node.classList.add('live');
    if (seg.suspect) node.classList.add('suspect');
    node.dataset.tip = `${seg.app} · ${C.fmtHM(seg.start)}–${C.fmtHM(seg.end)} · ${C.fmtDur(seg.sec)}`;
    node.querySelector('.seg-tag').textContent = hp >= TAG_MIN_HP ? seg.app : '';
    el.segLayer.appendChild(node);
  }
  el.beaconLayer.replaceChildren();
  for (const b of v.beacons) {
    const mark = BEACON_MARK[String(b.ev.event)];
    if (!mark) continue;
    const node = clone(tpl.beacon);
    node.style.setProperty('--p', pct(C.pctIn(b.t, v.win)));
    node.classList.add(mark[0]);
    node.textContent = mark[1];
    node.dataset.ev = String(b.ev.event);
    el.beaconLayer.appendChild(node);
  }
  renderArrow(v);
}

function renderArrow(v) {
  const inside = v.now >= v.win.start && v.now <= v.win.end;
  el.arrowNow.hidden = !inside;
  if (inside) el.arrowNow.style.setProperty('--p', pct(C.pctIn(v.now, v.win)));
}

function renderFeed(v) {
  el.feedList.replaceChildren();
  for (const f of v.feed) {
    const kind = String(f.ev.event);
    const li = clone(tpl.feed);
    li.querySelector('.f-t').textContent = C.fmtHMS(f.t);
    li.querySelector('.f-app').textContent = String(f.ev.app ?? '');
    const evCell = li.querySelector('.f-ev');
    if (kind === 'open') { evCell.textContent = '开'; evCell.classList.add('open'); }
    else if (kind === 'close') { evCell.textContent = '关'; }
    else { evCell.textContent = BEACON_CN[kind] || kind; evCell.classList.add('beacon'); }
    li.querySelector('.f-dev').textContent = String(f.ev.dev ?? '');
    el.feedList.appendChild(li);
  }
  el.feedEmpty.hidden = v.feed.length > 0;
}

function renderQuality(v) {
  el.quality.textContent =
    `数据质量：孤关 ${v.pr.orphanClose} · 疑漏 ${v.pr.suspect} · 空文 ${S.emptyFiles + S.badLines}`;
}

function render() {
  const v = compute();
  renderMast(v);
  renderDot();
  renderNow(v);
  renderToday(v);
  renderLouke(v);
  renderFeed(v);
  renderQuality(v);
  S.minuteMark = v.day + ' ' + C.fmtHM(v.now);
}

/** 秒表：每 10 秒刷新与时刻相关者；跨分钟时连今日账与漏刻一并重算。 */
function tick() {
  const v = compute();
  const mark = v.day + ' ' + C.fmtHM(v.now);
  renderMast(v);
  renderDot();
  renderNow(v);
  renderArrow(v);
  if (mark !== S.minuteMark) {
    S.minuteMark = mark;
    renderToday(v);
    renderLouke(v);
    renderQuality(v);
  }
}

/* ---------------------------------------------------------------- 交互 */

function showTip(node) {
  const text = node.dataset.tip || '';
  if (!text) return;
  el.segTip.textContent = text;
  el.segTip.style.display = 'block';                     // 明授例外：显隐用 display
  const r = node.getBoundingClientRect();
  const w = el.segTip.offsetWidth;
  const h = el.segTip.offsetHeight;
  let top = r.top - h - 6;
  if (top < 6) top = Math.min(r.bottom + 6, window.innerHeight - h - 6);
  let left = r.left + 10;
  left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
  el.segTip.style.left = left + 'px';                    // 明授例外：定位
  el.segTip.style.top = Math.max(6, top) + 'px';
}
function hideTip() { el.segTip.style.display = 'none'; }

function wire() {
  el.segLayer.addEventListener('pointerover', (e) => {
    const seg = e.target.closest('.seg');
    if (seg) showTip(seg);
  });
  el.segLayer.addEventListener('pointerout', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    if (e.relatedTarget && seg.contains(e.relatedTarget)) return;   // 段内挪动不闪
    hideTip();
  });
  el.segLayer.addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (seg) { e.stopPropagation(); showTip(seg); }
  });
  document.addEventListener('click', hideTip);
  window.addEventListener('scroll', hideTip, { passive: true });
  window.addEventListener('resize', hideTip);

  el.patSave.addEventListener('click', () => {
    const val = el.patInput.value.trim();
    if (val) { ls.set(LS_PAT, val); S.pat = val; }
    else { ls.del(LS_PAT); S.pat = ''; }
    S.fails = 0;
    S.lastErr = '';
    S.cursor.clear();
    S.seen.clear();
    S.etag.clear();
    S.onePage.clear();
    renderDot();
    if (S.pat) runPoll();
  });

  el.pollSel.addEventListener('change', () => {
    S.pollSec = Number(el.pollSel.value) || 30;
    ls.set(LS_POLL, String(S.pollSec));
    schedule();
  });

  el.cacheClear.addEventListener('click', () => {
    ls.del(LS_CACHE);
    S.evs.clear();
    S.cursor.clear();
    S.seen.clear();
    S.etag.clear();
    S.onePage.clear();
    S.emptyFiles = 0;
    S.badLines = 0;
    S.fails = 0;
    S.pcDay = null;
    S.pcCheckedFor = null;
    render();
    if (S.pat) runPoll();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.pat && Date.now() - S.lastOk > S.pollSec * 1000) runPoll();
  });
}

/* ---------------------------------------------------------------- 起帆 */

function boot() {
  S.pat = ls.get(LS_PAT) || '';
  el.patInput.value = S.pat;
  const saved = ls.get(LS_POLL);
  if (saved && [...el.pollSel.options].some((o) => o.value === saved)) el.pollSel.value = saved;
  S.pollSec = Number(el.pollSel.value) || 30;

  loadCache();
  wire();
  render();
  setInterval(tick, 10 * 1000);

  if (!S.pat) { el.secSet.open = true; renderDot(); return; }   // 无 PAT：开抽屉，不报错
  runPoll();
}

boot();
