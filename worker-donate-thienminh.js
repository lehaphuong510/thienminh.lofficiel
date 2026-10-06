const KV_KEY = "donate_data";
const BASE = "https://eventista-platform-api.1vote.vn/v2/tenants/ucFVX5/events/EVENT_lTuLn/candidates/cZUR";
const MONEY_PER_VOTE = 5000;
const WRITE_EVERY_MS = 300000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function getPoints() {
  const res = await fetch(BASE + "?_=" + Date.now(), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("points api " + res.status);
  const json = await res.json();
  const points = Number(json.data.points);
  if (!isFinite(points)) throw new Error("no points");
  return points;
}

async function getTxTotal() {
  try {
    const res = await fetch(BASE + "/transactions?page=1&limit=1&_=" + Date.now(), { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const json = await res.json();
    const total = Number(json.data.pagination.total);
    return isFinite(total) ? total : null;
  } catch (e) {
    return null;
  }
}

async function loadState(env) {
  const s = await env.DONATE_DB.get(KV_KEY, "json");
  if (s) return s;
  return { free_votes: 0, total_money: 0, points_prev: null, tx_prev: null, last_write: 0 };
}

async function countFreeVotes(env) {
  const state = await loadState(env);
  let points, txTotal;
  try {
    points = await getPoints();
    txTotal = await getTxTotal();
  } catch (e) {
    return;
  }

  const prevPoints = state.points_prev == null ? null : Number(state.points_prev);
  const prevTx = state.tx_prev == null ? null : Number(state.tx_prev);
  let freeVotes = Number(state.free_votes) || 0;

  if (prevPoints != null && points > prevPoints) {
    const delta = points - prevPoints;
    let actions = (7 * delta) % 10;
    if (prevTx != null && txTotal != null && txTotal >= prevTx) {
      const deltaTx = txTotal - prevTx;
      if (actions > deltaTx) actions = 0;
    }
    if (actions > 0) freeVotes += actions; // 1 luot binh chon mien phi = 1 don vi hien thi
  }

  const now = Date.now();
  const changed = freeVotes !== (Number(state.free_votes) || 0);
  const mustWrite = changed || prevPoints == null || now - (Number(state.last_write) || 0) > WRITE_EVERY_MS;
  if (!mustWrite) return;

  await env.DONATE_DB.put(KV_KEY, JSON.stringify({
    free_votes: freeVotes,
    total_money: freeVotes * MONEY_PER_VOTE,
    points_prev: points,
    tx_prev: txTotal,
    last_write: now,
    updated_at: new Date().toISOString(),
  }));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "GET") {
      const s = await loadState(env);
      return new Response(JSON.stringify({
        free_votes: Number(s.free_votes) || 0,
        total_money: Number(s.total_money) || 0,
        points: s.points_prev == null ? null : Number(s.points_prev),
        total_transactions: s.tx_prev == null ? null : Number(s.tx_prev),
        updated_at: s.updated_at || null,
      }), { headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }) });
    }

    if (request.method === "POST") {
      const token = request.headers.get("Authorization");
      if (token !== "Bearer THIENMINH_SECRET_2026") {
        return new Response("Cam vao! Sai mat khau", { status: 401, headers: corsHeaders });
      }
      const body = await request.json();
      const state = await loadState(env);
      const next = Object.assign({}, state, body);
      next.updated_at = new Date().toISOString();
      if (body.free_votes != null && body.total_money == null) {
        next.total_money = Number(body.free_votes) * MONEY_PER_VOTE;
      }
      await env.DONATE_DB.put(KV_KEY, JSON.stringify(next));
      return new Response(JSON.stringify({ success: true, free_votes: next.free_votes, total_money: next.total_money }), {
        headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(countFreeVotes(env));
  },
};
