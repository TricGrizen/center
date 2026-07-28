/* logic.test.mjs — core.mjs 自测（node 原生断言，无第三方依赖）
 * 跑法：node tests/logic.test.mjs   （在 center 仓根目录）
 */
import assert from 'node:assert/strict';
import * as C from '../js/core.mjs';

let pass = 0;
const fails = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fails.push([name, e]); console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const T = (s) => C.parseTs(s);
const shape = (seg) => [seg.app, seg.dev, C.fmtHM(seg.start), C.fmtHM(seg.end), seg.suspect, seg.live];

console.log('— core.mjs —');

/* ---------------------------------------------------------- 时刻解析与归日 */

test('parseTs：+0800 无冒号偏移与 +08:00 等价', () => {
  assert.equal(T('2026-07-24T21:00:03.123+0800'), T('2026-07-24T21:00:03.123+08:00'));
  assert.equal(T('2026-07-24T21:00:03.123+0800'), Date.UTC(2026, 6, 24, 13, 0, 3, 123));
});

test('parseTs：Z / 缺偏移按 UTC / 缺毫秒', () => {
  assert.equal(T('2026-07-24T13:00:03Z'), Date.UTC(2026, 6, 24, 13, 0, 3, 0));
  assert.equal(T('2026-07-24T13:00:03'), Date.UTC(2026, 6, 24, 13, 0, 3, 0));
  assert.equal(T('2026-07-24T13:00'), Date.UTC(2026, 6, 24, 13, 0, 0, 0));
  assert.ok(Number.isNaN(T('不是时间')));
});

test('归日：北京 04:00 为界', () => {
  assert.equal(C.beijingDay('2026-07-24T03:59:59.999+0800'), '2026-07-23');
  assert.equal(C.beijingDay('2026-07-24T04:00:00.000+0800'), '2026-07-24');
  assert.equal(C.beijingDay('2026-07-24T23:59:59+0800'), '2026-07-24');
  assert.equal(C.beijingDay('2026-07-25T00:30:00+0800'), '2026-07-24');
});

test('归日：-0400（美东）偏移换北京', () => {
  // 美东 07-24 20:00 = UTC 07-25 00:00 = 北京 07-25 08:00 → 归 2026-07-25
  assert.equal(C.beijingDay('2026-07-24T20:00:00.000-0400'), '2026-07-25');
  // 美东 07-24 13:00 = UTC 17:00 = 北京 07-25 01:00（<04:00）→ 仍归 2026-07-24
  assert.equal(C.beijingDay('2026-07-24T13:00:00.000-0400'), '2026-07-24');
  // 美东 07-24 16:30 = 北京 07-25 04:30 → 归 2026-07-25（刚过日界）
  assert.equal(C.beijingDay('2026-07-24T16:30:00.000-0400'), '2026-07-25');
  // 同一时刻两种偏移写法，归日必须一致
  assert.equal(C.beijingDay('2026-07-24T20:00:00-0400'), C.beijingDay('2026-07-25T08:00:00+0800'));
});

