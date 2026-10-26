import {
  fetchProgress,
  evaluate,
  todayInTaipei,
  watchKey,
  DEFAULT_WATCH
} from '../../public/logic.js';
import { sendPush } from './push.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const allow = allowed.includes('*') || allowed.includes(origin) ? origin || '*' : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

const json = (data, request, env, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...cors(request, env) }
  });

async function subId(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(buf)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 取得看診進度，並在 KV 快取 45 秒，避免同一分鐘內重複打醫院網站 */
async function getSnapshot(env, force = false) {
  if (!force) {
    const cached = await env.STATE.get('snapshot', 'json');
    if (cached && Date.now() - cached.fetchedAt < 45000) return cached;
  }
  const rows = await fetchProgress();
  const snapshot = {
    fetchedAt: Date.now(),
    date: rows.length ? rows[0].SCD_VISITDT : todayInTaipei(),
    rows
  };
  await env.STATE.put('snapshot', JSON.stringify(snapshot), { expirationTtl: 86400 });
  return snapshot;
}

// ---------------------------------------------------------------- HTTP

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(request, env) });
  }

  // 前端啟動時取得推播公鑰
  if (url.pathname === '/api/config') {
    return json(
      {
        vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
        pushEnabled: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
        today: todayInTaipei()
      },
      request,
      env
    );
  }

  // 看診進度代理（醫院只有 http，這裡轉成 https + CORS）
  if (url.pathname === '/api/progress') {
    try {
      const snapshot = await getSnapshot(env, url.searchParams.get('force') === '1');
      return json({ ok: true, ...snapshot }, request, env);
    } catch (e) {
      const stale = await env.STATE.get('snapshot', 'json');
      return json(
        { ok: false, error: String(e.message || e), ...(stale || {}), stale: Boolean(stale) },
        request,
        env,
        stale ? 200 : 502
      );
    }
  }

  // 建立／更新推播訂閱與監看設定
  if (url.pathname === '/api/subscribe' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.subscription?.endpoint || !body.subscription.keys?.p256dh) {
      return json({ ok: false, error: '缺少 subscription' }, request, env, 400);
    }
    const id = await subId(body.subscription.endpoint);
    const prev = await env.STATE.get('sub:' + id, 'json');
    const watches = (body.watches || []).map((w) => ({ ...DEFAULT_WATCH, ...w }));
    const today = todayInTaipei();

    // 監看清單有變動時，把該項目的比對狀態清掉，避免沿用舊基準誤判
    const states = prev && prev.day === today ? { ...prev.states } : {};
    const keys = new Set(watches.map(watchKey));
    for (const k of Object.keys(states)) {
      if (k !== '__date' && !keys.has(k)) delete states[k];
    }

    const record = {
      id,
      endpoint: body.subscription.endpoint,
      keys: body.subscription.keys,
      watches,
      states,
      prefs: body.prefs || {},
      day: today,
      createdAt: prev?.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    // 30 天沒更新就自動過期，不留無主資料
    await env.STATE.put('sub:' + id, JSON.stringify(record), { expirationTtl: 30 * 86400 });
    return json({ ok: true, id, watches: watches.length }, request, env);
  }

  if (url.pathname === '/api/unsubscribe' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.endpoint) return json({ ok: false, error: '缺少 endpoint' }, request, env, 400);
    await env.STATE.delete('sub:' + (await subId(body.endpoint)));
    return json({ ok: true }, request, env);
  }

  if (url.pathname === '/api/test-push' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.subscription?.endpoint) {
      return json({ ok: false, error: '缺少 subscription' }, request, env, 400);
    }
    if (!env.VAPID_PRIVATE_KEY) {
      return json({ ok: false, error: '伺服器尚未設定 VAPID 金鑰' }, request, env, 503);
    }
    const r = await sendPush(
      body.subscription,
      {
        title: '測試推播',
        body: '推播設定正常。實際提醒會顯示科別、診間與目前叫號。',
        urgent: true,
        tag: 'test'
      },
      vapidOf(env)
    );
    return json({ ok: r.ok, status: r.status }, request, env, r.ok ? 200 : 502);
  }

  return json({ ok: false, error: 'Not Found' }, request, env, 404);
}

const vapidOf = (env) => ({
  publicKey: env.VAPID_PUBLIC_KEY,
  privateKey: env.VAPID_PRIVATE_KEY,
  subject: env.VAPID_SUBJECT || 'mailto:admin@example.com'
});

// ---------------------------------------------------------------- 排程

