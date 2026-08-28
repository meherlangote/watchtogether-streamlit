from pathlib import Path
import streamlit as st

BASE_DIR = Path(__file__).parent

st.set_page_config(
    page_title="WatchTogether",
    page_icon="🎬",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# Hide Streamlit's default chrome so the app feels like a consumer product.
st.markdown(
    """
    <style>
      [data-testid="stHeader"], [data-testid="stToolbar"], footer {display:none!important;}
      [data-testid="stAppViewContainer"] {background:#07090f;}
      [data-testid="stMainBlockContainer"] {max-width:none; padding:0!important;}
      .stMainBlockContainer {padding:0!important;}
    </style>
    """,
    unsafe_allow_html=True,
)

required = ["SUPABASE_URL", "SUPABASE_KEY"]
missing = [key for key in required if not st.secrets.get(key)]

if missing:
    st.error("WatchTogether needs Supabase Realtime settings before it can start.")
    st.markdown(
        """
### Add these in Streamlit Cloud → App settings → Secrets

```toml
SUPABASE_URL = "https://YOUR_PROJECT.supabase.co"
SUPABASE_KEY = "YOUR_PUBLISHABLE_OR_ANON_KEY"

# Optional TURN server for networks where direct WebRTC cannot connect:
TURN_URL = ""
TURN_USERNAME = ""
TURN_PASSWORD = ""
```

Use a **publishable/anon key**, never a Supabase `service_role` key. The publishable/anon key is intentionally sent to the browser because the realtime client runs there.
        """
    )
    st.stop()

html = (BASE_DIR / "component.html").read_text(encoding="utf-8")
css = (BASE_DIR / "component.css").read_text(encoding="utf-8")
js = (BASE_DIR / "component.js").read_text(encoding="utf-8")

watch_component = st.components.v2.component(
    name="watchtogether_app",
    html=html,
    css=css,
    js=js,
    isolate_styles=True,
)

room_from_url = str(st.query_params.get("room", "") or "").strip().upper()

stun_urls = st.secrets.get(
    "STUN_URLS",
    ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
)
if isinstance(stun_urls, str):
    stun_urls = [item.strip() for item in stun_urls.split(",") if item.strip()]

watch_component(
    key="watchtogether-main",
    data={
        "supabaseUrl": st.secrets["SUPABASE_URL"],
        "supabaseKey": st.secrets["SUPABASE_KEY"],
        "roomFromUrl": room_from_url,
        "stunUrls": list(stun_urls),
        "turnUrl": st.secrets.get("TURN_URL", ""),
        "turnUsername": st.secrets.get("TURN_USERNAME", ""),
        "turnPassword": st.secrets.get("TURN_PASSWORD", ""),
    },
    width="stretch",
    height="content",
)
