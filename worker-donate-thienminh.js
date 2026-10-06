/**
 * api-donate-thienminh — worker TỰ ĐẾM vote free (bản 2)
 *
 * Vì sao trước đó web không nhảy số:
 *   - Worker cũ chỉ là "kho chứa": GET đọc KV, POST ghi KV. Không có cron.
 *   - Script Python (Streamlit) mới là thứ đếm và POST lên, nhưng Streamlit chỉ
 *     chạy khi có người mở tab, và st.session_state mất khi app restart.
 *   => không ai chạy -> KV rỗng -> luôn trả 0.
 *
 * Bản này chuyển logic đếm từ Python vào worker, chạy bằng Cron Trigger.
 * Logic y hệt script Python của bạn:
 *   - 1 lượt free = +3 điểm (gói FREE: point 3, 1 lượt/ngày/người, mobile)
 *   - gói paid luôn là bội số của 10 (20/50/150/300...)
 *   => số lượt free trong 1 khoảng = f nhỏ nhất thoả (3f) % 10 == delta % 10
 *      ~ tương đương (7 * delta) % 10
 *   - chốt an toàn: f không thể lớn hơn số giao dịch mới trong cùng khoảng
 *
 * GET giữ nguyên shape cũ (free_votes, total_money) nên trang web KHÔNG cần sửa.
 * POST giữ nguyên token cũ nên script Python vẫn dùng được như cũ.
 *
 * CẦN LÀM: Settings > Triggers > Cron Triggers -> thêm "* * * * *" (mỗi phút)
 */

const KV_KEY = "donate_data";
const TENANT = "ucFVX5";
const EVENT  = "EVENT_lTuLn";
const CAND   = "cZUR";
const MONEY_PER_VOTE = 5000;
const BASE = `https://eventista-platform-api.1vote.vn/v2/tenants/${TENANT}/events/${EVENT}/candidates/${CAND}`;
const WRITE_EVERY_MS = 5 * 60 * 1000; // KV free tier 1.000 ghi/ngày -> ghi tối đa 1 lần/5 phút

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function getPoints() {
  const res = await fetch(`${BASE}?_=${Date.now()}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("1vote candidate API " + res.status);
  const json = await res.json();
  const points = Number(json?.data?.points);
  if (!Number.isFinite(points)) throw new Error("Không đọc được points");
  return points;
}

// tổng số giao dịch vote (dùng làm chốt an toàn). Lỗi thì trả null, không chặn.
async function getTxTotal() {
  try {
    const res = await fetch(`${BASE}/transactions?page=1&limit=1&_=${Date.now()}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const total = Number(json?.data?.pagination?.total);
    return Number.isFinite(total) ? total : null;
  } catch (e) {
    return null;
  }
}

async function loadState(env) {
  const s = await env.DONATE_DB.get(KV_KEY, "json");
  return s || { free_votes: 0, total_money: 0, points_prev: null, tx_prev: null, last_write: 0 };
}

async function countFreeVotes(env) {
  const state = await loadState(env);

  let points, txTotal;
  try {
    points = await getPoints();
    txTotal = await getTxTotal();
  } catch (e) {
    return; // API lỗi thì bỏ qua lượt này, không ghi gì
  }

  const prevPoints = state.points_prev == null ? null : Number(state.points_prev);
  const prevTx = state.tx_prev == null ? null : Number(state.tx_prev);
  let freeVotes = Number(state.free_votes) || 0;

  if (prevPoints != null && points > prevPoints) {
    const delta = points - prevPoints;
    let f = (7 * delta) % 10; // số lượt free trong khoảng này (đúng khi < 10 lượt)

    if (prevTx != null && txTotal != null && txTotal >= prevTx) {
      const deltaTx = txTotal - prevTx;
      if (f > deltaTx) f = 0; // không thể có nhiều lượt free hơn số giao dịch mới -> chặn đếm sai
    }

    if (f > 0) freeVotes += f;
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
        points: s.points_prev ?? null,
        total_transactions: s.tx_prev ?? null,
        updated_at: s.updated_at ?? null,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (request.method === "POST") {
      const token = request.headers.get("Authorization");
      if (token !== "Bearer THIENMINH_SECRET_2026") {
        return new Response("Cấm vào! Sai mật khẩu", { status: 401, headers: corsHeaders });
      }
      const body = await request.json();
      const state = await loadState(env);
      const next = { ...state, ...body, updated_at: new Date().toISOString() };
      if (body.free_votes != null && body.total_money == null) {
        next.total_money = Number(body.free_votes) * MONEY_PER_VOTE;
      }
      await env.DONATE_DB.put(KV_KEY, JSON.stringify(next));
      return new Response(JSON.stringify({ success: true, ...next }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(countFreeVotes(env));
  },
};
