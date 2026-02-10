const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const rooms = Object.create(null);
const DEBUG = process.env.DEBUG_SIGNALING === "1";
const INTERVAL_MS = 30000;

function debugLog(...args) {
  if (DEBUG) console.log(...args);
}
function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function getRoomInfo(room) {
  return rooms[room];
}
function getPeerRoom(ws) {
  return ws.__room || "";
}
function getPeerRole(ws) {
  return ws.__role || "";
}
function removeFromRooms(leaver) {
  for (const [room, info] of Object.entries(rooms)) {
    if (info.host === leaver) {
      const next = info.clients.values().next().value;
      if (next) {
        info.clients.delete(next);
        info.host = next;
        next.__role = "host";
        safeSend(next, { type: "role", room, role: "host" });
        for (const c of info.clients) {
          safeSend(c, { type: "host-changed", room });
        }
      } else {
        for (const c of info.clients) {
          safeSend(c, { type: "room-closed", room });
        }
        delete rooms[room];
      }
      continue;
    }
    if (info.clients.has(leaver)) info.clients.delete(leaver);
    if (!info.host && info.clients.size === 0) delete rooms[room];
  }
  leaver.__room = "";
  leaver.__role = "";
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const type = msg.type;

    if (type === "join" && typeof msg.room === "string") {
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

    if (type === "promote-host") {
      const room = typeof msg.room === "string" ? msg.room : getPeerRoom(ws);
      const info = getRoomInfo(room);
      if (!info) return;
      if (getPeerRole(ws) !== "client") return;
      const oldHost = info.host;
      info.host = ws;
      info.clients.delete(ws);
      if (oldHost) {
        info.clients.add(oldHost);
        oldHost.__role = "client";
        safeSend(oldHost, { type: "role", room, role: "client" });
      }
      ws.__role = "host";
      safeSend(ws, { type: "role", room, role: "host" });
      debugLog("[promote-host]", "room=", room);
      return;
    }

    if (type === "ping") {
      safeSend(ws, { type: "pong" });
      return;
    }

    const relayTypes = new Set(["offer", "answer", "ice"]);
    if (relayTypes.has(type)) {
      const room = typeof msg.room === "string" && msg.room ? msg.room : getPeerRoom(ws);
      const info = room ? getRoomInfo(room) : null;
      if (!info) return;
      const senderRole = getPeerRole(ws);
      const targets = [];
      if (senderRole === "host") {
        for (const c of info.clients) targets.push(c);
      } else if (senderRole === "client") {
        if (info.host) targets.push(info.host);
      } else {
        if (info.host) targets.push(info.host);
        for (const c of info.clients) targets.push(c);
      }
      if (DEBUG && targets.length > 0) {
        debugLog("[relay]", type, "room=", room, "from=", senderRole, "to=", targets.length);
      }
      for (const t of targets) {
        if (t !== ws && t.readyState === WebSocket.OPEN) t.send(JSON.stringify(msg));
      }
      return;
    }
  });

  ws.on("close", () => removeFromRooms(ws));
  ws.on("error", () => removeFromRooms(ws));
});

setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {}
  }
}, INTERVAL_MS);

console.log(`Signaling server running on port ${PORT}`);