/** 每分鐘：抓進度、逐一比對每個訂閱、推播 */
async function pollAndPush(env) {
  const list = await env.STATE.list({ prefix: 'sub:' });
  if (!list.keys.length) return { subs: 0, pushed: 0, skipped: '無訂閱' };

  const records = [];
  for (const k of list.keys) {
    const r = await env.STATE.get(k.name, 'json');
    if (r) records.push(r);
  }

  // 沒有任何人有啟用中的監看目標就不用打醫院網站
  const anyActive = records.some((r) => (r.watches || []).some((w) => w.enabled !== false));
  if (!anyActive) return { subs: records.length, pushed: 0, skipped: '無啟用中的監看' };

  let snapshot;
  try {
    snapshot = await getSnapshot(env);
  } catch (e) {
    return { subs: records.length, pushed: 0, error: String(e.message || e) };
  }

  let pushed = 0;
  const canPush = Boolean(env.VAPID_PRIVATE_KEY);
  const today = todayInTaipei();

  for (const listedRec of records) {
    // /api/subscribe may update a watch while the hospital request is in flight.
    // Always evaluate and persist the latest record, and skip subscriptions that
    // were deleted while fetching.
    const rec = await env.STATE.get('sub:' + listedRec.id, 'json');
    if (!rec) continue;

    // 防呆：跨日但半夜的排程沒跑到時，這裡也會重置
    if (rec.day !== today) {
      rec.watches = [];
      rec.states = {};
      rec.day = today;
      await env.STATE.put('sub:' + rec.id, JSON.stringify(rec), { expirationTtl: 30 * 86400 });
      continue;
    }

    // A request that crossed midnight can still return yesterday's cached rows.
    // Do not use them to stop a watch configured for the new day.
    if (snapshot.date && snapshot.date !== today) continue;

    const { events, states, watches, allDone } = evaluate(rec.watches || [], snapshot.rows, rec.states || {});
    if (allDone && !events.length) {
      const changed = JSON.stringify(states) !== JSON.stringify(rec.states) ||
        JSON.stringify(watches) !== JSON.stringify(rec.watches || []);
      if (changed) {
        rec.states = states;
        rec.watches = watches;
        rec.updatedAt = Date.now();
        await env.STATE.put('sub:' + rec.id, JSON.stringify(rec), { expirationTtl: 30 * 86400 });
      }
      continue;
    }

    rec.states = states;
    rec.watches = watches;
    rec.updatedAt = Date.now();
    await env.STATE.put('sub:' + rec.id, JSON.stringify(rec), { expirationTtl: 30 * 86400 });

    if (!canPush || !events.length) continue;

    for (const ev of events) {
      const r = await sendPush(
        { endpoint: rec.endpoint, keys: rec.keys },
        { title: ev.title, body: ev.body, urgent: ev.urgent, tag: ev.key },
        vapidOf(env)
      );
      if (r.gone) {
        await env.STATE.delete('sub:' + rec.id);
        break;
      }
      if (r.ok) pushed++;
    }
  }
  return { subs: records.length, pushed };
}

/**
 * 每天台北時間凌晨 00:00：清除前一天的所有紀錄。
 * 清掉：當日快取、每個訂閱的監看清單（含我的號碼）與比對狀態。
 * 保留：推播訂閱本身與偏好設定，這樣使用者隔天不用重新授權通知。
 */
async function dailyReset(env) {
  const today = todayInTaipei();
  await env.STATE.delete('snapshot');

  const list = await env.STATE.list({ prefix: 'sub:' });
  let cleared = 0;
  for (const k of list.keys) {
    const rec = await env.STATE.get(k.name, 'json');
    if (!rec) continue;
    rec.watches = [];
    rec.states = {};
    rec.day = today;
    rec.updatedAt = Date.now();
    await env.STATE.put(k.name, JSON.stringify(rec), { expirationTtl: 30 * 86400 });
    cleared++;
  }
  await env.STATE.put(
    'lastReset',
    JSON.stringify({ at: Date.now(), day: today, cleared }),
    { expirationTtl: 30 * 86400 }
  );
  return { cleared, day: today };
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, request, env, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // wrangler.toml 的 crons：["* * * * *", "0 16 * * *"]
    // 0 16 UTC = 台北 00:00（台灣不實施日光節約時間，全年固定 UTC+8）
    if (event.cron === '0 16 * * *') {
      ctx.waitUntil(dailyReset(env));
    } else {
      ctx.waitUntil(pollAndPush(env));
    }
  }
};

export { pollAndPush, dailyReset };
