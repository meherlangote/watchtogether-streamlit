# WatchTogether — Streamlit Cloud Edition 🎬

A deployable watch-party app for 2–10 friends. Watch a local movie file together (each person selects the same file from their own computer — the movie stays local in the browser) or watch a YouTube video together. Only small synchronization, chat, presence, and WebRTC signaling messages are sent through Supabase Realtime.

## What this version includes

- Create a watch room with a random `WATCH-XXXXXX` code
- Shareable invite URL (`?room=WATCH-XXXXXX`)
- Join by room code or invite link
- Two watch sources, chosen by the host:
  - **Local movie file** — browser-only file picker, verified against the host's copy (see below)
  - **YouTube video** — host pastes a link or video ID; guests join the same video automatically, no upload or extra secret required
- Browser-only local movie picker (`<input type="file">`)
- Local playback with `URL.createObjectURL(file)`
- Incremental full-file SHA-256 fingerprinting in 16 MB chunks
- File name, size, duration, and SHA-256 verification
- Host-controlled play / pause / seek / playback speed
- Host-clock synchronization with RTT/clock-offset estimation
- Drift correction:
  - `<100 ms`: no correction
  - `100–500 ms`: smooth playback-rate correction
  - `>500 ms`: authoritative seek with cooldown
- Manual **Sync Now**
- Supabase Realtime Presence for participants
- Supabase Realtime Broadcast for playback, chat, room control, and signaling
- WebRTC mesh camera + microphone
- STUN support + optional TURN configuration
- Host transfer when the current host leaves
- Host lock, remove-participant, mute-request, and end-room controls
- Realtime text chat
- Responsive dark cinema UI
- No user accounts or database schema required

## Privacy model

The movie file is **never uploaded to Streamlit or Supabase**.

The browser performs:

```text
<input type="file">
       ↓
File object (browser only)
       ↓
URL.createObjectURL(file)
       ↓
HTML5 <video>
```

The browser also hashes the local file. Realtime messages contain only small metadata/control objects such as:

```text
SHA-256 fingerprint
filename
file size
duration
play/pause/seek state
chat text
WebRTC offer/answer/ICE signaling
presence metadata
```

There is intentionally no upload endpoint and no `st.file_uploader` for movies.

---

# Deploy on Streamlit Community Cloud

## 1. Create a free Supabase project

Go to Supabase and create a project.

You do **not** need to create any database tables for this edition. It uses public Realtime Broadcast + Presence channels.

From the Supabase project dashboard, copy:

- Project URL
- Publishable key (or legacy anon key)

**Never use the `service_role` key in this app.**

## 2. Put this project on GitHub

Your repository should look like:

```text
watchtogether-streamlit/
├── .streamlit/
│   └── config.toml
├── tests/
│   └── test_privacy_static.py
├── .gitignore
├── component.css
├── component.html
├── component.js
├── README.md
├── requirements.txt
├── secrets.example.toml
└── streamlit_app.py
```

## 3. Create the Streamlit app

1. Open Streamlit Community Cloud.
2. Click **Create app**.
3. Select your GitHub repository.
4. Set the entrypoint to:

```text
streamlit_app.py
```

5. Open **Advanced settings → Secrets**.
6. Paste:

```toml
SUPABASE_URL = "https://YOUR_PROJECT.supabase.co"
SUPABASE_KEY = "YOUR_PUBLISHABLE_OR_ANON_KEY"

STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302"
]

# Optional but recommended for reliable webcam/mic connectivity:
TURN_URL = ""
TURN_USERNAME = ""
TURN_PASSWORD = ""
```

7. Click **Deploy**.

That is all the server-side setup required.

---

# How normal users use it

No terminal commands are required.

### Host

1. Open your Streamlit app.
2. Click **Create Watch Room**.
3. Enter your name.
4. Copy/share the invite link.
5. Click **Choose What To Watch**.
6. Pick **Local File** (choose a movie from the browser file picker, wait for SHA-256 verification) or **YouTube** (paste a video link or ID, click **Use this video**).
7. Enter the watch room.
8. Optionally enable camera and microphone.
9. Play/pause/seek.

### Friend