test('dayWindow：04:00 → 次日 04:00，长 24h', () => {
  const w = C.dayWindow('2026-07-24');
  assert.equal(w.start, T('2026-07-24T04:00:00+0800'));
  assert.equal(w.end, T('2026-07-25T04:00:00+0800'));
  assert.equal(w.end - w.start, C.DAY_MS);
  assert.equal(C.beijingDay(w.start), '2026-07-24');
  assert.equal(C.beijingDay(w.end - 1), '2026-07-24');
  assert.equal(C.beijingDay(w.end), '2026-07-25');
  assert.equal(C.shiftDay('2026-07-01', -1), '2026-06-30');
  assert.equal(C.shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(C.ymd('2026-07-24'), '20260724');
});

/* ---------------------------------------------------------- 时辰 */

test('shichenOf：边界（23 点＝子，1 点整＝丑）', () => {
  assert.equal(C.shichenOf(23), '子');
  assert.equal(C.shichenOf(0), '子');
  assert.equal(C.shichenOf(1), '丑');
  assert.equal(C.shichenOf(2), '丑');
  assert.equal(C.shichenOf(3), '寅');
  assert.equal(C.shichenOf(4), '寅');
  assert.equal(C.shichenOf(5), '卯');
  assert.equal(C.shichenOf(7), '辰');
  assert.equal(C.shichenOf(9), '巳');
  assert.equal(C.shichenOf(11), '午');
  assert.equal(C.shichenOf(13), '未');
  assert.equal(C.shichenOf(15), '申');
  assert.equal(C.shichenOf(17), '酉');
  assert.equal(C.shichenOf(18), '酉');
  assert.equal(C.shichenOf(19), '戌');
  assert.equal(C.shichenOf(21), '亥');
  assert.equal(C.shichenOf(22), '亥');
  assert.equal(C.shichenOf(''), '');   // 非数字
});

/* ---------------------------------------------------------- 去重 */

test('dedupe：按 id，先到先得，保序', () => {
  const evs = [
    { ts: '2026-07-24T09:00:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: 'A' },
    { ts: '2026-07-24T09:05:00+0800', dev: 'iPhone17,2', app: '微信', event: 'close', id: 'B' },
    { ts: '2026-07-24T09:00:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: 'A' }, // batch 重传
    { ts: '2026-07-24T09:09:00+0800', dev: 'iPad14,5', app: 'Safari', event: 'open', id: 'C' },
  ];
  const out = C.dedupe(evs);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.id), ['A', 'B', 'C']);
  assert.equal(C.dedupe([]).length, 0);
});

/* ---------------------------------------------------------- 配对 */

test('pairSegments：乱序输入按 ts 排序后配对', () => {
  const evs = [
    { ts: '2026-07-24T09:31:00+0800', dev: 'iPhone17,2', app: '微信', event: 'close', id: '2' },
    { ts: '2026-07-24T14:52:00+0800', dev: 'iPad14,5', app: 'Safari', event: 'close', id: '4' },
    { ts: '2026-07-24T09:12:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: '1' },
    { ts: '2026-07-24T14:05:00+0800', dev: 'iPad14,5', app: 'Safari', event: 'open', id: '3' },
  ];
  const r = C.pairSegments(evs, { now: T('2026-07-24T20:00:00+0800') });
  assert.equal(r.segments.length, 2);
  assert.deepEqual(shape(r.segments[0]), ['微信', 'iPhone17,2', '09:12', '09:31', false, false]);
  assert.deepEqual(shape(r.segments[1]), ['Safari', 'iPad14,5', '14:05', '14:52', false, false]);
  assert.equal(r.segments[0].sec, 19 * 60);
  assert.equal(r.orphanClose, 0);
  assert.equal(r.suspect, 0);
});

test('pairSegments：设备+app 各自成对，不串轨', () => {
  const evs = [
    { ts: '2026-07-24T09:00:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: '1' },
    { ts: '2026-07-24T09:02:00+0800', dev: 'iPad14,5', app: '微信', event: 'open', id: '2' },
    { ts: '2026-07-24T09:10:00+0800', dev: 'iPad14,5', app: '微信', event: 'close', id: '3' },
    { ts: '2026-07-24T09:20:00+0800', dev: 'iPhone17,2', app: '微信', event: 'close', id: '4' },
  ];
  const r = C.pairSegments(evs, { now: T('2026-07-24T10:00:00+0800') });
  assert.equal(r.segments.length, 2);
  assert.equal(r.doubleOpen, 0);
  assert.equal(r.suspect, 0);
  const byDev = Object.fromEntries(r.segments.map((s) => [s.dev, s.sec]));
  assert.equal(byDev['iPhone17,2'], 20 * 60);
  assert.equal(byDev['iPad14,5'], 8 * 60);
});

test('pairSegments：孤 close 丢弃并计数', () => {
  const evs = [
    { ts: '2026-07-24T16:00:00+0800', dev: 'iPhone17,2', app: '小红书', event: 'close', id: '1' },
    { ts: '2026-07-24T17:00:00+0800', dev: 'iPhone17,2', app: '小红书', event: 'open', id: '2' },
    { ts: '2026-07-24T17:20:00+0800', dev: 'iPhone17,2', app: '小红书', event: 'close', id: '3' },
    { ts: '2026-07-24T18:00:00+0800', dev: 'iPad14,5', app: 'Safari', event: 'close', id: '4' },
  ];
  const r = C.pairSegments(evs, { now: T('2026-07-24T19:00:00+0800') });
  assert.equal(r.orphanClose, 2);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].sec, 20 * 60);
  assert.equal(r.segments[0].suspect, false);
});

test('pairSegments：双 open —— 旧段以新 open 为界闭合并标 suspect', () => {
  const evs = [
    { ts: '2026-07-24T14:05:00+0800', dev: 'iPad14,5', app: 'Safari', event: 'open', id: '1' },
    { ts: '2026-07-24T14:30:00+0800', dev: 'iPad14,5', app: 'Safari', event: 'open', id: '2' },
    { ts: '2026-07-24T14:52:00+0800', dev: 'iPad14,5', app: 'Safari', event: 'close', id: '3' },
  ];
  const r = C.pairSegments(evs, { now: T('2026-07-24T15:00:00+0800') });
  assert.equal(r.doubleOpen, 1);
  assert.equal(r.segments.length, 2);
  assert.deepEqual(shape(r.segments[0]), ['Safari', 'iPad14,5', '14:05', '14:30', true, false]);
  assert.deepEqual(shape(r.segments[1]), ['Safari', 'iPad14,5', '14:30', '14:52', false, false]);
  assert.equal(r.suspect, 1);
  assert.equal(r.orphanClose, 0);
});

test('pairSegments：未闭合 = 进行中段（end=now，live）', () => {
  const now = T('2026-07-24T20:55:00+0800');
  const evs = [
    { ts: '2026-07-24T20:41:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: '1' },
  ];
  const r = C.pairSegments(evs, { now });
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].live, true);
  assert.equal(r.segments[0].suspect, false);
  assert.equal(r.segments[0].end, now);
  assert.equal(r.segments[0].sec, 14 * 60);
});

