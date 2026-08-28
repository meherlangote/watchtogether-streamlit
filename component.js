const CDN_SUPABASE = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
const CDN_HASH = "https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/+esm";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const esc = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );

  return `${(bytes / Math.pow(1024, i)).toFixed(i > 2 ? 2 : 1)} ${units[i]}`;
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  return h > 0
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function randomRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  const bytes = crypto.getRandomValues(
    new Uint8Array(6)
  );

  return (
    "WATCH-" +
    Array.from(
      bytes,
      (b) => alphabet[b % alphabet.length]
    ).join("")
  );
}

function safeRoomCode(value) {
  const code = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");

  return code.startsWith("WATCH-")
    ? code.slice(0, 18)
    : code.slice(0, 18);
}

class WatchTogetherApp {
  constructor(root, config) {
    this.root = root;

    this.config =
      config || {};

    this.supabase = null;

    this.hashWasm = null;

    this.channel = null;

    /*
      IMPORTANT:

      Always trust the room code currently visible
      in the browser URL.

      Streamlit can temporarily retain the previous
      roomFromUrl value after JavaScript removes ?room=.

      That was causing:

      Leave
        ↓
      Home page
        ↓
      Automatically reconnect old room
    */

    const browserRoom = (() => {
      try {
        return safeRoomCode(
          new URL(window.location.href)
            .searchParams
            .get("room") || ""
        );
      } catch {
        return "";
      }
    })();

    this.phase =
      browserRoom
        ? "join"
        : "landing";

    this.peerId =
      crypto.randomUUID();

    this.name =
      "";

    this.roomCode =
      browserRoom;

    this.creating =
      false;

    this.connected =
      false;

    this.connectionStatus =
      "offline";

    this.participants =
      new Map();

    this.previousParticipantIds =
      new Set();

    this.hostId =
      null;

    this.isHost =
      false;

    this.joinedAt =
      Date.now();

    this.locked =
      false;

    this.lockedAt =
      0;

    /*
      MOVIE
    */

    this.file =
      null;

    this.fileUrl =
      "";

    this.fileHash =
      "";

    this.fileDuration =
      0;

    this.hashProgress =
      0;

    this.hashing =
      false;

    this.verified =
      false;

    this.verifyMessage =
      "";

    /*
      CAMERA + MICROPHONE
    */

    this.localStream =
      null;

    this.microphoneDevices =
      [];

    this.micDeviceId =
      "";

    this.remoteStreams =
      new Map();

    this.pcs =
      new Map();

    this.iceQueues =
      new Map();

    this.micEnabled =
      false;

    this.camEnabled =
      false;

    /*
      CHAT / SYNC
    */

    this.chat =
      [];

    this.authoritative =
      null;

    this.revision =
      0;

    this.lastAppliedRevision =
      -1;

    this.clockSamples =
      [];

    this.clockOffset =
      0;

    this.clockRtt =
      null;

    this.seekCooldownUntil =
      0;

    this.driftMs =
      0;

    this.syncLabel =
      "Waiting for playback";

    this.syncTimer =
      null;

    this.uiTimer =
      null;

    this.clockTimer =
      null;

    this.reconnectTimer =
      null;

    /*
      Prevent reconnect after user intentionally
      leaves or host ends a room.
    */

    this.intentionalDisconnect =
      false;

    this.destroyed =
      false;

    this.video =
      null;

    this.selectedAudioTrackIndex = 0;

    /*
      MOVIE AUDIO

      Movie remains entirely local.

      Compatibility mode:

      5.1 / 7.1
          ↓
      stereo downmix
          ↓
      speakers / headphones
    */

    this.audioContext =
      null;

    this.movieAudioSource =
      null;

    this.movieAudioNodes =
      [];

    this.movieAudioMaster =
      null;

    this.movieAudioMode =
      "compat";

    this.movieVolume =
      1;
  }

  async init() {
    this.renderLoading(
      "Loading realtime services…"
    );

    try {
      const [
        supabaseModule,
        hashModule,
      ] =
        await Promise.all([
          import(CDN_SUPABASE),
          import(CDN_HASH),
        ]);

      this.hashWasm =
        hashModule;

      this.supabase =
        supabaseModule.createClient(
          this.config.supabaseUrl,
          this.config.supabaseKey,
          {
            auth: {
              persistSession:
                false,

              autoRefreshToken:
                false,

              detectSessionInUrl:
                false,
            },

            realtime: {
              params: {
                eventsPerSecond:
                  20,
              },
            },
          }
        );

      this.render();

    } catch (error) {
      console.error(
        "WatchTogether startup error",
        error
      );

      this.renderFatal(
        "We couldn't start WatchTogether. Check the app's Supabase settings and refresh the page."
      );
    }
  }

  updateConfig(config) {
    this.config = {
      ...this.config,
      ...(config || {}),
    };

    /*
      Browser URL is always authoritative.

      This prevents stale Streamlit query data
      from reopening an old room.
    */

    try {
      this.config.roomFromUrl =
        safeRoomCode(
          new URL(window.location.href)
            .searchParams
            .get("room") || ""
        );

    } catch {
      this.config.roomFromUrl =
        "";
    }
  }

  renderLoading(text) {
    this.root.innerHTML = `
      <div class="wt-loading">
        <div class="wt-logo-mark">
          ▶
        </div>

        <div>
          <strong>
            WatchTogether
          </strong>

          <span>
            ${esc(text)}
          </span>
        </div>
      </div>
    `;
  }

  renderFatal(text) {
    this.root.innerHTML = `
      <div class="wt-shell">

        <div class="wt-stage">

          <div class="wt-modal-card wt-center">

            <div class="wt-file-icon">
              ⚠️
            </div>

            <h2>
              Something went wrong
            </h2>

            <p>
              ${esc(text)}
            </p>

            <button
              class="wt-btn primary"
              id="fatal-reload"
            >
              Try Again
            </button>

          </div>

        </div>

      </div>
    `;

    this.root
      .querySelector(
        "#fatal-reload"
      )
      ?.addEventListener(
        "click",
        () => location.reload()
      );
  }

  topbar() {
    const conn =
      this.connectionStatus ===
      "connected"
        ? `
          <span class="wt-pill">
            <i class="wt-dot"></i>
            Connected
          </span>
        `
        : this.connectionStatus ===
          "reconnecting"
          ? `
            <span class="wt-pill">
              <i class="wt-dot yellow"></i>
              Reconnecting…
            </span>
          `
          : `
            <span class="wt-pill">
              <i class="wt-dot red"></i>
              Offline
            </span>
          `;

    const room =
      this.roomCode
        ? `
          <span class="wt-pill room-pill">
            Room&nbsp;
            <strong>
              ${esc(this.roomCode)}
            </strong>
          </span>
        `
        : "";

    return `
      <header class="wt-topbar">

        <div class="wt-brand">

          <div class="wt-logo-mark">
            ▶
          </div>

          <span>
            WatchTogether
          </span>

        </div>

        <div class="wt-top-actions">

          ${room}

          ${
            this.channel
              ? conn
              : ""
          }

        </div>

      </header>
    `;
  }

  render() {
    if (
      this.destroyed
    ) {
      return;
    }

    if (
      this.phase ===
      "landing"
    ) {
      return this.renderLanding();
    }

    if (
      this.phase ===
      "create"
    ) {
      return this.renderCreate();
    }

    if (
      this.phase ===
      "join"
    ) {
      return this.renderJoin();
    }

    if (
      this.phase ===
      "connecting"
    ) {
      return this.renderConnecting();
    }

    if (
      this.phase ===
      "lobby"
    ) {
      return this.renderLobby();
    }

    if (
      this.phase ===
      "movie"
    ) {
      return this.renderMovieSelect();
    }

    if (
      this.phase ===
      "watch"
    ) {
      return this.renderWatch();
    }
  }

  renderLanding() {
    this.root.innerHTML = `
      <div class="wt-shell">

        ${this.topbar()}

        <section class="wt-hero">

          <div>

            <span class="wt-eyebrow">
              🔒 Local movie playback · realtime with friends
            </span>

            <h1>
              Watch Movies Together.
              <br>

              <span class="wt-gradient">
                From Anywhere.
              </span>
            </h1>

            <p class="wt-hero-copy">
              Play the movie locally on your computer.
              Stay synchronized with your friends.
              Your movie never leaves your device.
            </p>

            <div class="wt-actions">

              <button
                class="wt-btn primary"
                id="create-room"
              >
                ＋ Create Watch Room
              </button>

              <button
                class="wt-btn secondary"
                id="join-room"
              >
                Join Watch Room
              </button>

            </div>

            <div class="wt-privacy">

              🛡️

              <span>
                No movie upload.
                We only synchronize playback,
                chat, camera and microphone.
              </span>

            </div>

          </div>

          <div
            class="wt-hero-card"
            aria-hidden="true"
          >

            <div class="wt-fake-player">

              <div class="wt-play-orb">
                ▶
              </div>

            </div>

            <div class="wt-mini-row">

              <div class="wt-mini-face">
                👑 You
              </div>

              <div class="wt-mini-face">
                📹 Friend
              </div>

              <div class="wt-mini-face">
                🎤 Friend
              </div>

            </div>

          </div>

        </section>

        <section class="wt-features">

          <div class="wt-feature">
            <div class="icon">
              🎬
            </div>

            <strong>
              Local Playback
            </strong>

            <span>
              Your movie stays on your device.
            </span>
          </div>

          <div class="wt-feature">
            <div class="icon">
              ⚡
            </div>

            <strong>
              Smart Sync
            </strong>

            <span>
              Play, pause, seek and drift correction.
            </span>
          </div>

          <div class="wt-feature">
            <div class="icon">
              📹
            </div>

            <strong>
              See Your Friends
            </strong>

            <span>
              Peer-to-peer camera and microphone.
            </span>
          </div>

          <div class="wt-feature">
            <div class="icon">
              💬
            </div>

            <strong>
              Live Chat
            </strong>

            <span>
              Talk without leaving the movie.
            </span>
          </div>

          <div class="wt-feature">
            <div class="icon">
              🔒
            </div>

            <strong>
              Private Movie
            </strong>

            <span>
              Movie bytes never go to Streamlit or Supabase.
            </span>
          </div>

        </section>

      </div>
    `;

    this.root
      .querySelector(
        "#create-room"
      )
      ?.addEventListener(
        "click",
        () => {
          this.phase =
            "create";

          this.render();
        }
      );

    this.root
      .querySelector(
        "#join-room"
      )
      ?.addEventListener(
        "click",
        () => {
          this.phase =
            "join";

          this.render();
        }
      );
  }

  renderCreate() {
    this.root.innerHTML = `
      <div class="wt-shell">

        ${this.topbar()}

        <div class="wt-stage">

          <form
            class="wt-modal-card"
            id="create-form"
          >

            <h2>
              Create Watch Room
            </h2>

            <p>
              Start a private room
              and invite up to 9 friends.
            </p>

            <div class="wt-form-row">

              <label
                for="create-name"
              >
                Your name
              </label>

              <input
                class="wt-input"
                id="create-name"
                maxlength="40"
                required
                placeholder="e.g. Rahul"
                autocomplete="name"
              >

            </div>

            <div class="wt-modal-actions">

              <button
                type="button"
                class="wt-btn secondary"
                id="back"
              >
                Back
              </button>

              <button
                class="wt-btn primary"
                type="submit"
              >
                Create Room
              </button>

            </div>

          </form>

        </div>

      </div>
    `;

    this.root
      .querySelector(
        "#back"
      )
      ?.addEventListener(
        "click",
        () => {
          this.phase =
            "landing";

          this.render();
        }
      );

    this.root
      .querySelector(
        "#create-form"
      )
      ?.addEventListener(
        "submit",
        async (e) => {
          e.preventDefault();

          const name =
            this.root
              .querySelector(
                "#create-name"
              )
              ?.value
              .trim();

          if (!name) {
            return;
          }

          await this.joinRoom(
            randomRoomCode(),
            name,
            true
          );
        }
      );
  }

