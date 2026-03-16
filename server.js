const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 8080;
const DEBUG = process.env.DEBUG_SIGNALING === "1";
const INTERVAL_MS = 30000;

const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const rooms = Object.create(null);

function debugLog(...args) { if (DEBUG) console.log(...args); }
function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function getPeerId(ws) { return ws.__id || ""; }
function getPeerRoom(ws) { return ws.__room || ""; }
function getPeerRole(ws) { return ws.__role || ""; }
function getRoomInfo(room) { return rooms[room]; }
function assignId() { return Math.random().toString(36).slice(2, 10); }

async function verifyToken(token) {
  if (!token || !supabase) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return (error || !data.user) ? null : data.user;
}

async function checkBalance(userId) {
  if (!supabase || !userId) return true;
  const { data, error } = await supabase
    .from("user_balance")
    .select("bytes_remaining")
    .eq("user_id", userId)
    .single();
  if (error || !data) return true;
  return data.bytes_remaining > 0;
}

function broadcastToRoom(info, msg, exclude = null) {
  if (info.host && info.host !== exclude) safeSend(info.host, msg);
  for (const [, cws] of info.clients) {
    if (cws !== exclude) safeSend(cws, msg);
  }
}

function closeRoomIfEmpty(room, info) {
  if (!info.host && info.clients.size === 0) {
    delete rooms[room];
    debugLog("[room] closed (empty)", room);
  }
}

function removeFromRooms(leaver) {
  const room = getPeerRoom(leaver);
  const leaverId = getPeerId(leaver);
  if (!room || !rooms[room]) {
    leaver.__room = "";
    leaver.__role = "";
    leaver.__id = "";
    return;
  }

  const info = rooms[room];

  if (info.host === leaver) {
    const nextEntry = info.clients.entries().next();
    if (!nextEntry.done) {
      const [nextId, nextWs] = nextEntry.value;
      info.clients.delete(nextId);
      info.host = nextWs;
      nextWs.__role = "host";
      const remainingClientIds = [];
      for (const [existingId] of info.clients) remainingClientIds.push(existingId);
      safeSend(nextWs, { type: "role", room, role: "host", clients: remainingClientIds });
      for (const [, cws] of info.clients) {
        safeSend(cws, { type: "host-changed", room, new_host_id: getPeerId(nextWs) });
      }
      broadcastToRoom(info, { type: "peer-left", room, id: leaverId }, null);
      debugLog("[leave] host left, promoted", getPeerId(nextWs), "in room", room);
    } else {
      delete rooms[room];
      debugLog("[leave] host left, room closed (empty)", room);
    }
  } else {
    if (leaverId && info.clients.has(leaverId)) {
      info.clients.delete(leaverId);
      broadcastToRoom(info, { type: "peer-left", room, id: leaverId });
      debugLog("[leave] client left", leaverId, "room", room, "remaining=", info.clients.size);
    }
    closeRoomIfEmpty(room, info);
  }

  leaver.__room = "";
  leaver.__role = "";
  leaver.__id = "";
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/ice-servers") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302"] },
        {
          urls: (process.env.TURN_URLS || "").split(",").filter(Boolean),
          username: process.env.TURN_USERNAME || "",
          credential: process.env.TURN_CREDENTIAL || ""
        }
      ]
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.__id = assignId();

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const type = msg.type;

    if (type === "join" && typeof msg.room === "string") {
      if (supabase) {
        const user = await verifyToken(msg.token);
        if (!user) { safeSend(ws, { type: "error", reason: "unauthorized" }); return; }
        ws.__user_id = user.id;
      }
      const room = msg.room;
      const willBeHost = !rooms[room] || !rooms[room].host;
      if (willBeHost) {
        const hasCredits = await checkBalance(ws.__user_id);
        if (!hasCredits) { safeSend(ws, { type: "error", reason: "insufficient_credits" }); return; }
      }
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

    if (type === "request-promote-client") {
      const room = typeof msg.room === "string" ? msg.room : getPeerRoom(ws);
      const info = getRoomInfo(room);
      if (!info) return;
      if (getPeerRole(ws) !== "host") return;
      const targetId = typeof msg.client_id === "string" ? msg.client_id : "";
      if (!targetId) return;
      const targetWs = info.clients.get(targetId);
      if (!targetWs) return;
      const hasCredits = await checkBalance(targetWs.__user_id);
      if (!hasCredits) { safeSend(ws, { type: "promote-error", reason: "insufficient_credits", client_id: targetId }); return; }
      const oldHost = ws;
      info.host = targetWs;
      info.clients.delete(targetId);
      oldHost.__role = "client";
      const oldId = getPeerId(oldHost) || assignId();
      oldHost.__id = oldId;
      info.clients.set(oldId, oldHost);
      safeSend(oldHost, { type: "role", room, role: "client" });
      targetWs.__role = "host";
      const clientIds = [];
      for (const [existingId] of info.clients) clientIds.push(existingId);
      safeSend(targetWs, { type: "role", room, role: "host", clients: clientIds });
      debugLog("[request-promote-client]", room, "newHostId=", getPeerId(targetWs));
      return;
    }

    if (type === "promote-host") {
      const room = typeof msg.room === "string" ? msg.room : getPeerRoom(ws);
      const info = getRoomInfo(room);
      if (!info) return;
      if (getPeerRole(ws) !== "client") return;
      const hasCredits = await checkBalance(ws.__user_id);
      if (!hasCredits) { safeSend(ws, { type: "promote-error", reason: "insufficient_credits", client_id: getPeerId(ws) }); return; }
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
      const clientIds = [];
      for (const [existingId] of info.clients) clientIds.push(existingId);
      safeSend(ws, { type: "role", room, role: "host", clients: clientIds });
      debugLog("[promote-host]", room, "newHostId=", getPeerId(ws), "clients=", clientIds);
      return;
    }

    if (type === "leave") {
      const room = typeof msg.room === "string" ? msg.room : getPeerRoom(ws);
      if (room === getPeerRoom(ws)) {
        debugLog("[leave] explicit leave", getPeerId(ws), "room", room);
        removeFromRooms(ws);
      }
      return;
    }

    if (type === "ping") { safeSend(ws, { type: "pong" }); return; }

    if (type === "report-usage") {
      const bytes = typeof msg.bytes === "number" && msg.bytes > 0 ? msg.bytes : 0;
      if (ws.__user_id && bytes > 0 && supabase) {
        await supabase.rpc("deduct_bytes", { uid: ws.__user_id, amount: bytes });
        debugLog("[usage] deducted", bytes, "bytes for", ws.__user_id);
      }
      return;
    }

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

server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
