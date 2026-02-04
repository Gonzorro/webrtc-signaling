const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

/**
 * rooms = {
 *   "roomName": { host: WebSocket, clients: Set<WebSocket> }
 * }
 */
const rooms = Object.create(null);
const DEBUG = process.env.DEBUG_SIGNALING === "1";

function getRoomInfo(room) {
  return rooms[room];
}

function getPeerRoom(ws) {
  return ws.__room || "";
}

function getPeerRole(ws) {
  return ws.__role || "";
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function debugLog(...args) {
  if (DEBUG) {
    console.log(...args);
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
  ws.__room = "";
  ws.__role = "";
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
        ws.__room = room;
        ws.__role = "host";
        debugLog("[join] host created room", room);
        safeSend(ws, { type: "role", room, role: "host" });
        return;
      }

      const info = rooms[room];

      if (!info.host) {
        info.host = ws;
        ws.__room = room;
        ws.__role = "host";
        debugLog("[join] host assigned room", room);
        safeSend(ws, { type: "role", room, role: "host" });
      } else if (info.host === ws) {
        ws.__room = room;
        ws.__role = "host";
        debugLog("[join] host rejoined room", room);
        safeSend(ws, { type: "role", room, role: "host" });
      } else {
        info.clients.add(ws);
        ws.__room = room;
        ws.__role = "client";
        debugLog("[join] client joined room", room, "clients=", info.clients.size);
        safeSend(ws, { type: "role", room, role: "client" });
        safeSend(info.host, { type: "client-joined", room });
      }

      return;
    }

    // Relay signaling messages (offer / answer / ice / custom)
    if (msg && typeof msg === "object") {
      const room = typeof msg.room === "string" && msg.room ? msg.room : getPeerRoom(ws);
      const info = room ? getRoomInfo(room) : null;
      if (!info) return;

      const senderRole = getPeerRole(ws);
      const targets = [];

      if (senderRole === "host") {
        // Host → first client (if any)
        const firstClient = info.clients.values().next().value;
        if (firstClient) targets.push(firstClient);
      } else if (senderRole === "client") {
        // Client → host
        if (info.host) targets.push(info.host);
      } else {
        // Unknown role → broadcast to all except sender
        if (info.host) targets.push(info.host);
        for (const c of info.clients) targets.push(c);
      }

      if (DEBUG && targets.length > 0) {
        debugLog("[relay]", msg.type || "unknown", "room=", room, "from=", senderRole, "to=", targets.length);
      }
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