  renderJoin() {
    this.root.innerHTML = `
      <div class="wt-shell">

        ${this.topbar()}

        <div class="wt-stage">

          <form
            class="wt-modal-card"
            id="join-form"
          >

            <h2>
              Join Watch Room
            </h2>

            <p>
              Enter the room code
              your friend shared with you.
            </p>

            <div class="wt-form-row">

              <label
                for="join-code"
              >
                Room code
              </label>

              <input
                class="wt-input code"
                id="join-code"
                maxlength="18"
                required
                value="${esc(this.roomCode)}"
                placeholder="WATCH-8F42AB"
                autocomplete="off"
              >

            </div>

            <div class="wt-form-row">

              <label
                for="join-name"
              >
                Your name
              </label>

              <input
                class="wt-input"
                id="join-name"
                maxlength="40"
                required
                placeholder="Your name"
                autocomplete="name"
              >

            </div>

            <div class="wt-modal-actions">

              <button
                type="button"
                class="wt-btn secondary"
                id="back"
              >
                Back
              </button>

              <button
                class="wt-btn primary"
                type="submit"
              >
                Join Room
              </button>

            </div>

          </form>

        </div>

      </div>
    `;

    this.root
      .querySelector(
        "#back"
      )
      ?.addEventListener(
        "click",
        () => {
          this.phase =
            "landing";

          this.roomCode =
            "";

          this.updateUrl(
            ""
          );

          this.render();
        }
      );

    this.root
      .querySelector(
        "#join-form"
      )
      ?.addEventListener(
        "submit",
        async (e) => {
          e.preventDefault();

          const code =
            safeRoomCode(
              this.root
                .querySelector(
                  "#join-code"
                )
                ?.value ||
                ""
            );

          const name =
            this.root
              .querySelector(
                "#join-name"
              )
              ?.value
              .trim();

          if (
            !code ||
            !name
          ) {
            return;
          }

          await this.joinRoom(
            code,
            name,
            false
          );
        }
      );
  }

  renderConnecting() {
    this.root.innerHTML = `
      <div class="wt-shell">

        ${this.topbar()}

        <div class="wt-stage">

          <div class="wt-modal-card wt-center">

            <div class="wt-file-icon">
              ✨
            </div>

            <h2>
              ${
                this.creating
                  ? "Creating your room…"
                  : "Joining room…"
              }
            </h2>

            <p>
              Connecting securely
              to the watch party.
            </p>

          </div>

        </div>

      </div>
    `;
  }

  async joinRoom(
    code,
    name,
    creating
  ) {
    await this.leaveRoom(
      false
    );

    /*
      We are intentionally entering a new room,
      so reconnect protection can be enabled again.
    */

    this.intentionalDisconnect =
      false;

    this.roomCode =
      safeRoomCode(
        code
      );

    this.name =
      String(name).slice(
        0,
        40
      );

    this.creating =
      creating;

    this.joinedAt =
      Date.now();

    this.phase =
      "connecting";

    this.connectionStatus =
      "reconnecting";

    this.render();

    const channel =
      this.supabase.channel(
        `watchtogether:${this.roomCode}`,
        {
          config: {
            presence: {
              key:
                this.peerId,
            },

            broadcast: {
              ack:
                true,

              self:
                false,
            },
          },
        }
      );

    this.channel =
      channel;

    const onBroadcast =
      (
        event,
        handler
      ) =>
        channel.on(
          "broadcast",
          {
            event,
          },
          (message) =>
            handler(
              message?.payload ??
              message
            )
        );

    onBroadcast(
      "chat",
      (p) =>
        this.onChat(p)
    );

    onBroadcast(
      "playback",
      (p) =>
        this.onPlayback(p)
    );

    onBroadcast(
      "state-request",
      (p) =>
        this.onStateRequest(p)
    );

    onBroadcast(
      "clock-ping",
      (p) =>
        this.onClockPing(p)
    );

    onBroadcast(
      "clock-pong",
      (p) =>
        this.onClockPong(p)
    );

    onBroadcast(
      "signal",
      (p) =>
        this.onSignal(p)
    );

    onBroadcast(
      "renegotiate",
      (p) =>
        this.onRenegotiate(p)
    );

    onBroadcast(
      "kick",
      (p) =>
        this.onKick(p)
    );

    onBroadcast(
      "room-control",
      (p) =>
        this.onRoomControl(p)
    );

    onBroadcast(
      "moderation-mute",
      (p) =>
        this.onModerationMute(p)
    );

    onBroadcast(
      "end-room",
      (p) =>
        this.onEndRoom(p)
    );

    channel
      .on(
        "presence",
        {
          event:
            "sync",
        },
        () =>
          this.onPresenceSync()
      )
      .subscribe(
        async (status) => {
          if (
            this.channel !==
            channel
          ) {
            return;
          }

          if (
            status ===
            "SUBSCRIBED"
          ) {
            this.connected =
              true;

            this.connectionStatus =
              "connected";

            await this.trackPresence();

            if (
              creating
            ) {
              this.participants.set(
                this.peerId,
                {
                  peerId:
                    this.peerId,

                  name:
                    this.name,

                  joinedAt:
                    this.joinedAt,

                  creator:
                    true,

                  movieHash:
                    this.fileHash ||
                    "",

                  movieName:
                    this.file?.name ||
                    "",

                  movieSize:
                    this.file?.size ||
                    0,

                  movieDuration:
                    this.fileDuration ||
                    0,

                  mic:
                    this.micEnabled,

                  cam:
                    this.camEnabled,
                }
              );

              this.hostId =
                this.peerId;

              this.isHost =
                true;
            }

            this.updateUrl(
              this.roomCode
            );

            this.phase =
              "lobby";

            this.render();

            if (
              !creating
            ) {
              await sleep(
                2800
              );

              if (
                this.channel !==
                channel
              ) {
                return;
              }

              if (
                this.participants.size <=
                1
              ) {
                this.toast(
                  "Room not found. Ask the host for a fresh invite link.",
                  "bad"
                );

                await this.leaveRoom(
                  false
                );

                this.phase =
                  "join";

                this.connectionStatus =
                  "offline";

                this.render();

                return;
              }
            }

            this.send(
              "state-request",
              {
                from:
                  this.peerId,
              }
            );

            this.syncClock();

          } else if (
            [
              "CHANNEL_ERROR",
              "TIMED_OUT",
            ].includes(
              status
            )
          ) {
            this.connectionStatus =
              "reconnecting";

            this.updateTopStatus();

          } else if (
            status ===
              "CLOSED" &&
            !this.destroyed &&
            !this.intentionalDisconnect &&
            this.channel ===
              channel
          ) {
            /*
              Only reconnect when the channel unexpectedly
              disconnects.

              Do NOT reconnect after Leave / End Room.
            */

            this.connectionStatus =
              "reconnecting";

            this.updateTopStatus();

            this.scheduleReconnect();
          }
        }
      );
  }

  async trackPresence() {
    if (
      !this.channel
    ) {
      return;
    }

    try {
      await this.channel.track({
        peerId:
          this.peerId,

        name:
          this.name,

        joinedAt:
          this.joinedAt,

        creator:
          Boolean(
            this.creating
          ),

        movieHash:
          this.fileHash ||
          "",

        movieName:
          this.file?.name ||
          "",

        movieSize:
          this.file?.size ||
          0,

        movieDuration:
          this.fileDuration ||
          0,

        mic:
          Boolean(
            this.micEnabled
          ),

        cam:
          Boolean(
            this.camEnabled
          ),
      });

    } catch (error) {
      console.warn(
        "Presence update failed",
        error
      );
    }
  }

  onPresenceSync() {
    if (
      !this.channel
    ) {
      return;
    }

    const raw =
      this.channel.presenceState();

    const next =
      new Map();

    for (
      const [
        key,
        values,
      ] of
      Object.entries(
        raw || {}
      )
    ) {
      for (
        const presence
        of
        values || []
      ) {
        const id =
          presence.peerId ||
          key;

        if (!id) {
          continue;
        }

        const existing =
          next.get(id);

        if (
          !existing ||
          Number(
            presence.joinedAt ||
            0
          ) >=
            Number(
              existing.joinedAt ||
              0
            )
        ) {
          next.set(
            id,
            {
              peerId:
                id,

              name:
                String(
                  presence.name ||
                  "Guest"
                ).slice(
                  0,
                  40
                ),

              joinedAt:
                Number(
                  presence.joinedAt ||
                  Date.now()
                ),

              creator:
                Boolean(
                  presence.creator
                ),

              movieHash:
                presence.movieHash ||
                "",

              movieName:
                presence.movieName ||
                "",

              movieSize:
                Number(
                  presence.movieSize ||
                  0
                ),

              movieDuration:
                Number(
                  presence.movieDuration ||
                  0
                ),

              mic:
                Boolean(
                  presence.mic
                ),

              cam:
                Boolean(
                  presence.cam
                ),
            }
          );
        }
      }
    }

    this.participants =
      next;

    if (
      next.size >
        10 &&
      next.has(
        this.peerId
      )
    ) {
      this.toast(
        "This room already has 10 people.",
        "bad"
      );

      this.leaveRoom(
        true
      );

      return;
    }

    const sorted =
      [
        ...next.values(),
      ].sort(
        (
          a,
          b
        ) =>
          Number(
            b.creator
          ) -
            Number(
              a.creator
            ) ||
          a.peerId.localeCompare(
            b.peerId
          )
      );

    const oldHost =
      this.hostId;

    this.hostId =
      sorted[0]?.peerId ||
      null;

    this.isHost =
      this.hostId ===
      this.peerId;

    const currentIds =
      new Set(
        next.keys()
      );

    for (
      const id
      of
      currentIds
    ) {
      if (
        id ===
          this.peerId ||
        this.previousParticipantIds.has(
          id
        )
      ) {
        continue;
      }

      if (
        this.isHost &&
        this.locked &&
        (
          next.get(id)?.joinedAt ||
          0
        ) >=
          this.lockedAt
      ) {
        this.send(
          "kick",
          {
            to:
              id,

            from:
              this.peerId,

            reason:
              "This room is locked.",
          }
        );

        continue;
      }

      this.ensurePeerHandshake(
        id
      );
    }

    for (
      const id
      of
      this.previousParticipantIds
    ) {
      if (
        !currentIds.has(
          id
        )
      ) {
        this.closePeer(
          id
        );
      }
    }

    this.previousParticipantIds =
      currentIds;

    if (
      oldHost !==
        this.hostId &&
      this.hostId
    ) {
      this.clockSamples =
        [];

      this.clockOffset =
        0;

      this.clockRtt =
        null;

      if (
        this.isHost
      ) {
        if (
          oldHost
        ) {
          this.toast(
            "You are now the host 👑",
            "good"
          );
        }

        this.broadcastPlayback(
          "host-transfer"
        );

      } else {
        if (
          oldHost
        ) {
          this.toast(
            `${
              next.get(
                this.hostId
              )?.name ||
              "A participant"
            } is now the host.`,
            "good"
          );
        }

        this.syncClock();

        this.send(
          "state-request",
          {
            from:
              this.peerId,
          }
        );
      }
    }

    this.verifyAgainstHost();

    if (
      this.phase ===
      "lobby"
    ) {
      this.updateLobbyParticipants();
    }

    if (
      this.phase ===
      "watch"
    ) {
      this.updatePeopleUI();

      this.updateWatchControlsRole();

      this.updateTopStatus();
    }
  }

  ensurePeerHandshake(
    peerId
  ) {
    if (
      !peerId ||
      peerId ===
        this.peerId
    ) {
      return;
    }

    this.ensurePC(
      peerId
    );

    if (
      this.peerId.localeCompare(
        peerId
      ) < 0
    ) {
      setTimeout(
        () =>
          this.makeOffer(
            peerId
          ),

        200 +
          Math.random() *
            300
      );
    }
  }

