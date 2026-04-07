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
const activeUsers = new Map();

const FEATURED_ROOMS_CONFIG = {
  "movie-trailers": {
    password: "",
    maxClients: 4,
    videoFile: "/opt/videos/spiderman-trailer.mp4",
    displayName: "RawCast Theater",
  }
};
const featuredInstances = Object.create(null);

const CHUNK_SIZE = 65536;
const META_MAGIC = 0x43484B4D;
const CHUNK_MAGIC = 0x43484B53;
const RESUME_MAGIC = 0x52455355;
const STREAM_DELAY_MS = 2;
const BACKPRESSURE_BYTES = 262144;

class VideoStreamer {
  constructor(clientWs, virtualHostId, videoPath) {
    this.clientWs = clientWs;
    this.virtualHostId = virtualHostId;
    this.videoPath = videoPath;
    this.fileSize = 0;
    this.totalChunks = 0;
    this.currentChunk = 0;
    this.active = false;
    this._idHeader = null;
    try {
      this.fileSize = fs.statSync(videoPath).size;
      this.totalChunks = Math.ceil(this.fileSize / CHUNK_SIZE);
      const idBuf = Buffer.from(virtualHostId, "utf8");
      this._idHeader = Buffer.alloc(2 + idBuf.length);
      this._idHeader.writeUInt16BE(idBuf.length, 0);
      idBuf.copy(this._idHeader, 2);
    } catch (e) {
      console.error("[featured] VideoStreamer init error:", e.message);
    }
  }

  sendMeta() {
    const filename = nodePath.basename(this.videoPath);
    const filenameBuf = Buffer.from(filename, "utf8");
    const meta = Buffer.alloc(29 + filenameBuf.length);
    meta.writeUInt32BE(META_MAGIC, 0);
    const hi = Math.floor(this.fileSize / 0x100000000);
    const lo = this.fileSize >>> 0;
    meta.writeUInt32BE(hi, 4);
    meta.writeUInt32BE(lo, 8);
    meta.writeUInt32BE(CHUNK_SIZE, 12);
    meta.writeUInt32BE(0, 16);
    meta.writeUInt32BE(0, 20);
    meta.writeUInt32BE(0, 24);
    meta[28] = 0;
    filenameBuf.copy(meta, 29);
    this._sendFrame(meta);
    debugLog("[featured] sent META to", this.clientWs.__id, "file=", filename, "size=", this.fileSize, "chunks=", this.totalChunks);
  }

  handleResumeAck(data) {
    if (data.length < 8) return;
    const magic = data.readUInt32BE(0);
    if (magic !== RESUME_MAGIC) return;
    const startChunk = data.readUInt32BE(4);
    debugLog("[featured] RESUME_ACK from", this.clientWs.__id, "startChunk=", startChunk);
    if (startChunk === 0x7FFFFFFF) return;
    this.startStreaming(startChunk);
  }

  startStreaming(startChunk) {
    this.currentChunk = startChunk;
    this.active = true;
    this._streamLoop();
  }

  async _streamLoop() {
    let fd;
    try { fd = fs.openSync(this.videoPath, "r"); } catch (e) {
      console.error("[featured] cannot open video:", e.message);
      this.active = false;
      return;
    }
    const buf = Buffer.alloc(CHUNK_SIZE);
    debugLog("[featured] streaming started for", this.clientWs.__id, "from chunk", this.currentChunk, "/", this.totalChunks);
    while (this.active && this.currentChunk < this.totalChunks) {
      if (!this.clientWs || this.clientWs.readyState !== WebSocket.OPEN) { this.active = false; break; }
      const offset = this.currentChunk * CHUNK_SIZE;
      let bytesRead;
      try { bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, offset); } catch { break; }
      const header = Buffer.alloc(12);
      header.writeUInt32BE(CHUNK_MAGIC, 0);
      header.writeUInt32BE(this.currentChunk, 4);
      header.writeUInt32BE(this.totalChunks, 8);
      const chunk = Buffer.concat([header, buf.subarray(0, bytesRead)]);
      this._sendFrame(chunk);
      this.currentChunk++;
      const buffered = this.clientWs.bufferedAmount || 0;
      if (buffered > BACKPRESSURE_BYTES) {
        await new Promise(r => setTimeout(r, 50));
      } else {
        await new Promise(r => setTimeout(r, STREAM_DELAY_MS));
      }
    }
    try { fs.closeSync(fd); } catch {}
    if (this.active) debugLog("[featured] streaming complete for", this.clientWs.__id, "chunks=", this.currentChunk);
    this.active = false;
  }

  stop() { this.active = false; }

  _sendFrame(payload) {
    if (!this._idHeader || !this.clientWs || this.clientWs.readyState !== WebSocket.OPEN) return;
    const frame = Buffer.concat([this._idHeader, payload]);
    try { this.clientWs.send(frame, { binary: true }); } catch {}
  }
}

