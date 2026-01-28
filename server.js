const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

/**
 * rooms = {
 *   "roomName": { host: WebSocket, clients: Set<WebSocket> }
 * }
 */
const rooms = Object.create(null);

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function removeFromRooms(ws) {
  for (const [room, info] of Object.entries(rooms)) {
    if (info.host === ws) {
      // Host left → close room
      for (const c of info.clients) {
        safeSend(c, { type: "room-closed", room });
      }
      delete rooms[room];
      continue;
    }

    if (info.clients.has(ws)) {
      info.clients.delete(ws);
    }

    if (!info.host && info.clients.size === 0) {
      delete rooms[room];
    }
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // JOIN room
    if (msg.type === "join" && typeof msg.room === "string") {
      const room = msg.room;

      if (!rooms[room]) {
        rooms[room] = { host: ws, clients: new Set() };
        safeSend(ws, { type: "role", room, role: "host" });
        return;
      }

      const info = rooms[room];

      if (!info.host) {
        info.host = ws;
        safeSend(ws, { type: "role", room, role: "host" });
      } else if (info.host === ws) {
        safeSend(ws, { type: "role", room, role: "host" });
      } else {
        info.clients.add(ws);
        safeSend(ws, { type: "role", room, role: "client" });
        safeSend(info.host, { type: "client-joined", room });
      }

      return;
    }

    // Relay signaling messages (offer / answer / ice / custom)
    if (typeof msg.room === "string" && rooms[msg.room]) {
      const info = rooms[msg.room];

      const targets = [];
      if (info.host) targets.push(info.host);
      for (const c of info.clients) targets.push(c);

      for (const t of targets) {
        if (t !== ws && t.readyState === WebSocket.OPEN) {
          t.send(JSON.stringify(msg));
        }
      }
    }
  });

  ws.on("close", () => removeFromRooms(ws));
  ws.on("error", () => removeFromRooms(ws));
});

console.log(`Signaling server running on port ${PORT}`);