test('pairSegments：开段 > 6h —— 已闭合者截断标 suspect', () => {
  const evs = [
    { ts: '2026-07-24T08:00:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: '1' },
    { ts: '2026-07-24T20:00:00+0800', dev: 'iPhone17,2', app: '微信', event: 'close', id: '2' },
  ];
  const r = C.pairSegments(evs, { now: T('2026-07-24T21:00:00+0800') });
  assert.equal(r.segments.length, 1);
  assert.deepEqual(shape(r.segments[0]), ['微信', 'iPhone17,2', '08:00', '14:00', true, false]);
  assert.equal(r.segments[0].sec, 6 * 3600);
  assert.equal(r.truncated, 1);
  assert.equal(r.suspect, 1);
});

test('pairSegments：开着不关超 6h —— 截断且不再算进行中', () => {
  const evs = [
    { ts: '2026-07-24T02:00:00+0800', dev: 'iPad14,5', app: 'Safari', event: 'open', id: '1' },
  ];
  const r = C.pairSegments(evs, { now: T('2026-07-24T12:00:00+0800') });
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].live, false);
  assert.equal(r.segments[0].suspect, true);
  assert.equal(r.segments[0].sec, 6 * 3600);
  assert.equal(C.fmtHM(r.segments[0].end), '08:00');
});

