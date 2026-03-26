(function () {
  'use strict';
  if (window.__watchPartyInit) return;
  window.__watchPartyInit = true;

  const SYNC_THRESHOLD = 0.5;
  const VIDEO_POLL_MS = 2000;
  const SERVER_URL = 'wss://watch-party-production-ecaa.up.railway.app'; // Railway deployed server

  class WatchParty {
    constructor() {
      this.ws = null;
      this.pc = null;
      this.localStream = null;
      this.video = null;
      this.roomId = null;
      this.username = '';
      this.isHost = false;
      this.ignoreEvents = false;
      this.serverUrl = SERVER_URL;
      this.connected = false;
      this.sidebarOpen = false;
      this.miniMode = false;
      this.micOn = true;
      this.camOn = true;
      this.el = {};
      this.root = null;
      this.shadow = null;
      this._init();
    }

    async _init() {
      await this._loadSettings();
      this._buildUI();
      this._pollForVideo();
      this._listenExtension();

      // Auto-join if URL has #wpjoin=CODE
      const hash = window.location.hash;
      if (hash.startsWith('#wpjoin=')) {
        const code = hash.split('=')[1];
        if (code) {
          this._toggleSidebar();
          this.el.roomInput.value = code;
          window.history.replaceState('', document.title, window.location.pathname + window.location.search);
          setTimeout(() => {
            const joinBtn = this.el.sidebar.querySelector('#wp-join');
            if (joinBtn) joinBtn.click();
          }, 500);
        }
      }
    }

    _loadSettings() {
      return new Promise((r) =>
        chrome.storage.local.get(['wp_user'], (d) => {
          if (d.wp_user) this.username = d.wp_user;
          r();
        })
      );
    }

    /* ── Video Detection ─────────────────────────── */

    _pollForVideo() {
      const find = () => {
        const vids = [...document.querySelectorAll('video')];
        if (!vids.length) return;
        let best = vids[0], maxA = 0;
        for (const v of vids) {
          const r = v.getBoundingClientRect();
          const a = r.width * r.height;
          if (a > maxA) { maxA = a; best = v; }
        }
        if (best && best !== this.video) {
          this.video = best;
          this._attachVideoEvents();
          this._setStatus('Video detected ✓');
        }
      };
      find();
      this._videoPoller = setInterval(find, VIDEO_POLL_MS);
    }

    _attachVideoEvents() {
      if (!this.video) return;
      const v = this.video;
      v.addEventListener('play', () => {
        if (!this.ignoreEvents && this.connected)
          this._send({ type: 'sync', action: 'play', time: v.currentTime });
      });
      v.addEventListener('pause', () => {
        if (!this.ignoreEvents && this.connected)
          this._send({ type: 'sync', action: 'pause', time: v.currentTime });
      });
      v.addEventListener('seeked', () => {
        if (!this.ignoreEvents && this.connected)
          this._send({ type: 'sync', action: 'seek', time: v.currentTime });
      });
    }

    /* ── WebSocket ────────────────────────────────── */

    _connect(action) {
      if (this.ws) this.ws.close();
      try {
        this.ws = new WebSocket(this.serverUrl);
      } catch {
        this._setStatus('Connection failed');
        return;
      }

      this.ws.onopen = () => {
        this._setStatus('Connected');
        if (action === 'create') {
          this._send({ 
            type: 'create-room', 
            username: this.username,
            pageUrl: window.location.href.split('#')[0] 
          });
        } else {
          const code = this.el.roomInput.value.trim().toUpperCase();
          if (!code) { this._setStatus('Enter room code'); return; }
          this._send({ type: 'join-room', roomId: code, username: this.username });
        }
      };

      this.ws.onmessage = (e) => this._onMsg(JSON.parse(e.data));
      this.ws.onclose = () => { this.connected = false; this._setStatus('Disconnected'); };
      this.ws.onerror = () => this._setStatus('Connection error');
    }

    _send(msg) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN)
        this.ws.send(JSON.stringify(msg));
    }

    _onMsg(d) {
      switch (d.type) {
        case 'room-created':
          this.roomId = d.roomId;
          this.isHost = true;
          this.connected = true;
          this._showParty();
          this.el.roomCode.textContent = d.roomId;
          this._setStatus('Party created! Share the code');
          this._startLocalMedia();
          break;
        case 'room-joined':
          this.roomId = d.roomId;
          this.connected = true;
          this._showParty();
          this.el.roomCode.textContent = d.roomId;
          this._setStatus('Joined party!');
          this._startLocalMedia();
          break;
        case 'peer-joined':
          this._setStatus((d.username || 'Partner') + ' joined!');
          this.el.remoteLabel.textContent = d.username || 'Partner';
          this._addChat(d.username + ' joined the party', 'system');
          this._startWebRTC(true);
          break;
        case 'peer-left':
          this._setStatus('Partner left');
          this._addChat('Partner left the party', 'system');
          this._cleanRTC();
          break;
        case 'sync':
          this._applySync(d);
          break;
        case 'chat':
          this._addChat(d.message, 'remote', d.username);
          break;
        case 'webrtc-signal':
          this._onSignal(d.signal);
          break;
        case 'error':
          this._setStatus('Error: ' + d.message);
          break;
      }
    }

    /* ── Video Sync ──────────────────────────────── */

    _applySync(d) {
      if (!this.video) return;
      this.ignoreEvents = true;
      if (Math.abs(this.video.currentTime - d.time) > SYNC_THRESHOLD)
        this.video.currentTime = d.time;
      if (d.action === 'play') this.video.play().catch(() => {});
      else if (d.action === 'pause') this.video.pause();
      else if (d.action === 'seek') this.video.currentTime = d.time;
      setTimeout(() => { this.ignoreEvents = false; }, 500);
    }

    /* ── WebRTC ───────────────────────────────────── */

    async _startLocalMedia() {
      if (this.localStream) return;
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        this.el.localVid.srcObject = this.localStream;
        this._setStatus('Camera & mic ready');
      } catch {
        this._setStatus('Camera/Mic unavailable – check site permissions');
      }
    }

    async _startWebRTC(initiator) {
      const cfg = { iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]};
      this.pc = new RTCPeerConnection(cfg);

      // Use the already-acquired local stream
      if (this.localStream) {
        this.localStream.getTracks().forEach((t) => this.pc.addTrack(t, this.localStream));
      } else {
        // Fallback: acquire media now if not already done
        try {
          this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          this.el.localVid.srcObject = this.localStream;
          this.localStream.getTracks().forEach((t) => this.pc.addTrack(t, this.localStream));
        } catch {
          this._setStatus('Camera/Mic unavailable');
        }
      }

      this.pc.ontrack = (e) => { this.el.remoteVid.srcObject = e.streams[0]; };
      this.pc.onicecandidate = (e) => {
        if (e.candidate)
          this._send({ type: 'webrtc-signal', signal: { type: 'ice', candidate: e.candidate } });
      };
      this.pc.onconnectionstatechange = () => {
        if (this.pc.connectionState === 'connected') this._setStatus('Video call connected!');
      };

      if (initiator) {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this._send({ type: 'webrtc-signal', signal: { type: 'offer', sdp: this.pc.localDescription } });
      }
    }

    async _onSignal(s) {
      if (s.type === 'offer') {
        if (!this.pc) await this._startWebRTC(false);
        await this.pc.setRemoteDescription(new RTCSessionDescription(s.sdp));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this._send({ type: 'webrtc-signal', signal: { type: 'answer', sdp: this.pc.localDescription } });
      } else if (s.type === 'answer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(s.sdp));
      } else if (s.type === 'ice') {
        try { await this.pc.addIceCandidate(new RTCIceCandidate(s.candidate)); } catch {}
      }
    }

    _cleanRTC() {
      if (this.pc) { this.pc.close(); this.pc = null; }
      if (this.localStream) { this.localStream.getTracks().forEach((t) => t.stop()); this.localStream = null; }
      if (this.el.localVid) this.el.localVid.srcObject = null;
      if (this.el.remoteVid) this.el.remoteVid.srcObject = null;
    }

    _toggleMic() {
      if (!this.localStream) return;
      this.micOn = !this.micOn;
      this.localStream.getAudioTracks().forEach((t) => { t.enabled = this.micOn; });
      this.el.micBtn.textContent = this.micOn ? '🎤' : '🔇';
      this.el.micBtn.classList.toggle('wp-off', !this.micOn);
      if (this.el.miniMicBtn) {
        this.el.miniMicBtn.textContent = this.micOn ? '🎤' : '🔇';
        this.el.miniMicBtn.classList.toggle('wp-off', !this.micOn);
      }
    }

    _toggleCam() {
      if (!this.localStream) return;
      this.camOn = !this.camOn;
      this.localStream.getVideoTracks().forEach((t) => { t.enabled = this.camOn; });
      this.el.camBtn.textContent = this.camOn ? '📷' : '🚫';
      this.el.camBtn.classList.toggle('wp-off', !this.camOn);
      if (this.el.miniCamBtn) {
        this.el.miniCamBtn.textContent = this.camOn ? '📷' : '🚫';
        this.el.miniCamBtn.classList.toggle('wp-off', !this.camOn);
      }
    }

    /* ── Chat ─────────────────────────────────────── */

    _sendChat() {
      const t = this.el.chatIn.value.trim();
      if (!t) return;
      this._send({ type: 'chat', message: t });
      this._addChat(t, 'local', this.username || 'You');
      this.el.chatIn.value = '';
    }

    _addChat(text, from, name) {
      const m = document.createElement('div');
      m.className = 'wp-msg wp-msg-' + from;
      if (from === 'system') {
        m.textContent = text;
      } else {
        m.innerHTML = '<span class="wp-msg-name">' + (name || 'Partner') + '</span>' +
                      '<span class="wp-msg-text">' + this._esc(text) + '</span>';
      }
      this.el.chatBox.appendChild(m);
      this.el.chatBox.scrollTop = this.el.chatBox.scrollHeight;
    }

    _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    /* ── Disconnect ───────────────────────────────── */

    _leave() {
      this._cleanRTC();
      if (this.ws) this.ws.close();
      this.connected = false;
      this.roomId = null;
      if (this.miniMode) this._toggleMini();
      this._showConnect();
      this._setStatus('Disconnected');
    }

    /* ── UI ────────────────────────────────────────── */

    _setStatus(t) { if (this.el.status) this.el.status.textContent = t; }

    _showParty() {
      this.el.connectPanel.style.display = 'none';
      this.el.partyPanel.style.display = 'flex';
    }

    _showConnect() {
      this.el.connectPanel.style.display = 'flex';
      this.el.partyPanel.style.display = 'none';
    }

    _toggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen;
      this.el.sidebar.classList.toggle('wp-open', this.sidebarOpen);
      this.el.fab.classList.toggle('wp-fab-shift', this.sidebarOpen);
      document.body.classList.toggle('watchparty-sidebar-open', this.sidebarOpen);
    }

    _toggleMini() {
      this.miniMode = !this.miniMode;
      if (this.miniMode) {
        // Close sidebar, show mini overlay
        if (this.sidebarOpen) this._toggleSidebar();
        this.el.fab.style.display = 'none';
        this.el.miniOverlay.style.display = 'flex';
        // Mirror video streams to mini overlay
        this._syncMiniVideos();
      } else {
        // Hide mini overlay, reopen sidebar
        this.el.miniOverlay.style.display = 'none';
        this.el.fab.style.display = 'flex';
        this._toggleSidebar();
      }
    }

    _syncMiniVideos() {
      if (this.el.localVid.srcObject)
        this.el.miniLocalVid.srcObject = this.el.localVid.srcObject;
      if (this.el.remoteVid.srcObject)
        this.el.miniRemoteVid.srcObject = this.el.remoteVid.srcObject;
    }

    _listenExtension() {
      chrome.runtime.onMessage.addListener((msg, _, res) => {
        if (msg.type === 'TOGGLE_SIDEBAR') this._toggleSidebar();
        res({ ok: true });
      });
    }

    /* ── Build UI (Shadow DOM) ────────────────────── */

    _buildUI() {
      this.root = document.createElement('div');
      this.root.id = 'watchparty-root';
      this.shadow = this.root.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = this._css();
      this.shadow.appendChild(style);

      // FAB
      this.el.fab = document.createElement('button');
      this.el.fab.className = 'wp-fab';
      this.el.fab.textContent = '🎬';
      this.el.fab.title = 'WatchParty';
      this.el.fab.addEventListener('click', () => this._toggleSidebar());
      this.shadow.appendChild(this.el.fab);

      // Sidebar
      this.el.sidebar = document.createElement('div');
      this.el.sidebar.className = 'wp-sidebar';
      this.el.sidebar.innerHTML = this._html();
      this.shadow.appendChild(this.el.sidebar);

      // Mini overlay
      this._buildMiniOverlay();

      document.body.appendChild(this.root);
      this._bindElements();
      this._bindEvents();
    }

    _bindElements() {
      const q = (s) => this.el.sidebar.querySelector(s);
      this.el.connectPanel = q('#wp-cp');
      this.el.partyPanel = q('#wp-pp');
      this.el.nameIn = q('#wp-name');
      this.el.roomInput = q('#wp-ri');
      this.el.roomCode = q('#wp-rc');
      this.el.localVid = q('#wp-lv');
      this.el.remoteVid = q('#wp-rv');
      this.el.remoteLabel = q('#wp-rl');
      this.el.micBtn = q('#wp-mic');
      this.el.camBtn = q('#wp-cam');
      this.el.chatBox = q('#wp-cb');
      this.el.chatIn = q('#wp-ci');
      this.el.status = q('#wp-st');

      if (this.username) this.el.nameIn.value = this.username;
    }

    _bindEvents() {
      const q = (s) => this.el.sidebar.querySelector(s);
      q('#wp-close').addEventListener('click', () => this._toggleSidebar());
      q('#wp-create').addEventListener('click', () => {
        this.username = this.el.nameIn.value.trim() || 'Host';
        chrome.storage.local.set({ wp_user: this.username });
        this._connect('create');
      });
      q('#wp-join').addEventListener('click', () => {
        this.username = this.el.nameIn.value.trim() || 'Guest';
        chrome.storage.local.set({ wp_user: this.username });
        this._connect('join');
      });
      q('#wp-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(this.roomId).then(() => this._setStatus('Code copied!'));
      });
      q('#wp-mic').addEventListener('click', () => this._toggleMic());
      q('#wp-cam').addEventListener('click', () => this._toggleCam());
      q('#wp-mini').addEventListener('click', () => this._toggleMini());
      q('#wp-leave').addEventListener('click', () => this._leave());
      q('#wp-send').addEventListener('click', () => this._sendChat());
      this.el.chatIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._sendChat(); });
      this.el.roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') q('#wp-join').click(); });
    }

    _html() {
      return `
      <div class="wp-head"><span class="wp-title">🎬 WatchParty</span><button id="wp-close" class="wp-x">✕</button></div>
      <div class="wp-body" id="wp-cp">
        <div class="wp-field"><label>Name</label><input id="wp-name" type="text" placeholder="Your name"></div>
        <button id="wp-create" class="wp-btn wp-primary">Create Party</button>
        <div class="wp-or">— or join —</div>
        <div class="wp-row"><input id="wp-ri" type="text" placeholder="Room code"><button id="wp-join" class="wp-btn wp-sec">Join</button></div>
      </div>
      <div class="wp-body wp-party" id="wp-pp" style="display:none">
        <div class="wp-room">Room: <strong id="wp-rc"></strong> <button id="wp-copy" class="wp-icon-btn" title="Copy">📋</button></div>
        <div class="wp-vids">
          <div class="wp-vid-box"><video id="wp-lv" autoplay muted playsinline></video><span class="wp-lbl">You</span></div>
          <div class="wp-vid-box"><video id="wp-rv" autoplay playsinline></video><span class="wp-lbl" id="wp-rl">Waiting…</span></div>
        </div>
        <div class="wp-ctrls">
          <button id="wp-mic" class="wp-icon-btn" title="Mic">🎤</button>
          <button id="wp-cam" class="wp-icon-btn" title="Camera">📷</button>
          <button id="wp-mini" class="wp-icon-btn" title="Minimize to overlay">⬜</button>
          <button id="wp-leave" class="wp-icon-btn wp-danger" title="Leave">🚪</button>
        </div>
        <div class="wp-chat">
          <div id="wp-cb" class="wp-chat-box"></div>
          <div class="wp-chat-row"><input id="wp-ci" type="text" placeholder="Message…"><button id="wp-send" class="wp-icon-btn">➤</button></div>
        </div>
      </div>
      <div class="wp-foot"><span id="wp-st">Ready</span></div>`;
    }

    _css() {
      return `
*{margin:0;padding:0;box-sizing:border-box}
:host{position:fixed;top:0;right:0;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#eee}
.wp-fab{position:fixed;right:20px;bottom:20px;width:50px;height:50px;border-radius:50%;background:linear-gradient(135deg,#e94560,#c0392b);color:#fff;border:none;font-size:24px;cursor:pointer;box-shadow:0 4px 18px rgba(233,69,96,.45);transition:all .3s ease;display:flex;align-items:center;justify-content:center;z-index:2147483647}
.wp-fab:hover{transform:scale(1.12);box-shadow:0 6px 24px rgba(233,69,96,.6)}
.wp-fab-shift{right:360px}
.wp-sidebar{position:fixed;top:0;right:0;width:340px;height:100vh;background:#12121f;border-left:1px solid #2a2a40;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .3s cubic-bezier(.4,0,.2,1);z-index:2147483646;overflow:hidden}
.wp-open{transform:translateX(0)}
.wp-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#16162a;border-bottom:1px solid #2a2a40}
.wp-title{font-size:15px;font-weight:700;background:linear-gradient(135deg,#e94560,#ff6b81);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.wp-x{background:none;border:none;color:#666;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:4px}
.wp-x:hover{background:#ffffff10;color:#eee}
.wp-body{flex:1;display:flex;flex-direction:column;padding:16px;gap:12px;overflow-y:auto}
.wp-party{gap:10px}
.wp-field{display:flex;flex-direction:column;gap:4px}
.wp-field label{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#666}
input{width:100%;padding:8px 10px;background:#1a1a30;border:1px solid #2a2a40;border-radius:6px;color:#eee;font-size:13px;outline:none;transition:border .2s}
input:focus{border-color:#e94560}
.wp-btn{padding:9px 14px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .2s}
.wp-primary{background:linear-gradient(135deg,#e94560,#c0392b);color:#fff;width:100%}
.wp-sec{background:#2a2a40;color:#eee;white-space:nowrap}
.wp-btn:hover{opacity:.85}
.wp-or{text-align:center;color:#444;font-size:11px;padding:2px 0}
.wp-row{display:flex;gap:8px}
.wp-row input{flex:1}
.wp-room{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1a1a30;border-radius:6px;font-size:13px}
.wp-room strong{color:#e94560;letter-spacing:1px}
.wp-icon-btn{background:none;border:none;font-size:18px;cursor:pointer;padding:6px 8px;border-radius:6px;transition:background .2s}
.wp-icon-btn:hover{background:#ffffff10}
.wp-danger:hover{background:#e9456020}
.wp-off{opacity:.5}
.wp-vids{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.wp-vid-box{position:relative;border-radius:8px;overflow:hidden;background:#0a0a18;aspect-ratio:4/3}
.wp-vid-box video{width:100%;height:100%;object-fit:cover}
#wp-lv,#wp-rv{transform:scaleX(-1)}
.wp-lbl{position:absolute;bottom:4px;left:6px;font-size:10px;background:#00000088;padding:2px 6px;border-radius:4px}
.wp-ctrls{display:flex;justify-content:center;gap:8px;padding:4px 0}
.wp-chat{flex:1;display:flex;flex-direction:column;min-height:0}
.wp-chat-box{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:8px;background:#0d0d1a;border-radius:6px;min-height:80px;max-height:200px}
.wp-chat-row{display:flex;gap:6px;margin-top:6px}
.wp-chat-row input{flex:1}
.wp-msg{padding:4px 8px;border-radius:6px;font-size:12px;line-height:1.4;word-break:break-word}
.wp-msg-system{color:#666;font-style:italic;text-align:center;font-size:11px}
.wp-msg-local{background:#1e1e38;align-self:flex-end}
.wp-msg-remote{background:#2a1a30;align-self:flex-start}
.wp-msg-name{font-weight:600;margin-right:6px;color:#e94560;font-size:11px}
.wp-msg-text{color:#ccc}
.wp-foot{padding:8px 16px;background:#16162a;border-top:1px solid #2a2a40;font-size:11px;color:#555;text-align:center}
.wp-body::-webkit-scrollbar,.wp-chat-box::-webkit-scrollbar{width:4px}
.wp-body::-webkit-scrollbar-thumb,.wp-chat-box::-webkit-scrollbar-thumb{background:#333;border-radius:4px}

/* ── Mini Overlay ─────────────────────── */
.wp-mini{position:fixed;bottom:20px;right:20px;width:280px;min-width:180px;max-width:500px;background:#12121fee;border:1px solid #2a2a40;border-radius:14px;display:none;flex-direction:column;gap:0;z-index:2147483647;box-shadow:0 8px 32px rgba(0,0,0,.6);overflow:hidden;backdrop-filter:blur(12px)}
.wp-mini-bar{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#16162a;cursor:grab;user-select:none}
.wp-mini-bar:active{cursor:grabbing}
.wp-mini-title{font-size:11px;font-weight:600;color:#e94560}
.wp-mini-vids{display:grid;grid-template-columns:1fr 1fr;gap:2px;padding:2px}
.wp-mini-vid{position:relative;aspect-ratio:4/3;background:#0a0a18;overflow:hidden}
.wp-mini-vid video{width:100%;height:100%;object-fit:cover}
#wp-mlv,#wp-mrv{transform:scaleX(-1)}
.wp-mini-lbl{position:absolute;bottom:2px;left:4px;font-size:9px;background:#00000088;padding:1px 4px;border-radius:3px;color:#ccc}
.wp-mini-ctrls{display:flex;justify-content:center;gap:6px;padding:6px 8px;background:#16162a}
.wp-mini-ctrls button{background:none;border:none;font-size:16px;cursor:pointer;padding:4px 6px;border-radius:6px;transition:background .2s}
.wp-mini-ctrls button:hover{background:#ffffff10}
.wp-mini-resize{width:16px;height:16px;position:absolute;bottom:2px;right:2px;cursor:nwse-resize;display:flex;align-items:center;justify-content:center;font-size:10px;color:#555;user-select:none}
`;
    }

    /* ── Mini Overlay Builder ──────────────── */

    _buildMiniOverlay() {
      this.el.miniOverlay = document.createElement('div');
      this.el.miniOverlay.className = 'wp-mini';
      this.el.miniOverlay.innerHTML = `
        <div class="wp-mini-bar" id="wp-mini-drag">
          <span class="wp-mini-title">🎬 WatchParty</span>
        </div>
        <div class="wp-mini-vids">
          <div class="wp-mini-vid"><video id="wp-mlv" autoplay muted playsinline></video><span class="wp-mini-lbl">You</span></div>
          <div class="wp-mini-vid"><video id="wp-mrv" autoplay playsinline></video><span class="wp-mini-lbl">Partner</span></div>
        </div>
        <div class="wp-mini-ctrls">
          <button id="wp-m-mic" title="Mic">🎤</button>
          <button id="wp-m-cam" title="Camera">📷</button>
          <button id="wp-m-expand" title="Expand">🔲</button>
          <button id="wp-m-leave" title="Leave" style="color:#e94560">🚪</button>
        </div>
        <div class="wp-mini-resize" id="wp-mini-resize">⟋</div>
      `;
      this.shadow.appendChild(this.el.miniOverlay);

      // Cache mini elements
      this.el.miniLocalVid = this.el.miniOverlay.querySelector('#wp-mlv');
      this.el.miniRemoteVid = this.el.miniOverlay.querySelector('#wp-mrv');
      this.el.miniMicBtn = this.el.miniOverlay.querySelector('#wp-m-mic');
      this.el.miniCamBtn = this.el.miniOverlay.querySelector('#wp-m-cam');

      // Mini button events
      this.el.miniOverlay.querySelector('#wp-m-mic').addEventListener('click', () => this._toggleMic());
      this.el.miniOverlay.querySelector('#wp-m-cam').addEventListener('click', () => this._toggleCam());
      this.el.miniOverlay.querySelector('#wp-m-expand').addEventListener('click', () => this._toggleMini());
      this.el.miniOverlay.querySelector('#wp-m-leave').addEventListener('click', () => this._leave());

      // Draggable
      this._makeDraggable(this.el.miniOverlay, this.el.miniOverlay.querySelector('#wp-mini-drag'));

      // Resizable
      this._makeResizable(this.el.miniOverlay, this.el.miniOverlay.querySelector('#wp-mini-resize'));
    }

    _makeDraggable(el, handle) {
      let ox = 0, oy = 0, sx = 0, sy = 0;
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        sx = e.clientX; sy = e.clientY;
        const onMove = (ev) => {
          ox = sx - ev.clientX; oy = sy - ev.clientY;
          sx = ev.clientX; sy = ev.clientY;
          el.style.top = (el.offsetTop - oy) + 'px';
          el.style.left = (el.offsetLeft - ox) + 'px';
          el.style.bottom = 'auto';
          el.style.right = 'auto';
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    _makeResizable(el, handle) {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = el.offsetWidth;
        const onMove = (ev) => {
          const newW = Math.min(500, Math.max(180, startW + (ev.clientX - startX)));
          el.style.width = newW + 'px';
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
  }

  new WatchParty();
})();