  renderLobby() {
    const title =
      this.creating
        ? "Room Created ✓"
        : "You're in ✓";

    this.root.innerHTML = `
      <div class="wt-shell">

        ${this.topbar()}

        <div class="wt-stage">

          <div class="wt-modal-card wt-center">

            <div class="wt-file-icon">
              ${
                this.isHost
                  ? "👑"
                  : "🎉"
              }
            </div>

            <h2>
              ${title}
            </h2>

            <p>
              ${
                this.isHost
                  ? "Share this invite, then choose your local copy of the movie."
                  : "Choose the same local movie file as the host."
              }
            </p>

            <div class="wt-room-code">
              ${esc(this.roomCode)}
            </div>

            <div
              class="wt-actions"
              style="justify-content:center"
            >

              <button
                class="wt-btn secondary small"
                id="copy-invite"
              >
                🔗 Copy Invite Link
              </button>

              <button
                class="wt-btn secondary small"
                id="share-invite"
              >
                ↗ Share
              </button>

            </div>

            <div
              class="wt-user-list"
              id="lobby-users"
            ></div>

            <div class="wt-modal-actions">

              <button
                class="wt-btn danger"
                type="button"
                id="leave-room"
              >
                Leave
              </button>

              <button
                class="wt-btn primary"
                type="button"
                id="choose-movie"
              >
                🎬 Choose Movie
              </button>

            </div>

          </div>

        </div>

      </div>
    `;

    this.updateLobbyParticipants();

    this.root
      .querySelector(
        "#copy-invite"
      )
      ?.addEventListener(
        "click",
        () =>
          this.copyInvite()
      );

    this.root
      .querySelector(
        "#share-invite"
      )
      ?.addEventListener(
        "click",
        () =>
          this.shareInvite()
      );

    this.root
      .querySelector(
        "#choose-movie"
      )
      ?.addEventListener(
        "click",
        () => {
          this.phase =
            "movie";

          this.render();
        }
      );

    this.root
      .querySelector(
        "#leave-room"
      )
      ?.addEventListener(
        "click",
        () =>
          this.leaveRoom(
            true
          )
      );
  }

  updateLobbyParticipants() {
    const box =
      this.root.querySelector(
        "#lobby-users"
      );

    if (!box) {
      return;
    }

    const sorted =
      [
        ...this.participants.values(),
      ].sort(
        (
          a,
          b
        ) =>
          a.joinedAt -
          b.joinedAt
      );

    box.innerHTML =
      sorted
        .map(
          (p) => `
            <div class="wt-user-line">

              <div class="wt-user-main">

                <div class="wt-avatar">
                  👤
                </div>

                <span>
                  ${esc(
                    p.peerId ===
                      this.peerId
                      ? `${p.name} (You)`
                      : p.name
                  )}
                </span>

              </div>

              ${
                p.peerId ===
                this.hostId
                  ? `
                    <span class="wt-badge">
                      👑 HOST
                    </span>
                  `
                  : ""
              }

            </div>
          `
        )
        .join("") ||
      `
        <div class="wt-muted">
          Waiting for others to join…
        </div>
      `;
  }

  inviteUrl() {
    const url =
      new URL(
        window.location.href
      );

    url.searchParams.set(
      "room",
      this.roomCode
    );

    return url.toString();
  }

  async copyInvite() {
    try {
      await navigator.clipboard.writeText(
        this.inviteUrl()
      );

      this.toast(
        "Invite link copied ✓",
        "good"
      );

    } catch {
      this.toast(
        `Share room code ${this.roomCode}`,
        "good"
      );
    }
  }

  async shareInvite() {
    const url =
      this.inviteUrl();

    if (
      navigator.share
    ) {
      try {
        await navigator.share({
          title:
            "WatchTogether",

          text:
            `Join my WatchTogether room ${this.roomCode}`,

          url,
        });

        return;

      } catch {}
    }

    await this.copyInvite();
  }

  renderMovieSelect() {
    const host =
      this.participants.get(
        this.hostId
      );

    const hostText =
      host?.movieHash
        ? `Host selected: ${esc(
            host.movieName ||
            "movie"
          )}`
        : "Waiting for the host to select a movie";

    const status =
      this.hashing
        ? `
          <div class="wt-status-box">

            Checking movie…

            <strong id="hash-percent">
              ${Math.round(
                this.hashProgress
              )}%
            </strong>

            <div class="wt-progress">

              <i
                id="hash-progress"
                style="width:${this.hashProgress}%"
              ></i>

            </div>

          </div>
        `
        : this.fileHash
          ? `
            <div class="wt-status-box ${
              this.verified
                ? "good"
                : "bad"
            }">

              ${
                this.verified
                  ? "✓"
                  : "⚠"
              }

              ${esc(
                this.verifyMessage
              )}

            </div>
          `
          : `
            <div class="wt-status-box">
              ${hostText}
            </div>
          `;

    this.root.innerHTML = `
      <div class="wt-shell">

        ${this.topbar()}

        <div class="wt-stage">

          <div class="wt-modal-card">

            <h2>
              Choose Your Movie
            </h2>

            <p>
              Your browser reads this file locally.
              The movie is never uploaded to Streamlit or Supabase.
            </p>

            <label
              class="wt-file-drop"
              for="movie-file"
            >

              <div>

                <div class="wt-file-icon">
                  🎬
                </div>

                <h3>
                  ${
                    this.file
                      ? esc(
                          this.file.name
                        )
                      : "Select your movie file"
                  }
                </h3>

                <p class="wt-muted">
                  ${
                    this.file
                      ? `${formatBytes(
                          this.file.size
                        )} · ${formatTime(
                          this.fileDuration
                        )}`
                      : "MP4, WebM and other formats supported by your browser"
                  }
                </p>

                <span class="wt-btn secondary small">
                  Choose Movie
                </span>

              </div>

            </label>

            <input
              class="wt-hidden"
              id="movie-file"
              type="file"
              accept="video/*,.mkv,.mp4,.webm,.mov,.m4v"
            >

            ${status}

            <div class="wt-modal-actions">

              <button
                class="wt-btn secondary"
                type="button"
                id="movie-back"
              >
                Back
              </button>

              <button
                class="wt-btn primary"
                type="button"
                id="enter-watch"
                ${
                  this.verified
                    ? ""
                    : "disabled"
                }
              >
                Enter Watch Room
              </button>

            </div>

          </div>

        </div>

      </div>
    `;

    this.root
      .querySelector(
        "#movie-back"
      )
      ?.addEventListener(
        "click",
        () => {
          this.phase =
            "lobby";

          this.render();
        }
      );

    this.root
      .querySelector(
        "#movie-file"
      )
      ?.addEventListener(
        "change",
        (e) =>
          this.selectMovie(
            e.target.files?.[0]
          )
      );

    this.root
      .querySelector(
        "#enter-watch"
      )
      ?.addEventListener(
        "click",
        () => {
          if (
            !this.verified
          ) {
            return;
          }

          this.phase =
            "watch";

          this.render();
        }
      );
  }

  async selectMovie(file) {
    if (!file) {
      return;
    }

    this.file =
      file;

    if (
      this.fileUrl
    ) {
      URL.revokeObjectURL(
        this.fileUrl
      );
    }

    /*
      CRITICAL PRIVACY REQUIREMENT

      Movie stays local.

      No FormData.
      No upload.
      No Supabase storage.
      No FastAPI endpoint.
    */

    this.fileUrl =
      URL.createObjectURL(
        file
      );

    this.fileHash =
      "";

    this.fileDuration =
      0;

    this.verified =
      false;

    this.verifyMessage =
      "Checking file…";

    this.hashing =
      true;

    this.hashProgress =
      0;

    this.renderMovieSelect();

    try {
      this.fileDuration =
        await this.readDuration(
          this.fileUrl
        );

      const hasher =
        await this.hashWasm.createSHA256();

      hasher.init();

      const chunkSize =
        16 *
        1024 *
        1024;

      for (
        let offset = 0;
        offset < file.size;
        offset += chunkSize
      ) {
        const end =
          Math.min(
            file.size,
            offset +
              chunkSize
          );

        const buffer =
          await file
            .slice(
              offset,
              end
            )
            .arrayBuffer();

        hasher.update(
          new Uint8Array(
            buffer
          )
        );

        this.hashProgress =
          (
            end /
            file.size
          ) *
          100;

        const bar =
          this.root.querySelector(
            "#hash-progress"
          );

        const label =
          this.root.querySelector(
            "#hash-percent"
          );

        if (bar) {
          bar.style.width =
            `${this.hashProgress}%`;
        }

        if (label) {
          label.textContent =
            `${Math.round(
              this.hashProgress
            )}%`;
        }

        await sleep(
          0
        );
      }

      this.fileHash =
        hasher.digest(
          "hex"
        );

      this.hashing =
        false;

      this.hashProgress =
        100;

      await this.trackPresence();

      this.verifyAgainstHost();

      this.renderMovieSelect();

    } catch (error) {
      console.error(
        "Movie fingerprint failed",
        error
      );

      this.hashing =
        false;

      this.fileHash =
        "";

      this.verified =
        false;

      this.verifyMessage =
        "We couldn't check this file. Try selecting it again.";

      this.renderMovieSelect();
    }
  }

  readDuration(url) {
    return new Promise(
      (resolve) => {
        const probe =
          document.createElement(
            "video"
          );

        probe.preload =
          "metadata";

        probe.src =
          url;

        probe.onloadedmetadata =
          () => {
            const duration =
              Number(
                probe.duration
              ) ||
              0;

            probe.removeAttribute(
              "src"
            );

            resolve(
              duration
            );
          };

        probe.onerror =
          () =>
            resolve(
              0
            );
      }
    );
  }

  verifyAgainstHost() {
    if (
      !this.fileHash
    ) {
      return;
    }

    if (
      this.isHost
    ) {
      this.verified =
        true;

      this.verifyMessage =
        "File verified. Friends will compare their fingerprint with yours.";

      return;
    }

    const host =
      this.participants.get(
        this.hostId
      );

    if (
      !host?.movieHash
    ) {
      this.verified =
        false;

      this.verifyMessage =
        "File verified locally. Waiting for the host to select their movie.";

      return;
    }

    if (
      host.movieHash ===
      this.fileHash
    ) {
      const durationClose =
        !host.movieDuration ||
        !this.fileDuration ||
        Math.abs(
          host.movieDuration -
          this.fileDuration
        ) < 1.5;

      const sizeSame =
        !host.movieSize ||
        host.movieSize ===
          this.file.size;

      this.verified =
        durationClose &&
        sizeSame;

      this.verifyMessage =
        this.verified
          ? "Same movie detected ✓"
          : "The fingerprint matches, but file metadata differs. Please use the exact same file.";

    } else {
      this.verified =
        false;

      this.verifyMessage =
        "Different movie file. You and the host must select the exact same movie.";
    }

    if (
      this.phase ===
        "movie" &&
      !this.hashing
    ) {
      const status =
        this.root.querySelector(
          ".wt-status-box"
        );

      if (status) {
        status.className =
          `wt-status-box ${
            this.verified
              ? "good"
              : "bad"
          }`;

        status.textContent =
          `${
            this.verified
              ? "✓"
              : "⚠"
          } ${this.verifyMessage}`;
      }

      const enter =
        this.root.querySelector(
          "#enter-watch"
        );

      if (enter) {
        enter.disabled =
          !this.verified;
      }
    }
  }