class FeaturedRoom {
  constructor(roomId, config) {
    this.roomId = roomId;
    this.baseName = roomId.replace(/-\d+$/, "");
    this.config = config;
    this.__id = "__server_" + roomId + "__";
    this.__display_name = config.displayName || "RawCast";
    this.__guest = false;
    this.__room = roomId;
    this.__role = "host";
    this.readyState = 1;
    this._streamers = new Map();
  }
  send() {}
  ping() {}
  close() {}
  get isAlive() { return true; }
  set isAlive(_v) {}

  onClientJoined(clientWs) {
    const streamer = new VideoStreamer(clientWs, this.__id, this.config.videoFile);
    this._streamers.set(clientWs.__id, streamer);
    setTimeout(() => {
      if (clientWs.readyState === WebSocket.OPEN) streamer.sendMeta();
    }, 500);
  }

  onClientLeft(clientId) {
    const streamer = this._streamers.get(clientId);
    if (streamer) { streamer.stop(); this._streamers.delete(clientId); }
  }

  handleClientBinary(clientId, payload) {
    const streamer = this._streamers.get(clientId);
    if (streamer) streamer.handleResumeAck(payload);
  }
}

function isFeaturedHost(host) { return host instanceof FeaturedRoom; }

function createFeaturedInstance(baseName, instanceNum) {
  const config = FEATURED_ROOMS_CONFIG[baseName];
  if (!config) return null;
  const roomId = instanceNum === 1 ? baseName : baseName + "-" + instanceNum;
  const featured = new FeaturedRoom(roomId, config);
  rooms[roomId] = { host: featured, clients: new Map(), password: config.password || "", featured: true };
  if (!featuredInstances[baseName]) featuredInstances[baseName] = [];
  featuredInstances[baseName].push(roomId);
  debugLog("[featured] created instance", roomId);
  return roomId;
}

function findFeaturedInstance(baseName) {
  const config = FEATURED_ROOMS_CONFIG[baseName];
  if (!config) return null;
  const instances = featuredInstances[baseName] || [];
  for (const roomId of instances) {
    const info = rooms[roomId];
    if (info && info.clients.size < config.maxClients) return roomId;
  }
  return createFeaturedInstance(baseName, instances.length + 1);
}

function initFeaturedRooms() {
  for (const baseName of Object.keys(FEATURED_ROOMS_CONFIG)) {
    const config = FEATURED_ROOMS_CONFIG[baseName];
    if (!fs.existsSync(config.videoFile)) {
      console.error("[featured] WARNING: video file not found:", config.videoFile);
      continue;
    }
    createFeaturedInstance(baseName, 1);
    console.log("[featured] initialized", baseName, "video=", config.videoFile);
  }
}

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

