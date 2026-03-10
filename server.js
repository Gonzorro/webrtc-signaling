const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const rooms = Object.create(null); // room -> { host: ws, clients: Map<id, ws> }
const DEBUG = process.env.DEBUG_SIGNALING === "1";
const INTERVAL_MS = 30000;

function debugLog(...args) { if (DEBUG) console.log(...args); }
function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function getPeerId(ws) { return ws.__id || ""; }
function getPeerRoom(ws) { return ws.__room || ""; }
function getPeerRole(ws) { return ws.__role || ""; }
function getRoomInfo(room) { return rooms[room]; }
function assignId() { return Math.random().toString(36).slice(2, 10); }

function removeFromRooms(leaver) {
  for (const [room, info] of Object.entries(rooms)) {
    if (info.host === leaver) {
      const nextEntry = info.clients.entries().next();
      if (!nextEntry.done) {
        const [nextId, nextWs] = nextEntry.value;
        info.clients.delete(nextId);
        info.host = nextWs;
        nextWs.__role = "host";
        safeSend(nextWs, { type: "role", room, role: "host" });
        for (const [cid, cws] of info.clients) {
          safeSend(cws, { type: "host-changed", room });
        }
      } else {
        for (const [, cws] of info.clients) {
          safeSend(cws, { type: "room-closed", room });
        }
        delete rooms[room];
      }
      continue;
    }
    const cid = getPeerId(leaver);
    if (cid && info.clients.has(cid)) info.clients.delete(cid);
    if (!info.host && info.clients.size === 0) delete rooms[room];
  }
  leaver.__room = "";
  leaver.__role = "";
  leaver.__id = "";
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.__id = assignId();

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const type = msg.type;

    if (type === "join" && typeof msg.room === "string") {
      const room = msg.room;
      if (!rooms[room]) {
        rooms[room] = { host: ws, clients: new Map() };
        ws.__room = room;
        ws.__role = "host";
        debugLog("[join] host created", room, "id=", ws.__id);
        safeSend(ws, { type: "join-ok", room, role: "host", id: ws.__id });
        return;
      }
      const info = rooms[room];
      if (!info.host) {
        info.host = ws;
        ws.__room = room;
        ws.__role = "host";
        debugLog("[join] host assigned", room, "id=", ws.__id);
        safeSend(ws, { type: "join-ok", room, role: "host", id: ws.__id });
      } else {
        info.clients.set(ws.__id, ws);
        ws.__room = room;
        ws.__role = "client";
        debugLog("[join] client joined", room, "id=", ws.__id, "count=", info.clients.size);
        safeSend(ws, { type: "join-ok", room, role: "client", id: ws.__id });
        safeSend(info.host, { type: "client-joined", room, id: ws.__id });
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
      const cid = getPeerId(ws);
      if (cid) info.clients.delete(cid);
      if (oldHost) {
        oldHost.__role = "client";
        const oldId = getPeerId(oldHost) || assignId();
        oldHost.__id = oldId;
        info.clients.set(oldId, oldHost);
        safeSend(oldHost, { type: "role", room, role: "client" });
      }
      ws.__role = "host";
      // Include existing client IDs so the new host can populate its UI peer list
      // without needing a separate round-trip message.
      const clientIds = [];
      for (const [existingId] of info.clients) clientIds.push(existingId);
      safeSend(ws, { type: "role", room, role: "host", clients: clientIds });
      debugLog("[promote-host]", room, "newHostId=", getPeerId(ws), "clients=", clientIds);
      return;
    }

    if (type === "ping") { safeSend(ws, { type: "pong" }); return; }

    if (type === "app") {
      const room = typeof msg.room === "string" ? msg.room : getPeerRoom(ws);
      const info = getRoomInfo(room);
      if (!info) return;
      const role = getPeerRole(ws);
      if (role === "client") {
        if (info.host) safeSend(info.host, msg);
      } else if (role === "host") {
        for (const [, cws] of info.clients) safeSend(cws, msg);
      }
      return;
    }

    const relayTypes = new Set(["offer", "answer", "ice"]);
    if (relayTypes.has(type)) {
      const room = typeof msg.room === "string" ? msg.room : getPeerRoom(ws);
      const info = getRoomInfo(room);
      if (!info) return;
      const to = msg.to;
      const from = msg.from;
      if (typeof to !== "string" || !to) return;
      if (typeof from !== "string" || !from) return;

      let target = null;
      if (to === "host") target = info.host;
      else target = info.clients.get(to);

      if (DEBUG) debugLog("[relay]", type, "room=", room, "from=", from, "to=", to, !!target);
      if (target && target.readyState === WebSocket.OPEN) target.send(JSON.stringify(msg));
      return;
    }
  });

  ws.on("close", () => removeFromRooms(ws));
  ws.on("error", () => removeFromRooms(ws));
});

setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, INTERVAL_MS);

console.log(`Signaling server running on port ${PORT}`);