  renderWatch() {
    this.root.innerHTML = `
      <div class="wt-shell wt-watch">

        ${this.topbar()}

        <div class="wt-watch-grid">

          <main class="wt-player-card">

            <div class="wt-video-wrap">

              <video
                class="wt-video"
                id="movie-video"
                playsinline
                preload="metadata"
              ></video>

              <div
                class="wt-video-empty"
                id="video-empty"
              >

                <div>

                  <span class="big">
                    🎬
                  </span>

                  Loading your local movie…

                </div>

              </div>

              <div class="wt-player-overlay">

                <span class="wt-local-note">
                  🔒 Playing locally · only playback is synchronized
                </span>

              </div>

            </div>

            <div class="wt-controls">

              <button
                class="wt-icon-btn"
                id="play-btn"
                aria-label="Play or pause"
                ${
                  this.isHost
                    ? ""
                    : "disabled"
                }
              >
                ▶
              </button>

              <div class="wt-timeline">

                <span
                  class="wt-time"
                  id="current-time"
                >
                  00:00
                </span>

                <input
                  class="wt-range"
                  id="timeline"
                  type="range"
                  min="0"
                  max="${this.fileDuration || 1}"
                  step="0.05"
                  value="0"
                  ${
                    this.isHost
                      ? ""
                      : "disabled"
                  }
                >

                <span class="wt-time">
                  ${formatTime(
                    this.fileDuration
                  )}
                </span>

              </div>

              <div class="wt-control-right">

                <span aria-hidden="true">
                  🔊
                </span>

                <input
                  class="wt-volume"
                  id="volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value="${this.movieVolume}"
                  aria-label="Volume"
                >

                <select
                  class="wt-speed"
                  id="audio-mode"
                  aria-label="Movie audio mode"
                  title="Stereo Compatibility mixes surround channels into stereo so music and effects are not lost"
                >

                  <option
                    value="compat"
                    ${
                      this.movieAudioMode ===
                      "compat"
                        ? "selected"
                        : ""
                    }
                  >
                    🎧 Stereo
                  </option>

                  <option
                    value="native"
                    ${
                      this.movieAudioMode ===
                      "native"
                        ? "selected"
                        : ""
                    }
                  >
                    🔊 Native
                  </option>

                </select>
                
                <select
                    class="wt-speed"
                    id="audio-track"
                    aria-label="Audio language"
                    title="Choose your movie audio language"
                  >
                    <option value="">
                      🔈 Audio
                    </option>
                  </select>

                                  <select
                  class="wt-speed"
                  id="speed"
                  aria-label="Playback speed"
                  ${
                    this.isHost
                      ? ""
                      : "disabled"
                  }
                >

                  <option value="0.75">
                    0.75×
                  </option>

                  <option
                    value="1"
                    selected
                  >
                    1×
                  </option>

                  <option value="1.25">
                    1.25×
                  </option>

                  <option value="1.5">
                    1.5×
                  </option>

                  <option value="2">
                    2×
                  </option>

                </select>

                <button
                  class="wt-icon-btn"
                  id="pip-btn"
                  aria-label="Picture in picture"
                >
                  ▣
                </button>

                <button
                  class="wt-icon-btn"
                  id="full-btn"
                  aria-label="Fullscreen"
                >
                  ⛶
                </button>

              </div>

            </div>

          </main>

          <aside class="wt-side">

            <section class="wt-side-card">

              <div class="wt-side-head">

                <strong>
                  People
                </strong>

                <span id="people-count">
                  ${this.participants.size}/10
                </span>

              </div>

              <div
                class="wt-people-grid"
                id="people-grid"
              ></div>

            </section>

            <section class="wt-side-card wt-chat">

              <div class="wt-side-head">

                <strong>
                  Chat
                </strong>

                <span>
                  Live
                </span>

              </div>

              <div
                class="wt-messages"
                id="messages"
              ></div>

              <form
                class="wt-chat-form"
                id="chat-form"
              >

                <input
                  id="chat-input"
                  maxlength="500"
                  placeholder="Type a message…"
                  autocomplete="off"
                >

                <button
                  class="wt-btn primary small"
                  type="submit"
                >
                  Send
                </button>

              </form>

            </section>

          </aside>

        </div>

        <div class="wt-bottom-bar">

          <div class="wt-media-actions">

            <button
              class="wt-btn secondary small"
              id="enable-camera"
            >
              📹 Enable camera
            </button>

            <button
              class="wt-btn secondary small"
              id="enable-mic"
            >
              🎤 Enable microphone
            </button>

            <select
              class="wt-speed"
              id="mic-device"
              aria-label="Microphone source"
              title="If Bluetooth movie audio becomes low quality, choose your computer's built-in microphone"
            >
              <option value="">
                Mic source
              </option>
            </select>

            <button
              class="wt-btn secondary small"
              id="mic-btn"
              disabled
            >
              🎤 Mic off
            </button>

            <button
              class="wt-btn secondary small"
              id="cam-btn"
              disabled
            >
              📷 Camera off
            </button>

            ${
              this.isHost
                ? `
                  <button
                    class="wt-btn secondary small"
                    id="lock-btn"
                  >
                    ${
                      this.locked
                        ? "🔒 Unlock room"
                        : "🔓 Lock room"
                    }
                  </button>

                  <button
                    class="wt-btn danger small"
                    id="end-btn"
                  >
                    End room
                  </button>
                `
                : ""
            }

          </div>

          <div class="wt-sync">

            <span id="sync-label">
              ${esc(this.syncLabel)}
            </span>

            <button
              class="wt-btn secondary small"
              id="sync-now"
            >
              ↻ Sync Now
            </button>

          </div>

        </div>

      </div>

      <div
        class="wt-toast-stack"
        id="toast-stack"
      ></div>
    `;

    this.video =
      this.root.querySelector(
        "#movie-video"
      );

    this.video.src =
      this.fileUrl;

    /*
      Activate local surround → stereo compatibility.

      This does not send movie audio anywhere.
    */

    this.setupMovieAudio()
      .catch(
        (error) => {
          console.warn(
            "Movie audio compatibility mode could not start",
            error
          );

          this.toast(
            "Using your browser's normal movie audio output.",
            "bad"
          );
        }
      );

    this.video.addEventListener(
  "loadedmetadata",
  () => {
    this.root
      .querySelector(
        "#video-empty"
      )
      ?.classList.add(
        "wt-hidden"
      );

    const timeline =
      this.root.querySelector(
        "#timeline"
      );

    if (
      timeline
    ) {
      timeline.max =
        String(
          this.video.duration ||
          this.fileDuration ||
          1
        );
    }

    /*
      AUDIO LANGUAGE TRACKS

      After the browser reads the movie metadata,
      check whether it exposes multiple audio tracks.
    */

    this.refreshAudioTrackSelector();

    const tracks =
      this.video.audioTracks;

    if (
      tracks?.addEventListener
    ) {
      tracks.addEventListener(
        "addtrack",
        () =>
          this.refreshAudioTrackSelector()
      );

      tracks.addEventListener(
        "removetrack",
        () =>
          this.refreshAudioTrackSelector()
      );

      tracks.addEventListener(
        "change",
        () =>
          this.refreshAudioTrackSelector()
      );
    }

    /*
      Participant asks host for current
      playback state after movie loads.
    */

    if (
      !this.isHost
    ) {
      this.send(
        "state-request",
        {
          from:
            this.peerId,
        }
      );
    }
  }
);
    this.video.addEventListener(
      "play",
      () => {
        this.resumeMovieAudio();

        if (
          this.isHost
        ) {
          this.broadcastPlayback(
            "play"
          );
        }

        this.updatePlayIcon();
      }
    );

    this.video.addEventListener(
      "pause",
      () => {
        if (
          this.isHost
        ) {
          this.broadcastPlayback(
            "pause"
          );
        }

        this.updatePlayIcon();
      }
    );

    this.video.addEventListener(
      "seeked",
      () => {
        if (
          this.isHost
        ) {
          this.broadcastPlayback(
            "seek"
          );
        }
      }
    );

    this.video.addEventListener(
      "ratechange",
      () => {
        if (
          this.isHost
        ) {
          this.broadcastPlayback(
            "rate"
          );
        }
      }
    );

    this.root
      .querySelector(
        "#play-btn"
      )
      ?.addEventListener(
        "click",
        async () => {
          if (
            !this.isHost
          ) {
            return;
          }

          await this.resumeMovieAudio();

          if (
            this.video.paused
          ) {
            await this.video
              .play()
              .catch(
                () => {}
              );

          } else {
            this.video.pause();
          }
        }
      );

    this.root
      .querySelector(
        "#timeline"
      )
      ?.addEventListener(
        "input",
        (e) => {
          if (
            this.isHost
          ) {
            this.video.currentTime =
              Number(
                e.target.value ||
                0
              );
          }
        }
      );

    this.root
      .querySelector(
        "#volume"
      )
      ?.addEventListener(
        "input",
        (e) =>
          this.setMovieVolume(
            Number(
              e.target.value
            )
          )
      );

    this.root
      .querySelector(
        "#audio-mode"
      )
      ?.addEventListener(
        "change",
        async (e) => {
          await this.setMovieAudioMode(
            String(
              e.target.value ||
              "compat"
            )
          );
        }
      );

    this.root
      .querySelector(
        "#speed"
      )
      ?.addEventListener(
        "change",
        (e) => {
          if (
            this.isHost
          ) {
            this.video.playbackRate =
              Number(
                e.target.value ||
                1
              );
          }
        }
      );

    this.root
      .querySelector(
        "#full-btn"
      )
      ?.addEventListener(
        "click",
        () =>
          this.root
            .querySelector(
              ".wt-video-wrap"
            )
            ?.requestFullscreen?.()
      );

    this.root
      .querySelector(
        "#pip-btn"
      )
      ?.addEventListener(
        "click",
        async () => {
          try {
            if (
              document.pictureInPictureElement
            ) {
              await document.exitPictureInPicture();

            } else if (
              document.pictureInPictureEnabled
            ) {
              await this.video.requestPictureInPicture();
            }

          } catch {
            this.toast(
              "Picture-in-picture isn't available in this browser.",
              "bad"
            );
          }
        }
      );

    this.root
      .querySelector(
        "#chat-form"
      )
      ?.addEventListener(
        "submit",
        (e) =>
          this.sendChat(
            e
          )
      );

    /*
      CAMERA AND MICROPHONE ARE NOW SEPARATE.

      This is important because activating a Bluetooth
      headset microphone can switch the headset into
      low-quality hands-free audio mode.
    */

    this.root
      .querySelector(
        "#enable-camera"
      )
      ?.addEventListener(
        "click",
        () =>
          this.enableCamera()
      );

    this.root
      .querySelector(
        "#enable-mic"
      )
      ?.addEventListener(
        "click",
        () =>
          this.enableMicrophone()
      );

    this.root
      .querySelector(
        "#mic-device"
      )
      ?.addEventListener(
        "change",
        (e) => {
          const deviceId =
            String(
              e.target.value ||
              ""
            );

          if (
            deviceId
          ) {
            this.enableMicrophone(
              deviceId,
              true
            );
          }
        }
      );

    this.root
      .querySelector(
        "#mic-btn"
      )
      ?.addEventListener(
        "click",
        () =>
          this.toggleMic()
      );

    this.root
      .querySelector(
        "#cam-btn"
      )
      ?.addEventListener(
        "click",
        () =>
          this.toggleCam()
      );

    this.root
      .querySelector(
        "#sync-now"
      )
      ?.addEventListener(
        "click",
        () =>
          this.syncNow()
      );

    this.root
      .querySelector(
        "#lock-btn"
      )
      ?.addEventListener(
        "click",
        () =>
          this.toggleLock()
      );

    this.root
      .querySelector(
        "#end-btn"
      )
      ?.addEventListener(
        "click",
        () =>
          this.endRoom()
      );

    this.updatePeopleUI();

    this.renderMessages();

    this.startWatchTimers();

    this.updateWatchControlsRole();

    this.updateMediaButtons();

    this.renderMicrophoneChoices();

    if (
      !this.isHost
    ) {
      this.syncClock();

      this.send(
        "state-request",
        {
          from:
            this.peerId,
        }
      );

    } else {
      this.broadcastPlayback(
        "watch-enter"
      );
    }
  }

  async setupMovieAudio() {
    if (
      !this.video ||
      this.movieAudioSource
    ) {
      return;
    }

    const AudioContextClass =
      window.AudioContext ||
      window.webkitAudioContext;

    if (
      !AudioContextClass
    ) {
      this.movieAudioMode =
        "native";

      return;
    }

    try {
      this.audioContext =
        new AudioContextClass({
          latencyHint:
            "playback",
        });

      this.movieAudioSource =
        this.audioContext
          .createMediaElementSource(
            this.video
          );

      /*
        HTML video volume remains 1.

        Our Web Audio GainNode controls
        final volume instead.
      */

      this.video.volume =
        1;

      await this.rebuildMovieAudioGraph(
        this.movieAudioMode
      );

      await this.resumeMovieAudio();

    } catch (error) {
      /*
        Never allow complete silence if the
        compatibility graph fails.
      */

      try {
        this.movieAudioSource
          ?.disconnect();

        this.movieAudioSource
          ?.connect(
            this.audioContext.destination
          );

      } catch {}

      this.movieAudioMode =
        "native";

      throw error;
    }
  }

  async resumeMovieAudio() {
    try {
      if (
        this.audioContext?.state ===
        "suspended"
      ) {
        await this.audioContext.resume();
      }

    } catch {}
  }

  setMovieVolume(value) {
    this.movieVolume =
      clamp(
        Number(value) ||
          0,
        0,
        1
      );

    if (
      this.movieAudioMaster &&
      this.audioContext
    ) {
      this.movieAudioMaster
        .gain
        .setTargetAtTime(
          this.movieVolume,
          this.audioContext.currentTime,
          0.01
        );

    } else if (
      this.video
    ) {
      this.video.volume =
        this.movieVolume;
    }
  }

  async setMovieAudioMode(
    mode
  ) {
    this.movieAudioMode =
      mode ===
      "native"
        ? "native"
        : "compat";

    if (
      !this.movieAudioSource
    ) {
      await this.setupMovieAudio();

      return;
    }

    await this.resumeMovieAudio();

    await this.rebuildMovieAudioGraph(
      this.movieAudioMode
    );

    this.toast(
      this.movieAudioMode ===
        "compat"
        ? "Stereo Compatibility enabled — surround music and effects are mixed into stereo."
        : "Native movie audio enabled.",
      "good"
    );
  }

