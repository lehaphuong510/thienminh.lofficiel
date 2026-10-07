/* ============================================================
   Worker: dem luot binh chon + GHI LICH SU (chi ghi khi so DOI)
   - Moi phut: doc tong so giao dich (= so luot) + diem tu API 1vote
   - So doi  -> ghi 1 moc vao lich su {t, v, p}
   - Khong doi -> khong ghi (chi ghi nhip tim moi 3 gio de biet worker con song)
   - GET  /            -> tom tat
   - GET  /?history=1  -> tom tat + toan bo lich su
   - POST /            -> ep cap nhat ngay (can token)
   So hien thi = TONG so giao dich tu dau giai (khong chia free/mua)
   ============================================================ */

const KV_KEY = "donate_data";
const BASE = "https://eventista-platform-api.1vote.vn/v2/tenants/ucFVX5/events/EVENT_lTuLn/candidates/cZUR";
const TOKEN = "Bearer THIENMINH_SECRET_2026";

const MONEY_PER_VOTE = 5000;

/* Gop cac thay doi qua sat nhau lai, tran an toan cho han ghi KV free tier (1000/ngay).
   120s -> toi da 720 lan ghi/ngay. Vote tut van duoc ghi o tick ke tiep, khong mat. */
const MIN_WRITE_GAP_MS = 120000;
/* Nhip tim: luc nao cung giu 1 moc moi 3 gio -> 8 lan ghi/ngay */
const HEARTBEAT_MS = 3 * 3600 * 1000;
/* Lich su: toi da 2000 moc, xoa moc cu hon 14 ngay */
const HISTORY_MAX = 2000;
const HISTORY_TTL_MS = 14 * 24 * 3600 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
  });
}

/* --- doc API 1vote --- */
async function getPoints() {
  const res = await fetch(BASE + "?_=" + Date.now(), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("points " + res.status);
  const j = await res.json();
  const p = Number(j.data && j.data.points);
  if (!isFinite(p)) throw new Error("no points");
  return p;
}

async function getVoteTotal() {
  const res = await fetch(BASE + "/transactions?page=1&limit=1&_=" + Date.now(), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("tx " + res.status);
  const j = await res.json();
  const t = Number(j.data && j.data.pagination && j.data.pagination.total);
  if (!isFinite(t)) throw new Error("no total");
  return t;
}

/* --- doc / ghi KV --- */
async function loadState(env) {
  const s = await env.DONATE_DB.get(KV_KEY, "json");
  if (!s) return { total_votes: 0, total_money: 0, points: null, peak_votes: 0, peak_at: null, history: [], last_write: 0, last_check: 0 };
  /* state cu (truoc khi doi cach dem) -> cho phep ghi lai ngay */
  if (s.total_votes == null) s.last_write = 0;
  return s;
}

async function tick(env, force) {
  const state = await loadState(env);
  const now = Date.now();

  let total, points;
  try {
    total = await getVoteTotal();
    points = await getPoints();
  } catch (e) {
    return; /* API loi -> giu nguyen so cu, khong ghi de bang 0 */
  }

  const prevTotal = state.total_votes == null ? null : Number(state.total_votes);
  const prevPoints = state.points == null ? null : Number(state.points);
  const changed = prevTotal !== total || prevPoints !== points;

  /* Khong doi gi: chi ghi nhip tim, va chi khi da qua 3 gio */
  if (!changed && !force) {
    if (now - (Number(state.last_check) || 0) < HEARTBEAT_MS) return;
    state.last_check = now;
    state.last_write = now; /* nhip tim cung tinh la 1 lan ghi -> khoa chan ghi trung */
    await env.DONATE_DB.put(KV_KEY, JSON.stringify(state));
    return;
  }

  /* Co doi nhung vua ghi xong -> de tick sau ghi, gop lai cho do ton luot ghi */
  if (!force && now - (Number(state.last_write) || 0) < MIN_WRITE_GAP_MS) return;

  const history = Array.isArray(state.history) ? state.history.slice() : [];
  history.push({ t: now, v: total, p: points });
  const cutoff = now - HISTORY_TTL_MS;
  while (history.length && (history.length > HISTORY_MAX || history[0].t < cutoff)) history.shift();

  const peakVotes = Math.max(Number(state.peak_votes) || 0, total);
  const peakAt = peakVotes === total ? new Date(now).toISOString() : (state.peak_at || null);

  await env.DONATE_DB.put(KV_KEY, JSON.stringify({
    total_votes: total,
    total_money: total * MONEY_PER_VOTE,
    points: points,
    peak_votes: peakVotes,
    peak_at: peakAt,
    history: history,
    last_write: now,
    last_check: now,
    updated_at: new Date(now).toISOString(),
  }));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    if (request.method === "GET") {
      const s = await loadState(env);
      /* tuong thich state cu: chua co total_votes thi lay free_votes */
      const total = Number(s.total_votes != null ? s.total_votes : (s.free_votes || 0)) || 0;
      const out = {
        total_votes: total,
        total_money: Number(s.total_money) || total * MONEY_PER_VOTE,
        free_votes: total, /* alias cu, giu de trang cu khong hien 0 */
        points: s.points == null ? null : Number(s.points),
        peak_votes: Number(s.peak_votes) || total,
        peak_at: s.peak_at || null,
        updated_at: s.updated_at || null,
        last_check: s.last_check ? new Date(Number(s.last_check)).toISOString() : null,
        history_count: (s.history || []).length,
      };
      const url = new URL(request.url);
      if (url.searchParams.get("history")) out.history = s.history || [];
      return json(out);
    }

    if (request.method === "POST") {
      if (request.headers.get("Authorization") !== TOKEN) {
        return new Response("Cam vao! Sai mat khau", { status: 401, headers: corsHeaders });
      }
      await tick(env, true);
      const s = await loadState(env);
      return json({ success: true, total_votes: Number(s.total_votes) || 0, updated_at: s.updated_at || null });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, false));
  },
};
