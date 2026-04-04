const http = require("http");
const fs = require("fs");
const nodePath = require("path");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const DEBUG = process.env.DEBUG_SIGNALING === "1";
const INTERVAL_MS = 30000;

const LEMON_API_KEY = process.env.LEMON_API_KEY || "";
const LEMON_WEBHOOK_SECRET = process.env.LEMON_WEBHOOK_SECRET || "";
const LEMON_STORE_ID = process.env.LEMON_STORE_ID || "";

const CREDIT_PACKS = {
  "1gb":  { bytes: 1073741824,   name: "1 GB",  variant_id: process.env.LEMON_VARIANT_1GB  || "" },
  "5gb":  { bytes: 5368709120,   name: "5 GB",  variant_id: process.env.LEMON_VARIANT_5GB  || "" },
  "20gb": { bytes: 21474836480,  name: "20 GB", variant_id: process.env.LEMON_VARIANT_20GB || "" },
  "50gb": { bytes: 53687091200,  name: "50 GB", variant_id: process.env.LEMON_VARIANT_50GB || "" },
};

const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const rooms = Object.create(null);

const turnUsername = process.env.TURN_USERNAME || "";
const turnCredential = process.env.TURN_CREDENTIAL || "";
const turnGroups = [];
const ipMap = Object.create(null);
for (const url of (process.env.TURN_URLS || "").split(",").filter(Boolean)) {
  const m = url.match(/turn:([^:?]+)/);
  if (!m) continue;
  const ip = m[1];
  if (!ipMap[ip]) { ipMap[ip] = { ip, urls: [], load: 0 }; turnGroups.push(ipMap[ip]); }
  ipMap[ip].urls.push(url);
}

function getLeastLoadedTurn() {
  if (turnGroups.length === 0) return null;
  let best = turnGroups[0];
  for (const g of turnGroups) { if (g.load < best.load) best = g; }
  best.load++;
  debugLog("[turn] assigned", best.ip, "load now", best.load, turnGroups.map(g => g.ip + "=" + g.load).join(" "));
  return best;
}

function releaseTurn(ws) {
  if (ws.__turn_ip && ipMap[ws.__turn_ip]) {
    ipMap[ws.__turn_ip].load = Math.max(0, ipMap[ws.__turn_ip].load - 1);
    debugLog("[turn] released", ws.__turn_ip, "load now", ipMap[ws.__turn_ip].load);
    ws.__turn_ip = "";
  }
}