  disconnectMovieAudioGraph() {
    try {
      this.movieAudioSource
        ?.disconnect();

    } catch {}

    for (
      const node
      of
      this.movieAudioNodes
    ) {
      try {
        node.disconnect();

      } catch {}
    }

    this.movieAudioNodes =
      [];

    this.movieAudioMaster =
      null;
  }

  async rebuildMovieAudioGraph(
    mode
  ) {
    if (
      !this.audioContext ||
      !this.movieAudioSource
    ) {
      return;
    }

    this.disconnectMovieAudioGraph();

    const ctx =
      this.audioContext;

    const master =
      ctx.createGain();

    master.gain.value =
      this.movieVolume;

    this.movieAudioMaster =
      master;

    this.movieAudioNodes.push(
      master
    );

    if (
      mode ===
      "native"
    ) {
      this.movieAudioSource.connect(
        master
      );

      master.connect(
        ctx.destination
      );

      return;
    }

    /*
      SURROUND → STEREO

      Typical 5.1:

      0 Front Left
      1 Front Right
      2 Center
      3 LFE
      4 Surround Left
      5 Surround Right

      Common 7.1:

      6 Back Left
      7 Back Right
    */

    const splitter =
      ctx.createChannelSplitter(
        8
      );

    const merger =
      ctx.createChannelMerger(
        2
      );

    const compressor =
      ctx.createDynamicsCompressor();

    compressor.threshold.value =
      -10;

    compressor.knee.value =
      12;

    compressor.ratio.value =
      4;

    compressor.attack.value =
      0.003;

    compressor.release.value =
      0.25;

    this.movieAudioNodes.push(
      splitter,
      merger,
      compressor
    );

    this.movieAudioSource.connect(
      splitter
    );

    const route =
      (
        channel,
        output,
        gainValue
      ) => {
        const gain =
          ctx.createGain();

        gain.gain.value =
          gainValue;

        splitter.connect(
          gain,
          channel
        );

        gain.connect(
          merger,
          0,
          output
        );

        this.movieAudioNodes.push(
          gain
        );
      };

    /*
      Front
    */

    route(
      0,
      0,
      0.70
    );

    route(
      1,
      1,
      0.70
    );

    /*
      Center dialogue
    */

    route(
      2,
      0,
      0.50
    );

    route(
      2,
      1,
      0.50
    );

    /*
      LFE / bass
    */

    route(
      3,
      0,
      0.10
    );

    route(
      3,
      1,
      0.10
    );

    /*
      Surround channels
      contain BGM / ambience / effects
    */

    route(
      4,
      0,
      0.50
    );

    route(
      5,
      1,
      0.50
    );

    /*
      7.1 rear
    */

    route(
      6,
      0,
      0.35
    );

    route(
      7,
      1,
      0.35
    );

    merger.connect(
      compressor
    );

    compressor.connect(
      master
    );

    master.connect(
      ctx.destination
    );
  }

  cleanupMovieAudio() {
    this.disconnectMovieAudioGraph();

    try {
      this.movieAudioSource
        ?.disconnect();

    } catch {}

    this.movieAudioSource =
      null;

    const ctx =
      this.audioContext;

    this.audioContext =
      null;

    if (
      ctx &&
      ctx.state !==
        "closed"
    ) {
      try {
        ctx.close();

      } catch {}
    }
  }

  languageName(code = "") {
  const normalized =
    String(code || "")
      .trim()
      .toLowerCase();

  if (!normalized) {
    return "";
  }

  const languages = {
    en: "English",
    eng: "English",

    hi: "Hindi",
    hin: "Hindi",

    ta: "Tamil",
    tam: "Tamil",

    te: "Telugu",
    tel: "Telugu",

    ml: "Malayalam",
    mal: "Malayalam",

    kn: "Kannada",
    kan: "Kannada",

    bn: "Bengali",
    ben: "Bengali",

    mr: "Marathi",
    mar: "Marathi",

    gu: "Gujarati",
    guj: "Gujarati",

    pa: "Punjabi",
    pan: "Punjabi",

    ur: "Urdu",
    urd: "Urdu",

    ja: "Japanese",
    jpn: "Japanese",

    ko: "Korean",
    kor: "Korean",

    zh: "Chinese",
    zho: "Chinese",
    chi: "Chinese",

    es: "Spanish",
    spa: "Spanish",

    fr: "French",
    fra: "French",
    fre: "French",

    de: "German",
    deu: "German",
    ger: "German",

    it: "Italian",
    ita: "Italian",

    pt: "Portuguese",
    por: "Portuguese",

    ru: "Russian",
    rus: "Russian",

    ar: "Arabic",
    ara: "Arabic",
  };

  if (
    languages[normalized]
  ) {
    return languages[
      normalized
    ];
  }

  try {
    const display =
      new Intl.DisplayNames(
        [
          navigator.language ||
          "en",
        ],
        {
          type:
            "language",
        }
      );

    return (
      display.of(
        normalized
      ) ||
      normalized.toUpperCase()
    );

  } catch {
    return normalized.toUpperCase();
  }
}


audioTrackLabel(
  track,
  index
) {
  const language =
    this.languageName(
      track?.language ||
      ""
    );

  const label =
    String(
      track?.label ||
      ""
    ).trim();

  if (
    language &&
    label &&
    !label
      .toLowerCase()
      .includes(
        language.toLowerCase()
      )
  ) {
    return `${language} · ${label}`;
  }

  if (language) {
    return language;
  }

  if (label) {
    return label;
  }

  return `Audio ${index + 1}`;
}


refreshAudioTrackSelector() {
  const select =
    this.root.querySelector(
      "#audio-track"
    );

  if (
    !select ||
    !this.video
  ) {
    return;
  }

  const tracks =
    this.video.audioTracks;

  /*
    Some browsers, especially Chrome with
    certain MKV files, don't expose
    HTMLMediaElement.audioTracks.

    In that situation we leave playback alone.
  */

  if (
    !tracks ||
    typeof tracks.length !==
      "number" ||
    tracks.length === 0
  ) {
    select.innerHTML = `
      <option value="">
        🔈 Browser audio
      </option>
    `;

    select.disabled =
      true;

    select.title =
      "This browser does not expose the embedded audio tracks of this movie.";

    return;
  }

  let enabledIndex =
    -1;

  const options =
    [];

  for (
    let i = 0;
    i < tracks.length;
    i += 1
  ) {
    const track =
      tracks[i];

    if (
      track?.enabled
    ) {
      enabledIndex =
        i;
    }

    const label =
      this.audioTrackLabel(
        track,
        i
      );

    options.push(`
      <option value="${i}">
        ${esc(label)}
      </option>
    `);
  }

  if (
    enabledIndex < 0
  ) {
    enabledIndex =
      clamp(
        this.selectedAudioTrackIndex ||
        0,
        0,
        tracks.length -
        1
      );
  }

  this.selectedAudioTrackIndex =
    enabledIndex;

  select.innerHTML =
    options.join("");

  select.value =
    String(
      enabledIndex
    );

  /*
    If the file contains only one exposed
    audio track there is nothing to switch.
  */

  select.disabled =
    tracks.length <
    2;

  if (
    tracks.length >
    1
  ) {
    select.title =
      "Choose your audio language. This choice affects only you.";

  } else {
    select.title =
      "Only one audio track is available.";
  }
}


selectAudioTrack(index) {
  if (
    !this.video
  ) {
    return;
  }

  const tracks =
    this.video.audioTracks;

  if (
    !tracks ||
    index < 0 ||
    index >=
      tracks.length
  ) {
    this.toast(
      "This browser does not expose that movie audio track.",
      "bad"
    );

    return;
  }

  try {
    /*
      Disable all tracks except the
      user's selected language.
    */

    for (
      let i = 0;
      i < tracks.length;
      i += 1
    ) {
      tracks[i].enabled =
        i ===
        index;
    }

    this.selectedAudioTrackIndex =
      index;

    const selected =
      tracks[index];

    const name =
      this.audioTrackLabel(
        selected,
        index
      );

    this.refreshAudioTrackSelector();

    this.toast(
      `Audio changed to ${name} ✓`,
      "good"
    );

  } catch (error) {
    console.warn(
      "Audio track switching is not available",
      error
    );

    this.toast(
      "Your browser does not allow audio-track switching for this movie.",
      "bad"
    );
  }
}


  updatePlayIcon() {
    const btn =
      this.root.querySelector(
        "#play-btn"
      );

    if (
      btn &&
      this.video
    ) {
      btn.textContent =
        this.video.paused
          ? "▶"
          : "⏸";
    }
  }

  startWatchTimers() {
    clearInterval(
      this.syncTimer
    );

    clearInterval(
      this.uiTimer
    );

    this.syncTimer =
      setInterval(
        () => {
          if (
            this.phase !==
              "watch" ||
            !this.video
          ) {
            return;
          }

          if (
            this.isHost
          ) {
            this.broadcastPlayback(
              "periodic"
            );

          } else {
            this.applySync(
              false
            );
          }
        },
        3000
      );

    this.uiTimer =
      setInterval(
        () => {
          if (
            this.phase !==
              "watch" ||
            !this.video
          ) {
            return;
          }

          const current =
            this.root.querySelector(
              "#current-time"
            );

          const timeline =
            this.root.querySelector(
              "#timeline"
            );

          if (
            current
          ) {
            current.textContent =
              formatTime(
                this.video.currentTime
              );
          }

          if (
            timeline &&
            document.activeElement !==
              timeline
          ) {
            timeline.value =
              String(
                this.video.currentTime ||
                0
              );
          }

          this.updatePlayIcon();

          this.updateSyncLabel();
        },
        250
      );
  }

  playbackState() {
    if (
      !this.video
    ) {
      return null;
    }

    return {
      from:
        this.peerId,

      revision:
        ++this.revision,

      playing:
        !this.video.paused,

      position:
        Number(
          this.video.currentTime ||
          0
        ),

      rate:
        Number(
          this.video.playbackRate ||
          1
        ),

      hostTimestamp:
        Date.now(),

      duration:
        Number(
          this.video.duration ||
          this.fileDuration ||
          0
        ),
    };
  }

  broadcastPlayback(
    reason =
      "update"
  ) {
    if (
      !this.isHost ||
      !this.video ||
      !this.channel
    ) {
      return;
    }

    const state =
      this.playbackState();

    if (
      !state
    ) {
      return;
    }

    state.reason =
      reason;

    this.authoritative =
      state;

    this.send(
      "playback",
      state
    );
  }

  onPlayback(payload) {
    if (
      !payload ||
      payload.from !==
        this.hostId ||
      this.isHost
    ) {
      return;
    }

    if (
      Number(
        payload.revision
      ) <
      this.lastAppliedRevision
    ) {
      return;
    }

    this.lastAppliedRevision =
      Number(
        payload.revision ||
        0
      );

    this.authoritative =
      payload;

    if (
      this.phase ===
      "watch"
    ) {
      this.applySync(
        true
      );
    }
  }

  expectedPosition(state) {
    if (
      !state
    ) {
      return 0;
    }

    let expected =
      Number(
        state.position ||
        0
      );

    if (
      state.playing
    ) {
      const estimatedHostNow =
        Date.now() +
        this.clockOffset;

      const elapsed =
        Math.max(
          0,
          (
            estimatedHostNow -
            Number(
              state.hostTimestamp ||
              estimatedHostNow
            )
          ) /
            1000
        );

      expected +=
        elapsed *
        Number(
          state.rate ||
          1
        );
    }

    return clamp(
      expected,
      0,
      Number(
        state.duration ||
        this.fileDuration ||
        expected +
          1
      )
    );
  }

