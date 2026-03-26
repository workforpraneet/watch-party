# 🎬 WatchParty

A personal Chrome extension to watch videos together in sync with video/audio chat.

## Supported Platforms
- Netflix
- JioHotstar
- Prime Video
- YouTube
- Zee5

## Setup

### 1. Start the Signaling Server

```bash
cd server
npm install
npm start
```

Server runs on `ws://localhost:3000` by default.

### 2. Load the Chrome Extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. The 🎬 icon appears in your toolbar

### 3. Usage

1. Open any supported streaming site
2. Click the **🎬 floating button** (bottom-right)
3. Enter your name & server URL
4. Click **Create Party** → share the room code
5. Your partner enters the room code and clicks **Join**
6. Video playback syncs automatically + video/audio chat connects

## Deploy Server (Free)

For remote access, deploy the server to a free hosting service:

### Render.com
1. Push the `server/` folder to a GitHub repo
2. Create a new **Web Service** on [render.com](https://render.com)
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Use the provided URL as your server URL (change `https://` to `wss://`)

### Railway.app
1. Connect your GitHub repo on [railway.app](https://railway.app)
2. It auto-detects Node.js and deploys
3. Use the provided URL with `wss://` protocol

## Architecture

```
You ←—WebSocket—→ Signaling Server ←—WebSocket—→ Partner
 ↕                                                  ↕
Content Script                                Content Script
(video sync)                                  (video sync)
 ↕                                                  ↕
 └──────────── WebRTC (P2P video/audio) ────────────┘
```

## Tech Stack
- **Extension**: Chrome Manifest V3, vanilla JS, Shadow DOM
- **Server**: Node.js + `ws` (WebSocket library)
- **Video/Audio**: WebRTC (peer-to-peer, free)
- **Cost**: $0