function cleanupFeaturedClient(room, info, leaverId) {
  if (info.clients.has(leaverId)) {
    const featured = info.host;
    featured.onClientLeft(leaverId);
    info.clients.delete(leaverId);
    for (const [, cws] of info.clients) {
      safeSend(cws, { type: "peer-left", room, id: leaverId });
    }
    debugLog("[featured] client left", leaverId, "room", room, "remaining=", info.clients.size);
    const baseName = featured.baseName;
    const instances = featuredInstances[baseName] || [];
    if (info.clients.size === 0 && instances.length > 1 && instances[0] !== room) {
      delete rooms[room];
      const idx = instances.indexOf(room);
      if (idx >= 0) instances.splice(idx, 1);
      debugLog("[featured] overflow instance removed", room);
    }
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

  if (info.featured && isFeaturedHost(info.host)) {
    cleanupFeaturedClient(room, info, leaverId);
    leaver.__room = "";
    leaver.__role = "";
    return;
  }

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
      var isFeatured = !!info.featured;
      roomList.push({ room: r, host: hostName, clients: clientCount, featured: isFeatured });
      totalPlayers += (isFeatured ? 0 : 1) + clientCount;
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
        if (info.host && info.host !== ws && !isFeaturedHost(info.host)) safeSendBinary(info.host, forwarded);
        for (const [, cws] of info.clients) {
          if (cws !== ws) safeSendBinary(cws, forwarded);
        }
      } else {
        let target = null;
        if (targetId === "host" || targetId === getPeerId(info.host)) target = info.host;
        else target = info.clients.get(targetId);
        if (target && isFeaturedHost(target)) {
          target.handleClientBinary(senderId, payload);
        } else if (target) {
          safeSendBinary(target, forwarded);
        }
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const type = msg.type;

    if (type === "join" && typeof msg.room === "string") {
      const token = msg.token || "";
      if (supabase && token) {
        const user = await verifyToken(token);
        if (!user) { safeSend(ws, { type: "error", reason: "unauthorized" }); return; }
        ws.__user_id = user.id;
        ws.__guest = false;
        const prev = activeUsers.get(user.id);
        if (prev && prev !== ws && prev.readyState === WebSocket.OPEN) {
          debugLog("[session] replacing previous connection for", user.id);
          safeSend(prev, { type: "error", reason: "session_replaced" });
          prev.close();
        }
        activeUsers.set(user.id, ws);
      } else if (supabase && !token) {
        ws.__guest = true;
        ws.__user_id = "";
        debugLog("[join] guest connection from", ws.__display_name || "anonymous");
      }
      ws.__display_name = typeof msg.display_name === "string" ? msg.display_name : "";
      if (!ws.__turn_ip && turnGroups.length > 0) {
        let best = turnGroups[0];
        for (const g of turnGroups) { if (g.load < best.load) best = g; }
        ws.__turn_ip = best.ip;
      }
      const room = msg.room;

      if (FEATURED_ROOMS_CONFIG[room]) {
        const instanceId = findFeaturedInstance(room);
        if (!instanceId) { safeSend(ws, { type: "error", reason: "room_not_found" }); return; }
        const fInfo = rooms[instanceId];
        const featured = fInfo.host;
        const peers = [{ id: featured.__id, display_name: featured.__display_name, role: "host", guest: false }];
        for (const [cid, cws] of fInfo.clients) {
          peers.push({ id: cid, display_name: cws.__display_name || "", role: "client", guest: !!cws.__guest });
        }
        fInfo.clients.set(ws.__id, ws);
        ws.__room = instanceId;
        ws.__role = "client";
        debugLog("[featured] client joined", instanceId, "id=", ws.__id, "count=", fInfo.clients.size);
        safeSend(ws, { type: "join-ok", room: instanceId, role: "client", id: ws.__id, host_name: featured.__display_name, host_id: featured.__id, peers, guest: !!ws.__guest, server_hosted: true });
        for (const [, cws] of fInfo.clients) {
          if (cws !== ws) safeSend(cws, { type: "client-joined", room: instanceId, id: ws.__id, display_name: ws.__display_name || "", guest: !!ws.__guest });
        }
        featured.onClientJoined(ws);
        return;
      }

      const createMode = msg.create !== false;
      if (createMode) {
        if (ws.__guest) { safeSend(ws, { type: "error", reason: "guests_cannot_create" }); return; }
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
        safeSend(ws, { type: "join-ok", room, role: "host", id: ws.__id, guest: !!ws.__guest });
        return;
      }
      const info = rooms[room];
      if (!info.host) {
        info.host = ws;
        ws.__room = room;
        ws.__role = "host";
        debugLog("[join] host assigned", room, "id=", ws.__id);
        safeSend(ws, { type: "join-ok", room, role: "host", id: ws.__id, guest: !!ws.__guest });
      } else {
        const peers = [{ id: getPeerId(info.host), display_name: info.host.__display_name || "", role: "host", guest: !!info.host.__guest }];
        for (const [cid, cws] of info.clients) {
          peers.push({ id: cid, display_name: cws.__display_name || "", role: "client", guest: !!cws.__guest });
        }
        info.clients.set(ws.__id, ws);
        ws.__room = room;
        ws.__role = "client";
        debugLog("[join] client joined", room, "id=", ws.__id, "count=", info.clients.size);
        safeSend(ws, { type: "join-ok", room, role: "client", id: ws.__id, host_name: info.host.__display_name || "", host_id: getPeerId(info.host), peers, guest: !!ws.__guest });
        broadcastToRoom(info, { type: "client-joined", room, id: ws.__id, display_name: ws.__display_name || "", guest: !!ws.__guest }, ws);
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
      if (info.featured) return;
      if (getPeerRole(ws) !== "host") return;
      const targetId = typeof msg.client_id === "string" ? msg.client_id : "";
      if (!targetId) return;
      const targetWs = info.clients.get(targetId);
      if (!targetWs) return;
      if (targetWs.__guest) {
        safeSend(ws, { type: "promote-error", client_id: targetId, reason: "guest_cannot_be_host" });
        return;
      }
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
      if (info.featured) return;
      if (getPeerRole(ws) !== "client") return;
      if (ws.__guest) {
        safeSend(ws, { type: "error", reason: "guest_cannot_be_host" });
        return;
      }
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
        if (info.host && !isFeaturedHost(info.host)) safeSend(info.host, msg);
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
      if (target && isFeaturedHost(target)) return;
      if (target && target.readyState === WebSocket.OPEN) target.send(JSON.stringify(msg));
      return;
    }
  });

  ws.on("close", () => {
    releaseTurn(ws);
    removeFromRooms(ws);
    if (ws.__user_id && activeUsers.get(ws.__user_id) === ws) {
      activeUsers.delete(ws.__user_id);
      debugLog("[session] removed active user", ws.__user_id);
    }
  });
  ws.on("error", () => {
    releaseTurn(ws);
    removeFromRooms(ws);
    if (ws.__user_id && activeUsers.get(ws.__user_id) === ws) {
      activeUsers.delete(ws.__user_id);
    }
  });
});

setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, INTERVAL_MS);

initFeaturedRooms();
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