  async applySync(
    immediate
  ) {
    if (
      this.isHost ||
      !this.video ||
      !this.authoritative ||
      this.video.readyState <
        1
    ) {
      return;
    }

    const state =
      this.authoritative;

    const expected =
      this.expectedPosition(
        state
      );

    const drift =
      expected -
      this.video.currentTime;

    this.driftMs =
      Math.round(
        drift *
        1000
      );

    const baseRate =
      Number(
        state.rate ||
        1
      );

    if (
      state.playing &&
      this.video.paused
    ) {
      await this.video
        .play()
        .catch(
          () => {}
        );
    }

    if (
      !state.playing &&
      !this.video.paused
    ) {
      this.video.pause();
    }

    const abs =
      Math.abs(
        drift
      );

    if (
      abs >
        0.5 &&
      Date.now() >
        this.seekCooldownUntil
    ) {
      this.syncLabel =
        "Synchronizing…";

      this.video.currentTime =
        expected;

      this.video.playbackRate =
        baseRate;

      this.seekCooldownUntil =
        Date.now() +
        (
          immediate
            ? 1200
            : 2200
        );

    } else if (
      state.playing &&
      abs >=
        0.10
    ) {
      const correction =
        clamp(
          drift *
            0.08,
          -0.04,
          0.04
        );

      this.video.playbackRate =
        clamp(
          baseRate +
            correction,

          Math.max(
            0.25,
            baseRate *
              0.96
          ),

          Math.min(
            2,
            baseRate *
              1.04
          )
        );

    } else if (
      abs <
        0.07 &&
      Math.abs(
        this.video.playbackRate -
        baseRate
      ) >
        0.002
    ) {
      this.video.playbackRate =
        baseRate;
    }
  }

  updateSyncLabel() {
    const el =
      this.root.querySelector(
        "#sync-label"
      );

    if (
      !el
    ) {
      return;
    }

    if (
      this.isHost
    ) {
      this.syncLabel =
        "✓ Host · authoritative playback";

    } else if (
      !this.authoritative
    ) {
      this.syncLabel =
        "Waiting for host playback…";

    } else {
      const abs =
        Math.abs(
          this.driftMs
        );

      if (
        abs <
        100
      ) {
        this.syncLabel =
          "✓ Synced";

      } else if (
        this.driftMs >
        0
      ) {
        this.syncLabel =
          `⚠ ${abs}ms behind`;

      } else {
        this.syncLabel =
          `⚠ ${abs}ms ahead`;
      }
    }

    el.textContent =
      this.syncLabel;
  }

  async syncNow() {
    const btn =
      this.root.querySelector(
        "#sync-now"
      );

    if (
      btn
    ) {
      btn.disabled =
        true;

      btn.textContent =
        "Syncing…";
    }

    if (
      this.isHost
    ) {
      this.broadcastPlayback(
        "sync-now"
      );

    } else {
      await this.syncClock(
        true
      );

      this.send(
        "state-request",
        {
          from:
            this.peerId,
        }
      );

      await sleep(
        450
      );

      await this.applySync(
        true
      );
    }

    if (
      btn
    ) {
      btn.disabled =
        false;

      btn.textContent =
        "✓ Synchronized";

      setTimeout(
        () => {
          if (
            btn
          ) {
            btn.textContent =
              "↻ Sync Now";
          }
        },
        1400
      );
    }
  }

  onStateRequest(payload) {
    if (
      !this.isHost ||
      !payload?.from ||
      payload.from ===
        this.peerId
    ) {
      return;
    }

    this.broadcastPlayback(
      "state-request"
    );
  }

  async syncClock(
    force =
      false
  ) {
    if (
      this.isHost ||
      !this.channel ||
      !this.hostId
    ) {
      return;
    }

    if (
      this.clockTimer &&
      !force
    ) {
      return;
    }

    clearInterval(
      this.clockTimer
    );

    let sent =
      0;

    const ping =
      () => {
        if (
          !this.channel ||
          this.isHost ||
          !this.hostId ||
          sent >=
            5
        ) {
          clearInterval(
            this.clockTimer
          );

          this.clockTimer =
            null;

          return;
        }

        this.send(
          "clock-ping",
          {
            from:
              this.peerId,

            to:
              this.hostId,

            t0:
              Date.now(),
          }
        );

        sent +=
          1;
      };

    ping();

    this.clockTimer =
      setInterval(
        ping,
        500
      );
  }

  onClockPing(payload) {
    if (
      !this.isHost ||
      (
        payload?.to &&
        payload.to !==
          this.peerId
      ) ||
      !payload?.from
    ) {
      return;
    }

    this.send(
      "clock-pong",
      {
        from:
          this.peerId,

        to:
          payload.from,

        t0:
          payload.t0,

        hostTime:
          Date.now(),
      }
    );
  }

  onClockPong(payload) {
    if (
      payload?.to !==
        this.peerId ||
      payload.from !==
        this.hostId
    ) {
      return;
    }

    const t2 =
      Date.now();

    const t0 =
      Number(
        payload.t0 ||
        t2
      );

    const rtt =
      Math.max(
        0,
        t2 -
          t0
      );

    const offset =
      Number(
        payload.hostTime ||
        t2
      ) -
      (
        (
          t0 +
          t2
        ) /
        2
      );

    this.clockSamples.push({
      rtt,
      offset,
    });

    this.clockSamples =
      this.clockSamples.slice(
        -10
      );

    const best =
      [
        ...this.clockSamples,
      ].sort(
        (
          a,
          b
        ) =>
          a.rtt -
          b.rtt
      )[0];

    if (
      best
    ) {
      this.clockOffset =
        best.offset;

      this.clockRtt =
        best.rtt;
    }
  }

  sendChat(event) {
    event.preventDefault();

    const input =
      this.root.querySelector(
        "#chat-input"
      );

    const text =
      String(
        input?.value ||
        ""
      )
        .trim()
        .slice(
          0,
          500
        );

    if (
      !text
    ) {
      return;
    }

    const message = {
      id:
        crypto.randomUUID(),

      from:
        this.peerId,

      name:
        this.name,

      text,

      ts:
        Date.now(),
    };

    this.chat.push(
      message
    );

    this.chat =
      this.chat.slice(
        -150
      );

    this.renderMessages();

    this.send(
      "chat",
      message
    );

    input.value =
      "";
  }

  onChat(payload) {
    if (
      !payload?.text ||
      payload.from ===
        this.peerId
    ) {
      return;
    }

    this.chat.push({
      ...payload,

      text:
        String(
          payload.text
        ).slice(
          0,
          500
        ),

      name:
        String(
          payload.name ||
          "Guest"
        ).slice(
          0,
          40
        ),
    });

    this.chat =
      this.chat.slice(
        -150
      );

    if (
      this.phase ===
      "watch"
    ) {
      this.renderMessages();
    }
  }

  renderMessages() {
    const box =
      this.root.querySelector(
        "#messages"
      );

    if (
      !box
    ) {
      return;
    }

    box.innerHTML =
      this.chat.length
        ? this.chat
            .map(
              (m) => `
                <div class="wt-message">

                  <div class="wt-message-head">

                    <strong>
                      ${esc(
                        m.from ===
                          this.peerId
                          ? "You"
                          : m.name
                      )}
                    </strong>

                    <time>
                      ${
                        new Date(
                          m.ts ||
                          Date.now()
                        ).toLocaleTimeString(
                          [],
                          {
                            hour:
                              "2-digit",

                            minute:
                              "2-digit",
                          }
                        )
                      }
                    </time>

                  </div>

                  <p>
                    ${esc(m.text)}
                  </p>

                </div>
              `
            )
            .join("")
        : `
          <div
            class="wt-muted"
            style="font-size:11px"
          >
            Messages appear here.
            Movie content is never sent through chat.
          </div>
        `;

    box.scrollTop =
      box.scrollHeight;
  }

  iceServers() {
    const servers =
      [];

    const stun =
      Array.isArray(
        this.config.stunUrls
      )
        ? this.config.stunUrls
        : [
            this.config.stunUrls,
          ].filter(
            Boolean
          );

    if (
      stun.length
    ) {
      servers.push({
        urls:
          stun,
      });
    }

    if (
      this.config.turnUrl
    ) {
      servers.push({
        urls:
          this.config.turnUrl,

        username:
          this.config.turnUsername ||
          "",

        credential:
          this.config.turnPassword ||
          "",
      });
    }

    return servers;
  }

  ensurePC(peerId) {
    if (
      this.pcs.has(
        peerId
      )
    ) {
      return this.pcs.get(
        peerId
      );
    }

    const pc =
      new RTCPeerConnection({
        iceServers:
          this.iceServers(),

        bundlePolicy:
          "max-bundle",
      });

    this.pcs.set(
      peerId,
      pc
    );

    this.iceQueues.set(
      peerId,
      []
    );

    if (
      this.localStream
    ) {
      for (
        const track
        of
        this.localStream.getTracks()
      ) {
        pc.addTrack(
          track,
          this.localStream
        );
      }
    }

    pc.onicecandidate =
      (event) => {
        if (
          event.candidate
        ) {
          this.send(
            "signal",
            {
              from:
                this.peerId,

              to:
                peerId,

              kind:
                "candidate",

              candidate:
                event.candidate.toJSON?.() ||
                event.candidate,
            }
          );
        }
      };

    pc.ontrack =
      (event) => {
        const stream =
          event.streams?.[0] ||
          new MediaStream(
            [
              event.track,
            ]
          );

        this.remoteStreams.set(
          peerId,
          stream
        );

        if (
          this.phase ===
          "watch"
        ) {
          this.updatePeopleUI();
        }
      };

    pc.onconnectionstatechange =
      () => {
        if (
          [
            "failed",
            "disconnected",
          ].includes(
            pc.connectionState
          )
        ) {
          this.toast(
            `We couldn't connect to ${
              this.participants.get(
                peerId
              )?.name ||
              "a friend"
            }. Trying again…`,
            "bad"
          );

          if (
            this.peerId.localeCompare(
              peerId
            ) < 0
          ) {
            setTimeout(
              () =>
                this.restartIce(
                  peerId
                ),
              1000
            );
          }
        }

        if (
          pc.connectionState ===
          "closed"
        ) {
          this.remoteStreams.delete(
            peerId
          );
        }
      };

    return pc;
  }

  async makeOffer(
    peerId,
    iceRestart =
      false
  ) {
    const pc =
      this.ensurePC(
        peerId
      );

    if (
      !pc ||
      pc.signalingState !==
        "stable"
    ) {
      return;
    }

    try {
      const offer =
        await pc.createOffer({
          iceRestart,
        });

      await pc.setLocalDescription(
        offer
      );

      this.send(
        "signal",
        {
          from:
            this.peerId,

          to:
            peerId,

          kind:
            "offer",

          sdp:
            pc.localDescription,
        }
      );

    } catch (error) {
      console.warn(
        "Offer failed",
        error
      );
    }
  }

  async onSignal(payload) {
    if (
      !payload ||
      payload.to !==
        this.peerId ||
      !payload.from
    ) {
      return;
    }

    const peerId =
      payload.from;

    const pc =
      this.ensurePC(
        peerId
      );

    try {
      if (
        payload.kind ===
        "offer"
      ) {
        if (
          pc.signalingState !==
          "stable"
        ) {
          try {
            await pc.setLocalDescription({
              type:
                "rollback",
            });

          } catch {}
        }

        await pc.setRemoteDescription(
          payload.sdp
        );

        await this.flushIce(
          peerId
        );

        const answer =
          await pc.createAnswer();

        await pc.setLocalDescription(
          answer
        );

        this.send(
          "signal",
          {
            from:
              this.peerId,

            to:
              peerId,

            kind:
              "answer",

            sdp:
              pc.localDescription,
          }
        );

      } else if (
        payload.kind ===
        "answer"
      ) {
        if (
          pc.signalingState ===
          "have-local-offer"
        ) {
          await pc.setRemoteDescription(
            payload.sdp
          );

          await this.flushIce(
            peerId
          );
        }

      } else if (
        payload.kind ===
          "candidate" &&
        payload.candidate
      ) {
        if (
          pc.remoteDescription
        ) {
          await pc.addIceCandidate(
            payload.candidate
          );

        } else {
          this.iceQueues
            .get(
              peerId
            )
            ?.push(
              payload.candidate
            );
        }
      }

    } catch (error) {
      console.warn(
        "WebRTC signaling issue",
        error
      );
    }
  }

  async flushIce(
    peerId
  ) {
    const pc =
      this.pcs.get(
        peerId
      );

    const queue =
      this.iceQueues.get(
        peerId
      ) ||
      [];

    while (
      pc?.remoteDescription &&
      queue.length
    ) {
      const candidate =
        queue.shift();

      try {
        await pc.addIceCandidate(
          candidate
        );

      } catch {}
    }
  }

  onRenegotiate(payload) {
    if (
      payload?.to !==
        this.peerId ||
      !payload?.from
    ) {
      return;
    }

    if (
      this.peerId.localeCompare(
        payload.from
      ) < 0
    ) {
      this.makeOffer(
        payload.from
      );
    }
  }

