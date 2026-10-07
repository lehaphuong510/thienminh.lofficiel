/* ============================================================
   Worker: dem luot binh chon + GHI LICH SU
   ------------------------------------------------------------------
   QUAN TRONG: API 1vote chi giu 300 giao dich GAN NHAT (cua so truot),
   nen pagination.total dung o 300 chu khong phai tong that.
   => Worker tu dem cong don: so nao chua tung thay thi +1.
   So hien thi = TONG THAT tu dau giai (free + mua, moi giao dich = 1 luot)
   ------------------------------------------------------------------
   - Moi phut: doc cua so giao dich + diem tu API 1vote
   - Nhan dien luot moi bang CAP (paymentTime + orderId): chi can 1 trong 2
     khac la tinh luot moi -> chong ca truong hop trung mili-giay
   - Co luot moi -> ghi 1 moc lich su {t, v, p}
   - Khong doi -> khong ghi (chi nhip tim moi 3 gio)
   - GET  /            -> tom tat
   - GET  /?history=1  -> tom tat + lich su
   - POST /            -> ep cap nhat ngay (can token)
   ============================================================ */

const KV_KEY = "donate_data";
const BASE = "https://eventista-platform-api.1vote.vn/v2/tenants/ucFVX5/events/EVENT_lTuLn/candidates/cZUR";
const TOKEN = "Bearer THIENMINH_SECRET_2026";

const MONEY_PER_VOTE = 5000;

/* Moc chuyen sang cach dem cong don:
   luc 07/10/2026 12:20:56 (VN), tong that tu dau giai = 332 giao dich. */
const SCHEMA = 3;
const BASE_VOTES = 332;

/* Gop thay doi qua sat nhau, tran an toan cho han ghi KV free tier (1000/ngay) */
const MIN_WRITE_GAP_MS = 120000;
const HEARTBEAT_MS = 3 * 3600 * 1000;
const HISTORY_MAX = 2000;
const HISTORY_TTL_MS = 14 * 24 * 3600 * 1000;

const PAGE_SIZE = 50;
const MAX_PAGES = 6;      /* API chi giu 300 giao dich gan nhat */
const SEEN_MAX = 400;     /* nho 400 moc gan nhat de doi chieu */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/* Gio Viet Nam (UTC+7, khong co DST) */
function vn(ms) {
  const d = new Date(Number(ms) + 7 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
  });
}