function debugLog(...args) { if (DEBUG) console.log(...args); }
function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function safeSendBinary(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
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
        safeSend(cws, { type: "host-changed", room, new_host_id: getPeerId(nextWs), display_name: nextWs.__display_name || "" });
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
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/ice-servers") {
    const iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
    const turn = getLeastLoadedTurn();
    if (turn) {
      iceServers.push({ urls: turn.urls, username: turnUsername, credential: turnCredential, _ip: turn.ip });
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ iceServers }));
    return;
  }
  if (req.method === "GET" && req.url === "/status") {
    var roomList = [];
    var totalPlayers = 0;
    for (var r in rooms) {
      var info = rooms[r];
      var clientCount = info.clients ? info.clients.size : 0;
      var hostName = info.host ? (info.host.__display_name || "unknown") : "none";
      roomList.push({ room: r, host: hostName, clients: clientCount });
      totalPlayers += 1 + clientCount;
    }
    var wsCount = 0;
    wss.clients.forEach(function() { wsCount++; });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ connections: wsCount, players: totalPlayers, rooms: roomList }));
    return;
  }
  if (req.method === "GET" && req.url === "/turn-status") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ servers: turnGroups.map(g => ({ ip: g.ip, load: g.load, urls: g.urls })) }));
    return;
  }
  if (req.method === "GET" && req.url === "/version") {
    fs.readFile("/opt/updates/version.json", (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "version file not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(data);
    });
    return;
  }
  if (req.method === "GET" && req.url === "/versions") {
    const archiveDir = "/opt/updates/archive";
    fs.readdir(archiveDir, (err, entries) => {
      if (err) { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end("[]"); return; }
      const versions = entries.filter(e => { try { return fs.statSync(nodePath.join(archiveDir, e)).isDirectory(); } catch { return false; } }).sort();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(versions));
    });
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/rollback/")) {
    const ver = req.url.slice("/rollback/".length);
    if (!ver || ver.includes("..") || ver.includes("/")) { res.writeHead(400); res.end("bad version"); return; }
    const archiveDir = nodePath.join("/opt/updates/archive", ver);
    if (!fs.existsSync(archiveDir)) { res.writeHead(404); res.end("version not found"); return; }
    const { execSync } = require("child_process");
    try {
      execSync(`cp -f "${archiveDir}/version.json" /opt/updates/version.json`);
      execSync(`cp -rf "${archiveDir}/patch/"* /opt/updates/patch/ 2>/dev/null || true`);
      execSync(`cp -rf "${archiveDir}/full/windows/"* /opt/updates/full/windows/ 2>/dev/null || true`);
      execSync(`cp -rf "${archiveDir}/full/macos/"* /opt/updates/full/macos/ 2>/dev/null || true`);
      execSync(`cp -rf "${archiveDir}/full/android/"* /opt/updates/full/android/ 2>/dev/null || true`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, version: ver }));
    } catch (e) {
      res.writeHead(500); res.end(e.message);
    }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/updates/")) {
    const filePath = nodePath.join("/opt", req.url);
    const resolved = nodePath.resolve(filePath);
    if (!resolved.startsWith("/opt/updates/")) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.stat(resolved, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": stats.size,
        "Access-Control-Allow-Origin": "*"
      });
      fs.createReadStream(resolved).pipe(res);
    });
    return;
  }
  if (req.method === "POST" && req.url === "/logs") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 512000) { req.destroy(); } });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const userId = (data.user_id || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "_");
        const logsDir = `/opt/logs/${userId}`;
        fs.mkdirSync(logsDir, { recursive: true });
        const ts = (data.timestamp || new Date().toISOString()).replace(/[: ]/g, "-");
        const filename = `${ts}.json`;
        fs.writeFileSync(nodePath.join(logsDir, filename), body);
        const files = fs.readdirSync(logsDir).sort();
        while (files.length > 20) { fs.unlinkSync(nodePath.join(logsDir, files.shift())); }
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Access-Control-Allow-Origin": "*" }); res.end(e.message);
      }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/logs") {
    const logsBase = "/opt/logs";
    fs.readdir(logsBase, (err, users) => {
      if (err) { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end("{}"); return; }
      const result = {};
      for (const u of users) {
        try {
          const uDir = nodePath.join(logsBase, u);
          if (!fs.statSync(uDir).isDirectory()) continue;
          const files = fs.readdirSync(uDir).sort().reverse();
          result[u] = files.slice(0, 5);
        } catch {}
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(result));
    });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/logs/")) {
    const parts = req.url.slice(6).split("/");
    const userId = (parts[0] || "").replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = parts[1] || "";
    if (!userId) { res.writeHead(400); res.end("missing user_id"); return; }
    const userDir = nodePath.join("/opt/logs", userId);
    if (fileName) {
      const safe = fileName.replace(/[^a-zA-Z0-9_.\-]/g, "_");
      const filePath = nodePath.join(userDir, safe);
      if (!filePath.startsWith(userDir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(data);
      });
    } else {
      fs.readdir(userDir, (err, files) => {
        if (err) { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end("[]"); return; }
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(files.sort().reverse()));
      });
    }
    return;
  }
  if (req.method === "POST" && req.url === "/create-checkout") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const packKey = data.pack || "";
        const userId = data.user_id || "";
        const pack = CREDIT_PACKS[packKey];
        if (!pack || !pack.variant_id || !userId) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "invalid pack or user_id" }));
          return;
        }
        const resp = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
          method: "POST",
          headers: { "Authorization": `Bearer ${LEMON_API_KEY}`, "Content-Type": "application/vnd.api+json", "Accept": "application/vnd.api+json" },
          body: JSON.stringify({
            data: {
              type: "checkouts",
              attributes: { checkout_data: { custom: { user_id: userId, pack: packKey } } },
              relationships: {
                store: { data: { type: "stores", id: LEMON_STORE_ID } },
                variant: { data: { type: "variants", id: pack.variant_id } }
              }
            }
          })
        });
        const result = await resp.json();
        const url = result?.data?.attributes?.url || "";
        if (!url) {
          console.log("[lemon] checkout creation failed:", JSON.stringify(result));
          res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "checkout creation failed" }));
          return;
        }
        console.log("[lemon] checkout created for", userId, packKey, url);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ url }));
      } catch (e) {
        console.log("[lemon] create-checkout error:", e.message);
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/lemon-webhook") {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 65536) req.destroy(); });
    req.on("end", async () => {
      try {
        const sig = req.headers["x-signature"] || "";
        if (LEMON_WEBHOOK_SECRET) {
          const expected = crypto.createHmac("sha256", LEMON_WEBHOOK_SECRET).update(raw).digest("hex");
          if (sig !== expected) {
            console.log("[lemon] webhook signature mismatch");
            res.writeHead(403); res.end("bad signature");
            return;
          }
        }
        const payload = JSON.parse(raw);
        const eventName = payload?.meta?.event_name || "";
        if (eventName !== "order_created") {
          res.writeHead(200); res.end("ignored");
          return;
        }
        const custom = payload?.meta?.custom_data || {};
        const userId = custom.user_id || "";
        const packKey = custom.pack || "";
        const pack = CREDIT_PACKS[packKey];
        if (!userId || !pack) {
          console.log("[lemon] webhook missing user_id or pack:", userId, packKey);
          res.writeHead(200); res.end("ok");
          return;
        }
        if (supabase) {
          await supabase.rpc("add_bytes", { p_user_id: userId, p_bytes: pack.bytes });
          console.log("[lemon] credited", pack.name, "to", userId);
        }
        res.writeHead(200); res.end("ok");
      } catch (e) {
        console.log("[lemon] webhook error:", e.message);
        res.writeHead(500); res.end(e.message);
      }
    });
    return;
  }
  const WEBAPP_DIR = "/opt/webapp";
  if (req.method === "GET" && (req.url === "/app" || req.url === "/app/")) {
    const filePath = nodePath.join(WEBAPP_DIR, "index.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache, no-store, must-revalidate" });
      res.end(data);
    });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/app/")) {
    const relPath = req.url.slice(5).split("?")[0];
    if (relPath.includes("..")) { res.writeHead(403); res.end(); return; }
    const filePath = nodePath.resolve(nodePath.join(WEBAPP_DIR, relPath));
    if (!filePath.startsWith(WEBAPP_DIR)) { res.writeHead(403); res.end(); return; }
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) { res.writeHead(404); res.end(); return; }
      const ext = nodePath.extname(filePath).toLowerCase();
      const mimeTypes = {
        ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
        ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
        ".ico": "image/x-icon", ".woff2": "font/woff2"
      };
      const contentType = mimeTypes[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
      fs.createReadStream(filePath).pipe(res);
    });
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

  ws.on("message", async (raw, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf.length < 4) return;
      const room = ws.__room;
      if (!room || !rooms[room]) return;
      const info = rooms[room];
      const senderId = ws.__id || "";
      const targetIdLen = buf.readUInt16BE(0);
      if (buf.length < 3 + targetIdLen) return;
      const targetId = buf.toString("utf8", 2, 2 + targetIdLen);
      const flags = buf[2 + targetIdLen];
      const payload = buf.subarray(3 + targetIdLen);
      const senderIdBuf = Buffer.from(senderId, "utf8");
      const header = Buffer.alloc(2 + senderIdBuf.length);
      header.writeUInt16BE(senderIdBuf.length, 0);
      senderIdBuf.copy(header, 2);
      const forwarded = Buffer.concat([header, payload]);
      if (flags === 0x01) {
        if (info.host && info.host !== ws) safeSendBinary(info.host, forwarded);
        for (const [, cws] of info.clients) {
          if (cws !== ws) safeSendBinary(cws, forwarded);
        }
      } else {
        let target = null;
        if (targetId === "host" || targetId === getPeerId(info.host)) target = info.host;
        else target = info.clients.get(targetId);
        if (target) safeSendBinary(target, forwarded);
      }
      return;
    }
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
      ws.__display_name = typeof msg.display_name === "string" ? msg.display_name : "";
      if (!ws.__turn_ip && turnGroups.length > 0) {
        let best = turnGroups[0];
        for (const g of turnGroups) { if (g.load < best.load) best = g; }
        ws.__turn_ip = best.ip;
      }
      const room = msg.room;
      const createMode = msg.create !== false;
      if (createMode) {
        if (rooms[room] && rooms[room].host) { safeSend(ws, { type: "error", reason: "room_exists" }); return; }
      } else {
        if (!rooms[room] || !rooms[room].host) { safeSend(ws, { type: "error", reason: "room_not_found" }); return; }
        const roomPwd = rooms[room].password || "";
        const msgPwd = msg.password || "";
        if (roomPwd !== msgPwd) { safeSend(ws, { type: "error", reason: "wrong_password" }); return; }
        const totalInRoom = 1 + rooms[room].clients.size;
        if (totalInRoom >= 4) { safeSend(ws, { type: "error", reason: "room_full" }); return; }
      }
      if (!rooms[room]) {
        rooms[room] = { host: ws, clients: new Map(), password: msg.password || "" };
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
        const peers = [{ id: getPeerId(info.host), display_name: info.host.__display_name || "", role: "host" }];
        for (const [cid, cws] of info.clients) {
          peers.push({ id: cid, display_name: cws.__display_name || "", role: "client" });
        }
        info.clients.set(ws.__id, ws);
        ws.__room = room;
        ws.__role = "client";
        debugLog("[join] client joined", room, "id=", ws.__id, "count=", info.clients.size);
        safeSend(ws, { type: "join-ok", room, role: "client", id: ws.__id, host_name: info.host.__display_name || "", host_id: getPeerId(info.host), peers });
        broadcastToRoom(info, { type: "client-joined", room, id: ws.__id, display_name: ws.__display_name || "" }, ws);
      }
      return;
    }

    if (type === "display-name") {
      const name = typeof msg.display_name === "string" ? msg.display_name : "";
      if (name) {
        ws.__display_name = name;
        debugLog("[display-name] updated", getPeerId(ws), "name=", name);
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
        await supabase.rpc("deduct_bytes", { p_user_id: ws.__user_id, p_bytes: bytes });
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
        const to = typeof msg.to === "string" ? msg.to : null;
        if (to) {
          const target = info.clients.get(to);
          if (target) safeSend(target, msg);
        } else {
          for (const [, cws] of info.clients) safeSend(cws, msg);
        }
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
      if (to === "host" || to === getPeerId(info.host)) target = info.host;
      else target = info.clients.get(to);

      if (DEBUG) debugLog("[relay]", type, "room=", room, "from=", from, "to=", to, !!target);
      if (target && target.readyState === WebSocket.OPEN) target.send(JSON.stringify(msg));
      return;
    }
  });

  ws.on("close", () => { releaseTurn(ws); removeFromRooms(ws); });
  ws.on("error", () => { releaseTurn(ws); removeFromRooms(ws); });
});

setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, INTERVAL_MS);

server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