  async restartIce(
    peerId
  ) {
    if (
      this.peerId.localeCompare(
        peerId
      ) < 0
    ) {
      await this.makeOffer(
        peerId,
        true
      );

    } else {
      this.send(
        "renegotiate",
        {
          from:
            this.peerId,

          to:
            peerId,
        }
      );
    }
  }

  ensureLocalStream() {
    if (
      !this.localStream
    ) {
      this.localStream =
        new MediaStream();
    }

    return this.localStream;
  }

  /*
    MICROPHONE SETTINGS

    The microphone is intentionally mono speech.

    autoGainControl = false reduces aggressive
    browser volume pumping.

    This processing affects ONLY microphone audio,
    never movie audio.
  */

  audioConstraints(
    deviceId =
      ""
  ) {
    const constraints = {
      echoCancellation: {
        ideal:
          true,
      },

      noiseSuppression: {
        ideal:
          true,
      },

      autoGainControl: {
        ideal:
          false,
      },

      channelCount: {
        ideal:
          1,
      },

      sampleRate: {
        ideal:
          48000,
      },
    };

    if (
      deviceId
    ) {
      constraints.deviceId = {
        exact:
          deviceId,
      };
    }

    return constraints;
  }

  looksLikeBluetoothMic(
    label =
      ""
  ) {
    return /(bluetooth|hands[- ]?free|headset|airpods|buds|earbuds|galaxy buds|wh-|wf-)/i.test(
      label
    );
  }

  looksLikeBuiltInMic(
    label =
      ""
  ) {
    return /(built[- ]?in|internal|microphone array|integrated|realtek|macbook|macbook pro|macbook air|internal microphone)/i.test(
      label
    );
  }

  async refreshMicrophones() {
    try {
      const devices =
        await navigator.mediaDevices.enumerateDevices();

      this.microphoneDevices =
        devices.filter(
          (d) =>
            d.kind ===
              "audioinput" &&
            d.deviceId
        );

      this.renderMicrophoneChoices();

      return this.microphoneDevices;

    } catch (error) {
      console.warn(
        "Could not list microphones",
        error
      );

      return [];
    }
  }

  renderMicrophoneChoices() {
    const select =
      this.root.querySelector(
        "#mic-device"
      );

    if (
      !select
    ) {
      return;
    }

    const current =
      this.micDeviceId ||
      select.value ||
      "";

    const options = [
      `
        <option value="">
          Mic source
        </option>
      `,

      ...this.microphoneDevices.map(
        (
          device,
          index
        ) => {
          const label =
            device.label ||
            `Microphone ${index + 1}`;

          const hint =
            this.looksLikeBluetoothMic(
              label
            )
              ? " · Bluetooth"
              : "";

          return `
            <option value="${esc(
              device.deviceId
            )}">
              ${esc(
                label +
                hint
              )}
            </option>
          `;
        }
      ),
    ];

    select.innerHTML =
      options.join("");

    if (
      current &&
      this.microphoneDevices.some(
        (d) =>
          d.deviceId ===
          current
      )
    ) {
      select.value =
        current;
    }
  }

  async publishLocalTrack(
    track
  ) {
    const stream =
      this.ensureLocalStream();

    const oldTrack =
      stream
        .getTracks()
        .find(
          (t) =>
            t.kind ===
            track.kind
        );

    for (
      const peerId
      of
      this.participants.keys()
    ) {
      if (
        peerId ===
        this.peerId
      ) {
        continue;
      }

      const pc =
        this.ensurePC(
          peerId
        );

      const sender =
        pc
          .getSenders()
          .find(
            (s) =>
              s.track ===
                oldTrack ||
              s.track?.kind ===
                track.kind
          );

      if (
        sender
      ) {
        try {
          await sender.replaceTrack(
            track
          );

        } catch (error) {
          console.warn(
            "Could not replace local media track",
            error
          );
        }

      } else {
        pc.addTrack(
          track,
          stream
        );

        if (
          this.peerId.localeCompare(
            peerId
          ) < 0
        ) {
          this.makeOffer(
            peerId
          );

        } else {
          this.send(
            "renegotiate",
            {
              from:
                this.peerId,

              to:
                peerId,
            }
          );
        }
      }
    }

    if (
      oldTrack
    ) {
      try {
        stream.removeTrack(
          oldTrack
        );

      } catch {}

      try {
        oldTrack.stop();

      } catch {}
    }

    stream.addTrack(
      track
    );
  }

  /*
    CAMERA IS REQUESTED SEPARATELY.

    audio:false prevents turning on the
    microphone just because the user wants video.
  */

  async enableCamera() {
    const existing =
      this.localStream
        ?.getVideoTracks()
        ?.[0];

    if (
      existing
    ) {
      existing.enabled =
        true;

      this.camEnabled =
        true;

      await this.trackPresence();

      this.updateMediaButtons();

      this.updatePeopleUI();

      return;
    }

    try {
      const stream =
        await navigator.mediaDevices.getUserMedia({
          video: {
            width: {
              ideal:
                640,
            },

            height: {
              ideal:
                360,
            },

            frameRate: {
              ideal:
                24,

              max:
                30,
            },
          },

          audio:
            false,
        });

      const track =
        stream
          .getVideoTracks()[0];

      if (
        !track
      ) {
        throw new Error(
          "No camera track returned"
        );
      }

      await this.publishLocalTrack(
        track
      );

      this.camEnabled =
        true;

      await this.trackPresence();

      this.updateMediaButtons();

      this.updatePeopleUI();

      this.toast(
        "Camera connected ✓",
        "good"
      );

    } catch (error) {
      console.warn(
        "Camera permission issue",
        error
      );

      this.toast(
        "Camera permission was not granted. You can still watch, talk and chat.",
        "bad"
      );
    }
  }

  /*
    MICROPHONE IS SEPARATE.

    If the user's default microphone is the
    Bluetooth headset microphone, WatchTogether tries
    to use a built-in/internal microphone instead.

    WHY?

    Bluetooth headset output:

      A2DP
      = high-quality stereo

    Bluetooth headset mic activated:

      HFP/HSP
      = low-quality communications audio

    Browser JavaScript cannot force Bluetooth hardware
    to remain in A2DP while using the same headset mic.

    The best solution is:

      Bluetooth headphones → movie output
      Laptop built-in mic → voice input
  */

  async enableMicrophone(
    requestedDeviceId =
      "",
    switching =
      false
  ) {
    try {
      let stream =
        await navigator.mediaDevices.getUserMedia({
          video:
            false,

          audio:
            this.audioConstraints(
              requestedDeviceId
            ),
        });

      let track =
        stream
          .getAudioTracks()[0];

      if (
        !track
      ) {
        throw new Error(
          "No microphone track returned"
        );
      }

      let devices =
        await this.refreshMicrophones();

      const initialDeviceId =
        track
          .getSettings?.()
          .deviceId ||
        requestedDeviceId ||
        "";

      const initialDevice =
        devices.find(
          (d) =>
            d.deviceId ===
            initialDeviceId
        );

      /*
        If default mic is Bluetooth,
        prefer built-in/internal mic.
      */

      if (
        !requestedDeviceId &&
        this.looksLikeBluetoothMic(
          initialDevice?.label ||
          ""
        )
      ) {
        const betterDevice =
          devices.find(
            (d) =>
              this.looksLikeBuiltInMic(
                d.label
              )
          ) ||
          devices.find(
            (d) =>
              !this.looksLikeBluetoothMic(
                d.label
              )
          );

        if (
          betterDevice &&
          betterDevice.deviceId !==
            initialDeviceId
        ) {
          try {
            track.stop();

          } catch {}

          stream =
            await navigator.mediaDevices.getUserMedia({
              video:
                false,

              audio:
                this.audioConstraints(
                  betterDevice.deviceId
                ),
            });

          track =
            stream
              .getAudioTracks()[0];

          requestedDeviceId =
            betterDevice.deviceId;
        }
      }

      if (
        "contentHint"
        in track
      ) {
        try {
          track.contentHint =
            "speech";

        } catch {}
      }

      this.micDeviceId =
        track
          .getSettings?.()
          .deviceId ||
        requestedDeviceId ||
        initialDeviceId ||
        "";

      await this.publishLocalTrack(
        track
      );

      this.micEnabled =
        true;

      await this.refreshMicrophones();

      await this.trackPresence();

      this.updateMediaButtons();

      this.updatePeopleUI();

      const selected =
        this.microphoneDevices.find(
          (d) =>
            d.deviceId ===
            this.micDeviceId
        );

      if (
        this.looksLikeBluetoothMic(
          selected?.label ||
          ""
        )
      ) {
        this.toast(
          "Bluetooth headset mic selected. If movie audio becomes low-quality, choose your computer's built-in microphone from Mic source.",
          "bad"
        );

      } else if (
        switching
      ) {
        this.toast(
          `Microphone changed to ${
            selected?.label ||
            "selected device"
          } ✓`,
          "good"
        );

      } else {
        this.toast(
          "Microphone connected ✓",
          "good"
        );
      }

    } catch (error) {
      console.warn(
        "Microphone permission issue",
        error
      );

      this.toast(
        "Microphone permission was not granted. You can still watch with camera and chat.",
        "bad"
      );
    }
  }

  toggleMic() {
    const track =
      this.localStream
        ?.getAudioTracks()
        ?.[0];

    if (
      !track
    ) {
      this.enableMicrophone();

      return;
    }

    track.enabled =
      !track.enabled;

    this.micEnabled =
      track.enabled;

    this.trackPresence();

    this.updateMediaButtons();

    this.updatePeopleUI();
  }

  toggleCam() {
    const track =
      this.localStream
        ?.getVideoTracks()
        ?.[0];

    if (
      !track
    ) {
      this.enableCamera();

      return;
    }

    track.enabled =
      !track.enabled;

    this.camEnabled =
      track.enabled;

    this.trackPresence();

    this.updateMediaButtons();

    this.updatePeopleUI();
  }

  updateMediaButtons() {
    const enableCamera =
      this.root.querySelector(
        "#enable-camera"
      );

    const enableMic =
      this.root.querySelector(
        "#enable-mic"
      );

    const mic =
      this.root.querySelector(
        "#mic-btn"
      );

    const cam =
      this.root.querySelector(
        "#cam-btn"
      );

    const audioTrack =
      this.localStream
        ?.getAudioTracks()
        ?.[0];

    const videoTrack =
      this.localStream
        ?.getVideoTracks()
        ?.[0];

    if (
      enableCamera
    ) {
      enableCamera.textContent =
        videoTrack
          ? "✓ Camera enabled"
          : "📹 Enable camera";

      enableCamera.disabled =
        Boolean(
          videoTrack
        );
    }

    if (
      enableMic
    ) {
      enableMic.textContent =
        audioTrack
          ? "✓ Microphone enabled"
          : "🎤 Enable microphone";

      enableMic.disabled =
        Boolean(
          audioTrack
        );
    }

    if (
      mic
    ) {
      mic.disabled =
        !audioTrack;

      mic.textContent =
        this.micEnabled
          ? "🎤 Mute"
          : "🔇 Unmute";
    }

    if (
      cam
    ) {
      cam.disabled =
        !videoTrack;

      cam.textContent =
        this.camEnabled
          ? "📷 Camera off"
          : "📷 Camera on";
    }
  }