async function getPoints() {
  const res = await fetch(BASE + "?_=" + Date.now(), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("points " + res.status);
  const j = await res.json();
  const p = Number(j.data && j.data.points);
  if (!isFinite(p)) throw new Error("no points");
  return p;
}

/* Lay cua so giao dich gan nhat (toi da 300 cai API dang giu) */
async function getWindow() {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${BASE}/transactions?page=${page}&limit=${PAGE_SIZE}&_=${Date.now()}`);
    if (!res.ok) throw new Error("tx " + res.status);
    const j = await res.json();
    const rows = (j.data && j.data.data) || [];
    if (!rows.length) break;
    for (const r of rows) {
      const t = Number(r.paymentTime);
      if (isFinite(t)) out.push({ t: t, id: String(r.orderId || "") });
    }
  }
  return out;
}

async function loadState(env) {
  const s = await env.DONATE_DB.get(KV_KEY, "json");
  if (s) return s;
  return {
    schema: SCHEMA, total_votes: BASE_VOTES, total_money: BASE_VOTES * MONEY_PER_VOTE,
    points: null, peak_votes: BASE_VOTES, peak_at: null, seen: [], history: [],
    last_write: 0, last_check: 0,
  };
}

async function tick(env, force) {
  const state = await loadState(env);
  const now = Date.now();

  /* Chua co gi -> khoi tao. Schema cu (2) -> nang cap: tick nay van doi chieu
     theo moc thoi gian nhu cu, dong thoi chuyen 'seen' sang dang cap. */
  const fresh = !Array.isArray(state.seen) || state.seen.length === 0 || state.total_votes == null;
  const upgrade = !fresh && Number(state.schema) !== SCHEMA;
  const prevVotes = fresh ? BASE_VOTES : (Number(state.total_votes) || 0);
  const prevPoints = state.points == null ? null : Number(state.points);

  let rows, points;
  try {
    /* goi song song cho 2 endpoint gan nhu cung luc -> do lech nho nhat */
    const both = await Promise.all([getWindow(), getPoints()]);
    rows = both[0];
    points = both[1];
  } catch (e) {
    return; /* API loi -> giu nguyen so cu, khong ghi de */
  }

  /* Doi chieu tung giao dich theo CAP paymentTime|orderId.
     Tick nang cap doi chieu bang moc thoi gian (dang cu), sau do moi doi sang cap. */
  const seen = new Set(fresh ? [] : state.seen || []);
  let added = 0;
  for (const r of rows) {
    const key = r.t + "|" + r.id;
    if (!fresh) {
      /* Nang cap: doi chieu bang moc thoi gian (dang cu), nhung van kiem tra
         ca khoa cap de mot giao dich xuat hien 2 lan trong 1 lan quet
         cung khong bi dem 2 luot. */
      if (upgrade ? (!seen.has(r.t) && !seen.has(key)) : !seen.has(key)) added++;
    }
    seen.delete(r.t);   /* bo dang so cu -> khong chiem 2 cho cho 1 giao dich */
    seen.add(key);
  }
  const liveVotes = prevVotes + added;

  /* Giu lai 400 moc gan nhat (xep theo paymentTime) */
  const seenArr = Array.from(seen)
    .sort((a, b) => Number(String(b).split("|")[0]) - Number(String(a).split("|")[0]))
    .slice(0, SEEN_MAX);

  const changed = fresh || upgrade || liveVotes !== prevVotes || prevPoints !== points;

  if (!changed && !force) {
    if (now - (Number(state.last_check) || 0) < HEARTBEAT_MS) return;
    state.last_check = now;
    state.last_write = now;
    await env.DONATE_DB.put(KV_KEY, JSON.stringify(state));
    return;
  }

  if (!force && !fresh && !upgrade && now - (Number(state.last_write) || 0) < MIN_WRITE_GAP_MS) return;

  const history = fresh ? [] : (Array.isArray(state.history) ? state.history.slice() : []);
  history.push({ t: now, time: vn(now), v: liveVotes, p: points });
  const cutoff = now - HISTORY_TTL_MS;
  while (history.length && (history.length > HISTORY_MAX || history[0].t < cutoff)) history.shift();

  const prevPeak = fresh ? 0 : (Number(state.peak_votes) || 0);
  const peakVotes = Math.max(prevPeak, liveVotes);
  const peakAt = peakVotes === liveVotes ? new Date(now).toISOString() : (state.peak_at || null);

  await env.DONATE_DB.put(KV_KEY, JSON.stringify({
    schema: SCHEMA,
    total_votes: liveVotes,
    total_money: liveVotes * MONEY_PER_VOTE,
    points: points,
    peak_votes: peakVotes,
    peak_at: peakAt,
    seen: seenArr,
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
      const total = Number(s.total_votes) || 0;
      const out = {
        total_votes: total,
        total_money: Number(s.total_money) || total * MONEY_PER_VOTE,
        free_votes: total, /* alias cu, giu de trang cu khong hien 0 */
        points: s.points == null ? null : Number(s.points),
        peak_votes: Number(s.peak_votes) || total,
        peak_at: s.peak_at || null,
        updated_at: s.updated_at || null,
        last_check: s.last_check ? vn(s.last_check) + " (gio VN)" : null,
        last_check_utc: s.last_check ? new Date(Number(s.last_check)).toISOString() : null,
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

      /* Khong gui gi -> ep cap nhat ngay */
      await tick(env, true);
      const s = await loadState(env);
      return json({ success: true, total_votes: Number(s.total_votes) || 0,
                    last_check: s.last_check ? vn(s.last_check) : null });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, false));
  },
};
