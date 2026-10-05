'use strict';

/*
 * 本轮（列表 BIGINT 主键字符串关联修复）HTTP 冒烟脚本（可重复运行）：
 * 用真实 Express 进程 + HTTP 监听，仅把内存 pg 连接的 bigint 列结果转成字符串，
 * 复现真实 PostgreSQL 驱动（int8 -> string）下列表与详情同口径的行为。
 * 运行：node scripts/smoke-list-realgids.js
 */

process.env.SEED_DEMO = 'false';
process.env.PGHOST = 'memory';

const http = require('http');
const { newDb } = require('pg-mem');
const dbModule = require('../src/db');

const mem = newDb({ autoCreateForeignKeyIndices: true });
const { Pool: MemPool } = mem.adapters.createPg();
const fakePool = new MemPool();

// 模拟真实 pg：bigint 列经驱动默认类型解析后为字符串；其余列保持内存驱动值。
const BIGINT_COLS = new Set([
  'id', 'exhibit_id', 'plan_id', 'created_by', 'approved_by', 'confirmed_by',
  'annulled_by', 'replaced_by_id', 'replaces_measurement_id', 'import_batch_id',
  'hall_id', 'residence_id', 'session_id', 'threshold_id', 'read_by',
  'updated_by', 'measurement_id',
]);
function stringifyBigints(res) {
  if (res && Array.isArray(res.rows)) {
    for (const row of res.rows) {
      for (const col of Object.keys(row)) {
        if (BIGINT_COLS.has(col) && typeof row[col] === 'number') row[col] = String(row[col]);
      }
    }
  }
  return res;
}
const origQuery = fakePool.query.bind(fakePool);
fakePool.query = (...a) => origQuery(...a).then(stringifyBigints);
const origConnect = fakePool.connect.bind(fakePool);
fakePool.connect = (...a) => origConnect(...a).then((client) => {
  const cq = client.query.bind(client);
  client.query = (...qargs) => cq(...qargs).then(stringifyBigints);
  return client;
});

dbModule.pool.connect = (...a) => fakePool.connect(...a);
dbModule.pool.query = (...a) => fakePool.query(...a);

const { createApp } = require('../src/app');
const { initializeDatabase } = require('../src/init');
const config = require('../src/config');

let server;
let base;
const cookies = new Map();

function call(method, urlPath, body, role) {
  const cookie = role ? cookies.get(role) : null;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${urlPath}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: `lqsession=${cookie}` } : {}),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (role && res.headers['set-cookie']) {
            const m = res.headers['set-cookie'][0].match(/lqsession=([a-f0-9]+)/);
            if (m) cookies.set(role, m[1]);
          }
          resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : {} });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await initializeDatabase();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // 登录（保管员 custodian / 布展员 installer）
  let r = await call('POST', '/api/auth/login',
    { username: config.seed.conservatorUsername, password: config.seed.conservatorPassword }, 'c');
  if (r.status !== 200) throw new Error('保管员登录失败');
  r = await call('POST', '/api/auth/login',
    { username: config.seed.installerUsername, password: config.seed.installerPassword }, 'i');
  if (r.status !== 200) throw new Error('布展员登录失败');

  // 登记两件展品
  const ex1 = (await call('POST', '/api/exhibits', { name: '列表联调展品甲' }, 'c')).body.exhibit.id;
  const ex2 = (await call('POST', '/api/exhibits', { name: '列表联调展品乙' }, 'c')).body.exhibit.id;

  // 甲：2025 上限 1000 + 事故 600（阈值 50/80 → low）；2026 只有事故 300（无上限）；2024 仅上限 2000
  await call('POST', `/api/exhibits/${ex1}/limits`, { year: 2025, limitLxh: 1000 }, 'c');
  await call('POST', `/api/exhibits/${ex1}/quota-thresholds`,
    { year: 2025, lowPct: 50, highPct: 80 }, 'c');
  await call('POST', '/api/incidents', {
    exhibitId: ex1,
    startDate: '2025-03-01', startTime: '09:00',
    endDate: '2025-03-01', endTime: '15:00',
    actualLux: 100, reason: '甲 2025 事故 600',
  }, 'c');
  await call('POST', '/api/incidents', {
    exhibitId: ex1,
    startDate: '2026-03-01', startTime: '09:00',
    endDate: '2026-03-01', endTime: '12:00',
    actualLux: 100, reason: '甲 2026 无上限事故 300',
  }, 'c');
  await call('POST', `/api/exhibits/${ex1}/limits`, { year: 2024, limitLxh: 2000 }, 'c');

  // 乙：2025 上限 500 + 事故 450（90% → high）
  await call('POST', `/api/exhibits/${ex2}/limits`, { year: 2025, limitLxh: 500 }, 'c');
  await call('POST', `/api/exhibits/${ex2}/quota-thresholds`,
    { year: 2025, lowPct: 50, highPct: 80 }, 'c');
  await call('POST', '/api/incidents', {
    exhibitId: ex2,
    startDate: '2025-04-01', startTime: '09:00',
    endDate: '2025-04-01', endTime: '13:30',
    actualLux: 100, reason: '乙 2025 事故 450',
  }, 'c');

  const list = (await call('GET', '/api/exhibits', null, 'i')).body.exhibits;
  const c1 = list.find((e) => Number(e.id) === Number(ex1));
  const c2 = list.find((e) => Number(e.id) === Number(ex2));
  const d1 = (await call('GET', `/api/exhibits/${ex1}`, null, 'i')).body;

  const out = {
    listCardExhibit1: {
      id: c1.id,
      name: c1.name,
      years: c1.years,
      quotaAlertsConfigured: c1.quotaAlertsConfigured,
      quotaAlertLow: c1.quotaAlertLow,
      quotaAlertHigh: c1.quotaAlertHigh,
    },
    listCardExhibit2: {
      id: c2.id,
      name: c2.name,
      years: c2.years,
      quotaAlertsConfigured: c2.quotaAlertsConfigured,
      quotaAlertLow: c2.quotaAlertLow,
      quotaAlertHigh: c2.quotaAlertHigh,
    },
    detailExhibit1Years: d1.years,
    listMatchesDetail: ['2024', '2025', '2026'].every((k) =>
      c1.years[k].limit === d1.years[k].limit &&
      c1.years[k].used === d1.years[k].used &&
      c1.years[k].remaining === d1.years[k].remaining &&
      c1.years[k].over === d1.years[k].over),
  };
  console.log(JSON.stringify(out, null, 2));

  const ok =
    out.listMatchesDetail &&
    c1.years['2024'].limit === 2000 && c1.years['2024'].remaining === 2000 &&
    c1.years['2025'].limit === 1000 && c1.years['2025'].used === 600 &&
      c1.years['2025'].remaining === 400 &&
    c1.years['2026'].limit === null && c1.years['2026'].used === 300 &&
      c1.years['2026'].remaining === null &&
    c1.quotaAlertsConfigured === 1 && c1.quotaAlertLow === 1 && c1.quotaAlertHigh === 0 &&
    c2.years['2025'].limit === 500 && c2.years['2025'].used === 450 &&
      c2.years['2025'].remaining === 50 && c2.years['2026'] === undefined &&
    c2.quotaAlertsConfigured === 1 && c2.quotaAlertLow === 0 && c2.quotaAlertHigh === 1;
  if (!ok) {
    console.error('HTTP 冒烟校验失败');
    process.exit(1);
  }
  console.log('\n[smoke] 真实 pg 形态（bigint 字符串）下列表与详情同口径、跨年不串号、预警计数正确');
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke 失败:', err);
  process.exit(1);
});