  updatePeopleUI() {
    const grid =
      this.root.querySelector(
        "#people-grid"
      );

    const count =
      this.root.querySelector(
        "#people-count"
      );

    if (
      !grid
    ) {
      return;
    }

    if (
      count
    ) {
      count.textContent =
        `${this.participants.size}/10`;
    }

    const sorted =
      [
        ...this.participants.values(),
      ].sort(
        (
          a,
          b
        ) =>
          a.joinedAt -
          b.joinedAt
      );

    grid.innerHTML =
      sorted
        .map(
          (p) => {
            const self =
              p.peerId ===
              this.peerId;

            const stream =
              self
                ? this.localStream
                : this.remoteStreams.get(
                    p.peerId
                  );

            const cameraOn =
              self
                ? this.camEnabled
                : p.cam;

            const moderation =
              this.isHost &&
              !self
                ? `
                  <span>

                    <button
                      class="kick-peer"
                      data-peer="${esc(p.peerId)}"
                      title="Remove participant"
                      style="border:0;background:transparent;color:#ff9aa5;font-size:10px;padding:0 3px"
                    >
                      ✕
                    </button>

                    <button
                      class="mute-peer"
                      data-peer="${esc(p.peerId)}"
                      title="Mute participant"
                      style="border:0;background:transparent;color:#dfe4f3;font-size:10px;padding:0 3px"
                    >
                      🔇
                    </button>

                  </span>
                `
                : "";

            return `
              <div
                class="wt-person-card"
                data-person="${esc(p.peerId)}"
              >

                ${
                  stream &&
                  cameraOn
                    ? `
                      <video
                        id="peer-video-${esc(p.peerId)}"
                        autoplay
                        playsinline
                        ${
                          self
                            ? "muted"
                            : ""
                        }
                      ></video>
                    `
                    : `
                      <div class="wt-person-placeholder">

                        <div>

                          <div class="avatar">
                            👤
                          </div>

                          ${esc(p.name)}

                          <br>

                          Camera off

                        </div>

                      </div>
                    `
                }

                <div class="wt-person-name">

                  <span>

                    ${
                      p.peerId ===
                      this.hostId
                        ? "👑 "
                        : ""
                    }

                    ${
                      esc(
                        self
                          ? "You"
                          : p.name
                      )
                    }

                    ${
                      p.mic
                        ? "🎤"
                        : "🔇"
                    }

                  </span>

                  ${moderation}

                </div>

              </div>
            `;
          }
        )
        .join("") ||
      `
        <div class="wt-muted">
          No one else is here yet.
        </div>
      `;

    for (
      const p
      of
      sorted
    ) {
      const self =
        p.peerId ===
        this.peerId;

      const stream =
        self
          ? this.localStream
          : this.remoteStreams.get(
              p.peerId
            );

      const video =
        this.root.querySelector(
          `#peer-video-${CSS.escape(
            p.peerId
          )}`
        );

      if (
        video &&
        stream &&
        video.srcObject !==
          stream
      ) {
        video.srcObject =
          stream;

        video
          .play()
          .catch(
            () => {}
          );
      }
    }

    this.root
      .querySelectorAll(
        ".kick-peer"
      )
      .forEach(
        (btn) =>
          btn.addEventListener(
            "click",
            () => {
              const to =
                btn.dataset.peer;

              this.send(
                "kick",
                {
                  from:
                    this.peerId,

                  to,

                  reason:
                    "The host removed you from the room.",
                }
              );
            }
          )
      );

    this.root
      .querySelectorAll(
        ".mute-peer"
      )
      .forEach(
        (btn) =>
          btn.addEventListener(
            "click",
            () => {
              const to =
                btn.dataset.peer;

              this.send(
                "moderation-mute",
                {
                  from:
                    this.peerId,

                  to,
                }
              );

              this.toast(
                `Mute request sent to ${
                  this.participants.get(
                    to
                  )?.name ||
                  "participant"
                }.`,
                "good"
              );
            }
          )
      );
  }

  onModerationMute(payload) {
    if (
      payload?.to !==
        this.peerId ||
      payload.from !==
        this.hostId
    ) {
      return;
    }

    const track =
      this.localStream
        ?.getAudioTracks()
        ?.[0];

    if (
      track
    ) {
      track.enabled =
        false;

      this.micEnabled =
        false;

      this.trackPresence();

      this.updateMediaButtons();

      this.updatePeopleUI();
    }

    this.toast(
      "The host muted your microphone for the room.",
      "bad"
    );
  }

  updateWatchControlsRole() {
    if (
      this.phase !==
      "watch"
    ) {
      return;
    }

    const play =
      this.root.querySelector(
        "#play-btn"
      );

    const timeline =
      this.root.querySelector(
        "#timeline"
      );

    const speed =
      this.root.querySelector(
        "#speed"
      );

    if (
      play
    ) {
      play.disabled =
        !this.isHost;
    }

    if (
      timeline
    ) {
      timeline.disabled =
        !this.isHost;
    }

    if (
      speed
    ) {
      speed.disabled =
        !this.isHost;
    }
  }

  toggleLock() {
    if (
      !this.isHost
    ) {
      return;
    }

    this.locked =
      !this.locked;

    this.lockedAt =
      this.locked
        ? Date.now()
        : 0;

    this.send(
      "room-control",
      {
        from:
          this.peerId,

        kind:
          "lock",

        locked:
          this.locked,

        lockedAt:
          this.lockedAt,
      }
    );

    const btn =
      this.root.querySelector(
        "#lock-btn"
      );

    if (
      btn
    ) {
      btn.textContent =
        this.locked
          ? "🔒 Unlock room"
          : "🔓 Lock room";
    }

    this.toast(
      this.locked
        ? "Room locked. New participants will be refused."
        : "Room unlocked.",
      "good"
    );
  }

  onRoomControl(payload) {
    if (
      payload?.from !==
      this.hostId
    ) {
      return;
    }

    if (
      payload.kind ===
      "lock"
    ) {
      this.locked =
        Boolean(
          payload.locked
        );

      this.lockedAt =
        Number(
          payload.lockedAt ||
          0
        );
    }
  }

  onKick(payload) {
    if (
      payload?.to !==
        this.peerId ||
      payload.from !==
        this.hostId
    ) {
      return;
    }

    const reason =
      payload.reason ||
      "The host removed you from the room.";

    this.toast(
      reason,
      "bad"
    );

    setTimeout(
      () =>
        this.leaveRoom(
          true
        ),
      650
    );
  }

  endRoom() {
    if (
      !this.isHost
    ) {
      return;
    }

    this.send(
      "end-room",
      {
        from:
          this.peerId,
      }
    );

    this.leaveRoom(
      true
    );
  }

  onEndRoom(payload) {
    if (
      payload?.from !==
      this.hostId
    ) {
      return;
    }

    this.toast(
      "The host ended the watch room.",
      "bad"
    );

    setTimeout(
      () =>
        this.leaveRoom(
          true
        ),
      650
    );
  }

  async send(
    event,
    payload
  ) {
    if (
      !this.channel ||
      !this.connected
    ) {
      return;
    }

    try {
      await this.channel.send({
        type:
          "broadcast",

        event,

        payload,
      });

    } catch (error) {
      console.warn(
        `Realtime send failed: ${event}`,
        error
      );

      this.connectionStatus =
        "reconnecting";

      this.updateTopStatus();
    }
  }

  updateTopStatus() {
    const pills =
      this.root.querySelectorAll(
        ".wt-top-actions .wt-pill"
      );

    if (
      !pills.length
    ) {
      return;
    }

    const status =
      [
        ...pills,
      ].find(
        (el) =>
          el.querySelector(
            ".wt-dot"
          )
      );

    if (
      !status
    ) {
      return;
    }

    if (
      this.connectionStatus ===
      "connected"
    ) {
      status.innerHTML =
        `<i class="wt-dot"></i>Connected`;

    } else if (
      this.connectionStatus ===
      "reconnecting"
    ) {
      status.innerHTML =
        `<i class="wt-dot yellow"></i>Reconnecting…`;

    } else {
      status.innerHTML =
        `<i class="wt-dot red"></i>Connection lost`;
    }
  }

  scheduleReconnect() {
    /*
      Never reconnect if user deliberately
      pressed Leave / End Room.
    */

    if (
      this.intentionalDisconnect ||
      this.destroyed
    ) {
      return;
    }

    clearTimeout(
      this.reconnectTimer
    );

    const code =
      this.roomCode;

    const name =
      this.name;

    this.reconnectTimer =
      setTimeout(
        () => {
          if (
            !this.destroyed &&
            !this.intentionalDisconnect &&
            this.connectionStatus !==
              "connected" &&
            code &&
            name
          ) {
            this.joinRoom(
              code,
              name,
              false
            );
          }
        },
        1800
      );
  }

  closePeer(peerId) {
    const pc =
      this.pcs.get(
        peerId
      );

    if (
      pc
    ) {
      try {
        pc.close();

      } catch {}
    }

    this.pcs.delete(
      peerId
    );

    this.iceQueues.delete(
      peerId
    );

    this.remoteStreams.delete(
      peerId
    );

    if (
      this.phase ===
      "watch"
    ) {
      this.updatePeopleUI();
    }
  }

  async leaveRoom(
    goHome =
      true
  ) {
    /*
      VERY IMPORTANT FIX

      Set this BEFORE Supabase channel removal.

      Supabase can emit CLOSED during removeChannel().

      Previously CLOSED triggered scheduleReconnect()
      and reopened the old room.
    */

    this.intentionalDisconnect =
      true;

    clearInterval(
      this.syncTimer
    );

    this.syncTimer =
      null;

    clearInterval(
      this.uiTimer
    );

    this.uiTimer =
      null;

    clearInterval(
      this.clockTimer
    );

    this.clockTimer =
      null;

    clearTimeout(
      this.reconnectTimer
    );

    this.reconnectTimer =
      null;

    /*
      Detach reference before removing channel.

      This further prevents CLOSED callbacks
      from matching the currently active room.
    */

    const channel =
      this.channel;

    this.channel =
      null;

    this.connected =
      false;

    if (
      channel
    ) {
      try {
        await channel.untrack();

      } catch {}

      try {
        await this.supabase
          ?.removeChannel(
            channel
          );

      } catch {}
    }

    clearTimeout(
      this.reconnectTimer
    );

    this.reconnectTimer =
      null;

    this.connectionStatus =
      "offline";

    for (
      const peerId
      of
      [
        ...this.pcs.keys(),
      ]
    ) {
      this.closePeer(
        peerId
      );
    }

    this.participants.clear();

    this.previousParticipantIds.clear();

    this.hostId =
      null;

    this.isHost =
      false;

    this.authoritative =
      null;

    this.clockSamples =
      [];

    this.clockOffset =
      0;

    if (
      goHome
    ) {
      this.cleanupMovieAudio();

      this.stopLocalMedia();

      this.phase =
        "landing";

      this.roomCode =
        "";

      this.name =
        "";

      this.creating =
        false;

      this.config.roomFromUrl =
        "";

      /*
        Remove ?room=WATCH-XXXX
        from browser URL.
      */

      this.updateUrl(
        ""
      );

      this.render();
    }
  }

  stopLocalMedia() {
    if (
      this.localStream
    ) {
      for (
        const track
        of
        this.localStream.getTracks()
      ) {
        track.stop();
      }
    }

    this.localStream =
      null;

    this.micEnabled =
      false;

    this.camEnabled =
      false;
  }

  updateUrl(
    roomCode
  ) {
    try {
      const cleanRoom =
        safeRoomCode(
          roomCode ||
          ""
        );

      const url =
        new URL(
          window.location.href
        );

      if (
        cleanRoom
      ) {
        url.searchParams.set(
          "room",
          cleanRoom
        );

      } else {
        url.searchParams.delete(
          "room"
        );
      }

      window.history.replaceState(
        {},
        "",
        url.toString()
      );

      /*
        Keep local config in sync too.
      */

      this.config.roomFromUrl =
        cleanRoom;

    } catch {}
  }

  toast(
    text,
    kind =
      ""
  ) {
    let stack =
      this.root.querySelector(
        "#toast-stack"
      );

    if (
      !stack
    ) {
      stack =
        document.createElement(
          "div"
        );

      stack.id =
        "toast-stack";

      stack.className =
        "wt-toast-stack";

      this.root.appendChild(
        stack
      );
    }

    const item =
      document.createElement(
        "div"
      );

    item.className =
      `wt-toast ${kind}`;

    item.textContent =
      text;

    stack.appendChild(
      item
    );

    setTimeout(
      () =>
        item.remove(),
      4200
    );
  }

  async destroy() {
    this.destroyed =
      true;

    await this.leaveRoom(
      false
    );

    this.cleanupMovieAudio();

    this.stopLocalMedia();

    if (
      this.fileUrl
    ) {
      URL.revokeObjectURL(
        this.fileUrl
      );
    }
  }
}

export default function({
  parentElement,
  data,
}) {
  if (
    parentElement.__watchTogetherApp
  ) {
    parentElement
      .__watchTogetherApp
      .updateConfig(
        data
      );

    return;
  }

  const root =
    parentElement.querySelector(
      "#wt-app"
    );

  const app =
    new WatchTogetherApp(
      root,
      data ||
      {}
    );

  parentElement.__watchTogetherApp =
    app;

  app.init();

  return () => {
    app.destroy();

    delete parentElement.__watchTogetherApp;
  };
}