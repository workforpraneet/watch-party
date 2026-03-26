const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WatchParty Signaling Server');
});

const wss = new WebSocketServer({ server });

const rooms = new Map(); // roomId -> { members: Set<ws>, pageUrl: string }

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcast(roomId, msg, exclude) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(msg);
  room.members.forEach((client) => {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.userId = genCode();
  ws.username = '';

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create-room': {
        const roomId = genCode();
        ws.roomId = roomId;
        ws.username = msg.username || 'Host';
        rooms.set(roomId, {
          members: new Set([ws]),
          pageUrl: msg.pageUrl || ''
        });
        ws.send(JSON.stringify({ type: 'room-created', roomId }));
        console.log(`Room ${roomId} created by ${ws.username}`);
        break;
      }

      case 'join-room': {
        const rid = (msg.roomId || '').toUpperCase();
        if (!rooms.has(rid)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        ws.roomId = rid;
        ws.username = msg.username || 'Guest';
        rooms.get(rid).members.add(ws);
        ws.send(JSON.stringify({ type: 'room-joined', roomId: rid }));
        broadcast(rid, {
          type: 'peer-joined',
          userId: ws.userId,
          username: ws.username
        }, ws);
        console.log(`${ws.username} joined room ${rid}`);
        break;
      }

      case 'get-room-info': {
        const qid = (msg.roomId || '').toUpperCase();
        const roomData = rooms.get(qid);
        if (!roomData) {
          ws.send(JSON.stringify({ type: 'room-info', found: false, roomId: qid }));
        } else {
          ws.send(JSON.stringify({ type: 'room-info', found: true, roomId: qid, pageUrl: roomData.pageUrl }));
        }
        break;
      }

      case 'sync':
      case 'chat':
      case 'webrtc-signal': {
        if (ws.roomId && rooms.has(ws.roomId)) {
          broadcast(ws.roomId, {
            ...msg,
            userId: ws.userId,
            username: ws.username
          }, ws);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomId && rooms.has(ws.roomId)) {
      const room = rooms.get(ws.roomId);
      room.members.delete(ws);
      if (room.members.size === 0) {
        rooms.delete(ws.roomId);
        console.log(`Room ${ws.roomId} deleted (empty)`);
      } else {
        broadcast(ws.roomId, {
          type: 'peer-left',
          userId: ws.userId,
          username: ws.username
        });
      }
    }
  });
});

// Heartbeat to detect broken connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WatchParty server running on port ${PORT}`);
});