test('pairSegments：同刻 close 先于 open（不误判双 open）', () => {
  const evs = [
    { ts: '2026-07-24T09:00:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: '1' },
    { ts: '2026-07-24T09:30:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: '3' },
    { ts: '2026-07-24T09:30:00+0800', dev: 'iPhone17,2', app: '微信', event: 'close', id: '2' },
    { ts: '2026-07-24T09:40:00+0800', dev: 'iPhone17,2', app: '微信', event: 'close', id: '4' },
  ];
  const r = C.pairSegments(evs, { now: T('2026-07-24T10:00:00+0800') });
  assert.equal(r.doubleOpen, 0);
  assert.equal(r.orphanClose, 0);
  assert.equal(r.suspect, 0);
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].sec, 30 * 60);
  assert.equal(r.segments[1].sec, 10 * 60);
});

test('pairSegments：信标与坏 ts 不入段', () => {
  const evs = [
    { ts: '2026-07-24T22:40:00+0800', dev: 'iPhone17,2', app: 'beacon', event: 'charge-on', id: '1' },
    { ts: '坏时间', dev: 'iPhone17,2', app: '微信', event: 'open', id: '2' },
    { ts: '2026-07-24T22:50:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: '3' },
    { ts: '2026-07-24T22:55:00+0800', dev: 'iPhone17,2', app: '微信', event: 'close', id: '4' },
  ];
  const r = C.pairSegments(evs, { now: T('2026-07-24T23:00:00+0800') });
  assert.equal(r.segments.length, 1);
  assert.equal(r.unparsable, 1);
  assert.equal(r.segments[0].sec, 5 * 60);
  assert.equal(C.isBeacon(evs[0]), true);
  assert.equal(C.isBeacon(evs[2]), false);
});

/* ---------------------------------------------------------- 跨日窗口 + 今日账 */

test('跨日窗口：段跨 04:00 日界，两日各计其半', () => {
  const evs = [
    // 北京 07-25 03:30 → 05:30，横跨 04:00 日界
    { ts: '2026-07-25T03:30:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: '1' },
    { ts: '2026-07-25T05:30:00+0800', dev: 'iPhone17,2', app: '微信', event: 'close', id: '2' },
  ];
  const r = C.pairSegments(evs, { now: T('2026-07-25T06:00:00+0800') });
  assert.equal(r.segments.length, 1);
  assert.equal(C.beijingDay(r.segments[0].start), '2026-07-24');   // 起点归昨日
  assert.equal(C.beijingDay(r.segments[0].end), '2026-07-25');     // 终点归今日

  const y = C.aggToday(r.segments, C.dayWindow('2026-07-24'));
  const t = C.aggToday(r.segments, C.dayWindow('2026-07-25'));
  assert.equal(y.totalSec, 30 * 60);
  assert.equal(t.totalSec, 90 * 60);
  assert.equal(y.count, 1);
  assert.equal(t.count, 1);
  const other = C.aggToday(r.segments, C.dayWindow('2026-07-26'));
  assert.equal(other.totalSec, 0);
  assert.equal(other.apps.length, 0);
});

test('aggToday：合计、各 app 秒数/次数降序、进行中、设备', () => {
  const now = T('2026-07-24T21:00:00+0800');
  const evs = [
    { ts: '2026-07-24T09:00:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: '1' },
    { ts: '2026-07-24T09:20:00+0800', dev: 'iPhone17,2', app: '微信', event: 'close', id: '2' },
    { ts: '2026-07-24T10:00:00+0800', dev: 'iPhone17,2', app: '微信', event: 'open', id: '3' },
    { ts: '2026-07-24T10:10:00+0800', dev: 'iPhone17,2', app: '微信', event: 'close', id: '4' },
    { ts: '2026-07-24T11:00:00+0800', dev: 'iPad14,5', app: 'Safari', event: 'open', id: '5' },
    { ts: '2026-07-24T13:00:00+0800', dev: 'iPad14,5', app: 'Safari', event: 'close', id: '6' },
    { ts: '2026-07-24T20:41:00+0800', dev: 'iPhone17,2', app: '小红书', event: 'open', id: '7' },
  ];
  const r = C.pairSegments(evs, { now });
  const a = C.aggToday(r.segments, C.dayWindow('2026-07-24'));
  assert.equal(a.totalSec, (30 + 120 + 19) * 60);
  assert.equal(a.count, 4);
  assert.deepEqual(a.apps.map((x) => [x.app, x.sec, x.count]), [
    ['Safari', 120 * 60, 1],
    ['微信', 30 * 60, 2],
    ['小红书', 19 * 60, 1],
  ]);
  assert.equal(a.live.length, 1);
  assert.equal(a.live[0].app, '小红书');
  assert.deepEqual(a.devices, ['iPhone17,2', 'iPad14,5']);
  assert.deepEqual(a.devices.map(C.devKind), ['iphone', 'ipad']);
  assert.equal(C.fmtDur(a.totalSec), '2h49m');
});

/* ---------------------------------------------------------- 格式化 */

test('fmtDur / fmtSince / pctIn', () => {
  assert.equal(C.fmtDur(0), '0m');
  assert.equal(C.fmtDur(18), '18s');
  assert.equal(C.fmtDur(42 * 60), '42m');
  assert.equal(C.fmtDur(3720), '1h02m');
  assert.equal(C.fmtDur(3 * 3600 + 42 * 60), '3h42m');
  assert.equal(C.fmtSince(14 * 60000), '14 分');
  assert.equal(C.fmtSince(82 * 60000), '1 时 22 分');
  assert.equal(C.fmtSince(120 * 60000), '2 时');
  const w = C.dayWindow('2026-07-24');
  assert.equal(C.pctIn(w.start, w), 0);
  assert.equal(C.pctIn(w.start + C.DAY_MS / 2, w), 50);
  assert.equal(C.pctIn(w.end + 999, w), 100);
  assert.equal(C.fmtHMS(T('2026-07-24T21:00:03.123+0800')), '21:00:03');
  assert.equal(C.weekdayCN(T('2026-07-24T12:00:00+0800')), '周五');
});

/* ---------------------------------------------------------- 迷你 md */

test('renderMd：转义在先，白名单在后（不放行任何原文标签）', () => {
  const html = C.renderMd('# 标题 <script>alert(1)</script>\n\n> 引 "话" & 事\n\n- 甲\n- 乙\n');
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.startsWith('<h1>标题 &lt;script&gt;'));
  assert.ok(html.includes('<blockquote><p>引 &quot;话&quot; &amp; 事</p></blockquote>'));
  assert.ok(html.includes('<ul><li>甲</li><li>乙</li></ul>'));
  assert.equal(/<\w+ [^>]*=/.test(html), false);   // 产出标签一律无属性
});

test('renderMd：表格 / 代码块 / 二级标题 / 普通段落', () => {
  const md = [
    '## 2　总账',
    '',
    '| 指标 | 值 |',
    '|:--|--:|',
    '| 台前净时长 | 1h54m |',
    '',
    '```',
    '04 │ ████ <b>',
    '```',
    '',
    '寻常一行 **不作粗体**',
  ].join('\n');
  const html = C.renderMd(md);
  assert.ok(html.includes('<h2>2　总账</h2>'));
  assert.ok(html.includes('<table><thead><tr><th>指标</th><th>值</th></tr></thead>'));
  assert.ok(html.includes('<tbody><tr><td>台前净时长</td><td>1h54m</td></tr></tbody></table>'));
  assert.ok(html.includes('<pre><code>04 │ ████ &lt;b&gt;</code></pre>'));
  assert.ok(html.includes('<p>寻常一行 **不作粗体**</p>'));   // 行内标记原样，合规格
  assert.equal(C.renderMd(''), '');
});

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项。`);
if (fails.length) {
  for (const [name, e] of fails) console.error('\n[FAIL] ' + name + '\n' + (e && e.stack));
  process.exit(1);
}
