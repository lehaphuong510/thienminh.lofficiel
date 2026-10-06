import streamlit as st
import requests
import time
import re  # Thư viện để tìm kiếm trong chuỗi (Regex)

# --- CẤU HÌNH ---
URL_WORKER = "https://api-donate-thienminh.lehaphuong510.workers.dev/"
SECRET_TOKEN = "THIENMINH_SECRET_2026"

# Link API m vừa đưa
URL_TRANSACTIONS = "https://eventista-platform-api.1vote.vn/v2/tenants/ucFVX5/events/EVENT_lTuLn/candidates/cZUR/transactions?page=1&limit=1"
URL_CANDIDATE = "https://lofficielbca2026.1vote.vn/candidate/EVENT_lTuLn/thien-minh-cZUR?_rsc=1vjkv"

# Số lượt Free quá khứ (M tự chốt số nha)
INITIAL_FREE_VOTES = 0  

# --- HÀM LẤY TỔNG VOTE TỪ LINK LỘN XỘN ---
def get_total_votes():
    res = requests.get(URL_CANDIDATE)
    # Lục tìm chữ "totalVoteValue": con số
    match = re.search(r'"totalVoteValue":(\d+)', res.text)
    if match:
        return int(match.group(1))
    else:
        raise Exception("Không tìm thấy số vote trong đống text!")

st.set_page_config(page_title="Hệ thống đếm Vote", layout="centered")
st.title("🤖 Bot Tracking Vote Free 24/7")

# Khởi tạo
if 'initialized' not in st.session_state:
    try:
        st.session_state.last_trans = requests.get(URL_TRANSACTIONS).json()['data']['pagination']['total']
        st.session_state.last_votes = get_total_votes()  # Đổi sang dùng hàm mới
        st.session_state.total_free_votes = INITIAL_FREE_VOTES
        st.session_state.initialized = True
        st.success(f"Khởi động thành công! Mốc hiện tại - Giao dịch: {st.session_state.last_trans} | Vote: {st.session_state.last_votes}")
    except Exception as e:
        st.error(f"Lỗi khởi tạo: {e}")
        st.stop()

def update_cloudflare(free_votes):
    total_money = free_votes * 5000
    try:
        payload = {"free_votes": free_votes, "total_money": total_money}
        headers = {"Authorization": f"Bearer {SECRET_TOKEN}"}
        requests.post(URL_WORKER, json=payload, headers=headers)
    except Exception as e:
        st.error(f"Lỗi đẩy data: {e}")

# --- LOGIC QUÉT VÀ PHÂN TÍCH ---
st.write("Đang quét dữ liệu...")

try:
    current_trans = requests.get(URL_TRANSACTIONS).json()['data']['pagination']['total']
    current_votes = get_total_votes()  # Đổi sang dùng hàm mới
    
    delta_trans = current_trans - st.session_state.last_trans
    delta_votes = current_votes - st.session_state.last_votes
    
    if delta_trans > 0:
        duoi_vote = delta_votes % 10
        f = 0
        for i in range(10):
            if (i * 3) % 10 == duoi_vote:
                f = i
                break
                
        if f <= delta_trans and (f * 3) <= delta_votes:
            st.session_state.total_free_votes += f
            update_cloudflare(st.session_state.total_free_votes)
            st.toast(f"🎉 Phát hiện {f} lượt Vote Free!", icon="💰")
            
        st.session_state.last_trans = current_trans
        st.session_state.last_votes = current_votes

except Exception as e:
    st.warning(f"Chờ kết nối mạng... ({e})")

st.metric(label="Tổng lượt Vote Free đã ghi nhận", value=st.session_state.total_free_votes)
st.metric(label="Tiền Donate dự kiến (VNĐ)", value=st.session_state.total_free_votes * 5000)

time.sleep(5)
st.rerun()