1. Open the invite link.
2. Enter their name.
3. Join the room.
4. If the host chose a local file: choose their own local copy of the exact same movie and wait for the SHA-256 comparison. If the host chose YouTube: nothing to pick — the same video loads automatically.
5. Enter the watch room.
6. Optionally enable camera and microphone.

For local-file rooms, each computer decodes its own original local file. For YouTube rooms, everyone streams the same public video directly from YouTube.

---

# Why Supabase Realtime is used

Streamlit hosts the UI shell. The browser connects directly to Supabase Realtime for lightweight realtime traffic.

```text
Streamlit Cloud
     │
     │ serves app/component
     ▼
Browser A ───────── Supabase Realtime ───────── Browser B
  │                       │                         │
  │ local movie           │ sync/chat/signaling    │ local movie
  │                       │                         │
  └──────────── WebRTC camera + microphone ────────┘
```

The movie is not in either network path.

---

# Synchronization design

The current host is authoritative.

A playback snapshot looks conceptually like:

```json
{
  "playing": true,
  "position": 125.42,
  "rate": 1.0,
  "hostTimestamp": 1787904000123,
  "revision": 84
}
```

Participants estimate their clock offset relative to the host using a small ping/pong exchange and RTT measurements. The expected movie position is then calculated from the host timestamp.

Correction policy:

```text
absolute drift < 100 ms
    → do nothing

100–500 ms
    → temporarily adjust playbackRate up/down by at most ~4%

> 500 ms
    → seek to the authoritative position
       then apply a cooldown to avoid repeated jumping
```

The host also sends a lightweight playback snapshot every ~3 seconds and on important playback events.

---

# WebRTC design

Each participant uses `RTCPeerConnection` directly in the browser.

WebRTC transports only:

- webcam video
- microphone audio

Supabase Realtime transports only WebRTC signaling:

- offer
- answer
- ICE candidates
- renegotiation requests

The local movie is never added to a peer connection.

For 2–5 users this browser mesh topology is practical. At 6–10 users, CPU/bandwidth use can become significant. A future larger-room version should use an SFU such as LiveKit, mediasoup, or Janus for webcam/microphone while still keeping movie playback local.

---

# TURN server

STUN is enough on many home networks. Some corporate, carrier-grade NAT, school, hotel, or restrictive networks require TURN.

If webcam/microphone works between some users but not others, configure a TURN service through Streamlit Secrets:

```toml
TURN_URL = "turn:your-turn.example.com:3478"
TURN_USERNAME = "username"
TURN_PASSWORD = "password"
```

For a public production deployment, prefer short-lived TURN credentials rather than permanent shared credentials.

---

# Browser notes

- The app must run on HTTPS for camera/microphone access. `streamlit.app` deployments satisfy this.
- Codec support depends on the user's browser. A local MKV file can still fail to play if the browser does not support its video/audio codecs.
- Chrome/Edge generally provide the broadest experience for this V1.
- Picture-in-picture is shown only when the browser supports it.

---

# Security notes for this simple V1

This edition is optimized for private watch parties between trusted friends and simple Streamlit deployment.

- Room codes are random and effectively act as shared room secrets.
- Realtime channels are public because there are no user accounts.
- Host/moderation identity is enforced by the application protocol, not by cryptographic authentication.
- Do not use this exact public-channel model for hostile/public internet communities where participants may deliberately modify the client.

For a hardened public service, add Supabase Auth + private Realtime channels + Realtime Authorization/RLS and server-signed room membership.

---

# Testing

The included static privacy tests verify that:

- no Streamlit movie uploader exists
- movies use local object URLs
- movie bytes/FormData are not sent through realtime code
- WebRTC camera/microphone APIs exist

Run in development with:

```text
python -m unittest discover -s tests -v
```

This command is only for development/testing. Normal users never need it.

A simple manual two-user test is to open the deployed app in two browser windows (or two devices), create a room in one, join from the other, and select the same local movie in both.

---

# Files

- `streamlit_app.py` — Streamlit entrypoint and safe secret/config handoff
- `component.html` — component root
- `component.css` — complete responsive cinema UI
- `component.js` — rooms, hashing, playback sync, WebRTC, chat, reconnect and moderation
- `requirements.txt` — Streamlit dependency
- `secrets.example.toml` — deployment secret template
- `.streamlit/config.toml` — dark Streamlit shell configuration
- `tests/test_privacy_static.py` — privacy-boundary regression tests
