/* Thiên Minh — donate hai giai đoạn, giữ nguyên KV và bộ đếm giao dịch.
 * Mỗi giao dịch mới = 1 lượt; không nhân 3 vì BTC cho phép 3 lượt/tài khoản.
 * Trước 13:30 13/10/2026 (VN): 5.000đ/lượt.
 * 13:30 13/10 -> 13:30 14/10/2026 (VN): 15.000đ/lượt.
 * Phân loại theo paymentTime, không theo giờ cron đọc được giao dịch.
 * GIỮ binding DONATE_DB và namespace cũ; giữ cron mỗi phút.
 * GET /?history=1 giữ lịch sử cũ. POST chỉ ép quét; không sửa số bằng tay.
 */
const KV_KEY = "donate_data";
const BASE = "https://eventista-platform-api.1vote.vn/v2/tenants/ucFVX5/events/EVENT_lTuLn/candidates/cZUR";
const TOKEN = "Bearer THIENMINH_SECRET_2026";
const SCHEMA = 4;
const PRICING_VERSION = 1;
const LEGACY_RATE = 5000;
const SPRINT_RATE = 15000;
const SPRINT_START = Date.parse("2026-10-13T13:30:00+07:00");
const VOTE_END = Date.parse("2026-10-14T13:30:00+07:00");
const MIN_WRITE_GAP_MS = 120000;
const HEARTBEAT_MS = 3 * 3600 * 1000;
const HISTORY_MAX = 2000;
const HISTORY_TTL_MS = 14 * 24 * 3600 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 6;
const SEEN_MAX = 400;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
function vn(ms) {
  const d = new Date(Number(ms) + 7 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function phase(now = Date.now()) {
  return now < SPRINT_START ? "before_sprint" : now <= VOTE_END ? "sprint" : "ended";
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {status, headers: {
    ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
  }});
}
function integer(n) { return Number.isSafeInteger(Number(n)) && Number(n) >= 0; }
async function loadState(env) {
  const s = await env.DONATE_DB.get(KV_KEY, "json");
  if (!s || s.total_votes == null || !integer(s.total_votes) ||
      !Array.isArray(s.seen) || s.seen.length === 0) {
    throw new Error("MISSING_EXISTING_STATE: giu DONATE_DB/namespace cu, khong xoa donate_data.");
  }
  return s;
}
function seenTime(key) { return Number(String(key).split("|")[0]); }
function applyAmounts(s) {
  s.total_votes = s.legacy_votes + s.sprint_votes;
  s.legacy_money = s.legacy_votes * LEGACY_RATE;
  s.sprint_money = s.sprint_votes * SPRINT_RATE;
  s.total_money = s.legacy_money + s.sprint_money;
  return s;
}
/* Nâng cấp trước giờ bắt đầu: toàn bộ tổng đang có vẫn là 5k.
 * Nếu triển khai trễ, chỉ tách lại khi 400 mốc seen còn bao trùm giờ bắt đầu.
 * Không tự đoán số chốt khi mốc đã rơi khỏi cửa sổ lưu trữ.
 */
function migratePricing(input, now = Date.now()) {
  const s = {...input};
  if (Number(s.pricing_version) === PRICING_VERSION) {
    if (!integer(s.legacy_votes) || !integer(s.sprint_votes)) throw new Error("INVALID_PHASE_COUNTS");
    s.legacy_votes = Number(s.legacy_votes);
    s.sprint_votes = Number(s.sprint_votes);
    return applyAmounts(s);
  }
  const total = Number(s.total_votes);
  let sprint = 0, excluded = 0;
  if (now >= SPRINT_START) {
    const stamps = [...new Set(s.seen.map(String))].map(seenTime).filter(t => Number.isFinite(t) && t > 0);
    const lastCheck = Number(s.last_check) || 0;
    const covered = lastCheck > 0 && (lastCheck < SPRINT_START ||
      (stamps.length > 0 && Math.min(...stamps) < SPRINT_START));
    if (!covered) throw new Error("CUTOVER_NOT_COVERED: khong du moc giao dich de tach lai; khong tu doan so chot.");
    for (const t of stamps) {
      if (t >= SPRINT_START && t <= VOTE_END) sprint++;
      else if (t > VOTE_END) excluded++;
    }
  }
  if (sprint + excluded > total) throw new Error("INVALID_MIGRATION_COUNTS");
  s.legacy_votes = total - sprint - excluded;
  s.sprint_votes = sprint;
  s.excluded_after_end = excluded;
  s.pricing_version = PRICING_VERSION;
  return applyAmounts(s);
}
async function getPoints() {
  const res = await fetch(BASE + "?_=" + Date.now(), {headers: {accept: "application/json"}});
  if (!res.ok) throw new Error("points " + res.status);
  const j = await res.json();
  const p = Number(j.data && j.data.points);
  if (!Number.isFinite(p)) throw new Error("no points");
  return p;
}
async function getWindow() {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${BASE}/transactions?page=${page}&limit=${PAGE_SIZE}&_=${Date.now()}`,
      {headers: {accept: "application/json"}});
    if (!res.ok) throw new Error("tx " + res.status);
    const j = await res.json();
    const rows = j.data && j.data.data;
    if (!Array.isArray(rows)) throw new Error("invalid transaction payload");
    if (!rows.length) break;
    for (const r of rows) {
      const t = Number(r.paymentTime), id = r.orderId == null ? "" : String(r.orderId);
      if (!Number.isFinite(t) || t <= 0 || !id) throw new Error("invalid transaction key");
      out.push({t, id});
    }
  }
  return out;
}
async function tick(env, force = false) {
  let input, s;
  const now = Date.now();
  try {
    input = await loadState(env);
    s = migratePricing(input, now);
  } catch (e) { console.error("donate state", e.message); return {ok: false, error: e.message}; }
  let rows, points;
  try { [rows, points] = await Promise.all([getWindow(), getPoints()]); }
  catch (e) { console.warn("donate upstream", e.message); return {ok: false, error: "UPSTREAM_UNAVAILABLE"}; }
  const migrated = Number(input.pricing_version) !== PRICING_VERSION || Number(input.schema) !== SCHEMA;
  const currentPhase = phase(now);
  const boundary = input.phase_at_write !== currentPhase;
  const seen = new Set(s.seen.map(String));
  const oldTimeKeys = new Set([...seen].filter(k => !k.includes("|")));
  const batch = new Set();
  let legacyAdded = 0, sprintAdded = 0, excludedAdded = 0;
  for (const r of rows) {
    const key = r.t + "|" + r.id;
    if (batch.has(key)) continue;
    batch.add(key);
    if (!seen.has(key) && !oldTimeKeys.has(String(r.t))) {
      if (r.t < SPRINT_START) legacyAdded++;
      else if (r.t <= VOTE_END) sprintAdded++;
      else excludedAdded++;
    }
    seen.delete(String(r.t));
    seen.add(key);
  }
  s.legacy_votes += legacyAdded;
  s.sprint_votes += sprintAdded;
  s.excluded_after_end = (Number(s.excluded_after_end) || 0) + excludedAdded;
  applyAmounts(s);
  const changed = migrated || boundary || legacyAdded > 0 || sprintAdded > 0 || excludedAdded > 0 ||
    s.points == null || Number(s.points) !== points;
  if (!changed && !force && now - (Number(s.last_check) || 0) < HEARTBEAT_MS) return {ok: true, wrote: false};
  // Migration and time-boundary snapshots are written once, even inside the normal 2-minute gap.
  if (changed && !force && !migrated && !boundary &&
      now - (Number(s.last_write) || 0) < MIN_WRITE_GAP_MS) return {ok: true, wrote: false};
  s.seen = [...seen].sort((a,b) => seenTime(b) - seenTime(a)).slice(0, SEEN_MAX);
  s.schema = SCHEMA;
  s.phase_at_write = currentPhase;
  s.points = points;
  s.last_write = now;
  s.last_check = now;
  if (changed || force) {
    s.updated_at = new Date(now).toISOString();
    const history = Array.isArray(s.history) ? s.history.slice() : [];
    history.push({t: now, time: vn(now), v: s.total_votes, p: points,
      legacy_v: s.legacy_votes, sprint_v: s.sprint_votes, money: s.total_money});
    const cutoff = now - HISTORY_TTL_MS;
    while (history.length && (history.length > HISTORY_MAX || Number(history[0].t) < cutoff)) history.shift();
    s.history = history;
    const prevPeak = Number(s.peak_votes) || 0;
    s.peak_votes = Math.max(prevPeak, s.total_votes);
    if (s.total_votes > prevPeak || !s.peak_at) s.peak_at = new Date(now).toISOString();
  }
  await env.DONATE_DB.put(KV_KEY, JSON.stringify(s));
  return {ok: true, wrote: true};
}
function publicState(s, now = Date.now()) {
  return {
    total_votes: s.total_votes, total_money: s.total_money, free_votes: s.total_votes,
    legacy_votes: s.legacy_votes, legacy_money: s.legacy_money, legacy_rate: LEGACY_RATE,
    sprint_votes: s.sprint_votes, sprint_money: s.sprint_money, sprint_rate: SPRINT_RATE,
    pricing_version: PRICING_VERSION, phase: phase(now),
    legacy_closed: now >= SPRINT_START, voting_closed: now > VOTE_END,
    sprint_start: new Date(SPRINT_START).toISOString(), voting_end: new Date(VOTE_END).toISOString(),
    points: s.points == null ? null : Number(s.points),
    peak_votes: Number(s.peak_votes) || s.total_votes, peak_at: s.peak_at || null,
    updated_at: s.updated_at || null,
    last_check: s.last_check ? vn(s.last_check) + " (gio VN)" : null,
    last_check_utc: s.last_check ? new Date(Number(s.last_check)).toISOString() : null,
    history_count: Array.isArray(s.history) ? s.history.length : 0,
  };
}
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, {headers: corsHeaders});
    if (request.method === "GET") {
      try {
        const s = migratePricing(await loadState(env));
        const out = publicState(s);
        if (new URL(request.url).searchParams.get("history")) out.history = s.history || [];
        return json(out);
      } catch (e) { return json({error: "STATE_NOT_READY", detail: e.message}, 503); }
    }
    if (request.method === "POST") {
      if (request.headers.get("Authorization") !== TOKEN)
        return new Response("Cam vao! Sai mat khau", {status: 401, headers: corsHeaders});
      const result = await tick(env, true);
      if (!result.ok) return json({success: false, error: result.error}, 503);
      return json({success: true, ...publicState(migratePricing(await loadState(env)))});
    }
    return new Response("Not found", {status: 404});
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, false).catch(e => console.error("donate scheduled", e.message)));
  },
};
