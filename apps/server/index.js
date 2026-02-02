const http = require("http");
const { getLocalIPAddress, generateUID } = require("./utils");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = 8080;
const LOCAL_IP = getLocalIPAddress();
const CHAT_CLIENT_URL = `http://${LOCAL_IP}:${PORT}/chat`;
const SERVER_URL = `http://${LOCAL_IP}:${PORT}`;
const WEB_SOCKET_URL = `ws://${LOCAL_IP}:${PORT}`;

const adminHTML = fs.readFileSync(
  path.join(__dirname, "../ui/admin.html"),
  "utf8",
);

const chatHTML = fs.readFileSync(
  path.join(__dirname, "../ui/chat.html"),
  "utf8",
);

const clients = new Map(); // Map<userId, {ws, username, room_id, ip}>
const rooms = new Map(); // Map<room_id, Set<userId>>

// ==== main HTTP server ==== //
const server = http.createServer((req, res) => {
  // enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // ==== GET ALL USERS ON THE WIFI NETWORK ==== //
  if (req.url === "/peers" && req.method === "GET") {
    const { exec } = require("child_process");

    // use arp command to get devices on network
    exec("arp -a", (error, stdout, stderr) => {
      if (error || stderr) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error.message || String(stderr),
          }),
        );
      }

      // parse ARP table to get devices on network
      const arpEntries = [];
      const lines = stdout.split("\n");

      lines.forEach((line) => {
        // match IP addresses and MAC addresses from arp output
        const ipMatch = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);

        if (ipMatch) {
          const ip = ipMatch[1];

          // check if this IP has an active WebSocket connection
          const connectedClient = Array.from(clients.entries()).find(
            ([_, client]) => {
              return client.ws && client.ws.remoteAddress === ip;
            },
          );

          arpEntries.push({
            ip,
            is_connected: !!connectedClient,
            username: connectedClient ? connectedClient[1].username : null,
          });
        }
      });

      // also include WebSocket clients that might not be in ARP table yet
      const connectedPeers = Array.from(clients.entries()).map(
        ([userId, client]) => ({
          id: userId,
          username: client.username,
          room_id: client.room_id || null,
          type: "websocket",
          ip: client.ip,
        }),
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            network_peers: arpEntries,
            connected_peers: connectedPeers,
            peers_count: arpEntries.length,
            connected_peers_count: connectedPeers.length,
          },
        }),
      );
    });
    return;
  }

  // ==== GET PUBLIC INFO ABOUT THE WIFI NETWORK ==== //
  if (req.url === "/info" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: {
          server_url: SERVER_URL,
          web_socket_url: WEB_SOCKET_URL,
          chat_client_url: CHAT_CLIENT_URL,
        },
      }),
    );
    return;
  }

  // ==== GET ADMIN PANEL ==== //
  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(adminHTML),
    });
    res.end(adminHTML);
    return;
  }

  // ==== GET CHAT VIEW ==== //
  if (req.url === "/chat" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(chatHTML),
    });
    res.end(chatHTML);
    return;
  }

  // ==== GET CURRENT PEER INFO ==== //
  if (req.url === "/me" && req.method === "GET") {
    const ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
    const ipAddress = ip.split(",")[0].trim();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: {
          ip: ipAddress.replace("::ffff:", ""),
        },
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocket.Server({ server });

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room_id, data, excludeUserId = null) {
  const room = rooms.get(room_id);
  if (!room) return;
  for (const userId of room) {
    if (userId === excludeUserId) continue;
    const client = clients.get(userId);
    if (client) send(client.ws, data);
  }
}

wss.on("connection", (ws, req) => {
  const userId = "P_" + generateUID();

  console.log("PEER CONNECTED", userId);

  const client = {
    ws,
    username: "Anonymous",
    room_id: null,
  };

  clients.set(userId, client);

  send(ws, {
    type: "connected",
    userId,
  });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    handleMessage(userId, message);
  });

  ws.on("close", () => {
    cleanupClient(userId);
  });

  ws.on("error", () => {
    cleanupClient(userId);
  });
});

function cleanupClient(userId) {
  const client = clients.get(userId);
  if (!client) return;

  if (client.room_id) {
    const room = rooms.get(client.room_id);
    if (room) {
      room.delete(userId);
      broadcast(client.room_id, {
        type: "user_left",
        username: client.username,
      });

      if (room.size === 0) rooms.delete(client.room_id);
    }
  }

  clients.delete(userId);
}

function handleMessage(userId, msg) {
  const client = clients.get(userId);
  if (!client) return;

  const { type, payload } = msg;

  switch (type) {
    case "set_username":
      client.username = payload?.username || "Anonymous";
      client.ip = payload?.ip || "0.0.0.0";
      send(client.ws, {
        type: "username_set",
        username: client.username,
        ip: client.ip,
      });
      break;

    case "create_room": {
      const room_id = "R_" + generateUID();

      console.log("ROOM CREATED", room_id);

      rooms.set(room_id, new Set([userId]));
      client.room_id = room_id;

      send(client.ws, {
        type: "room_created",
        room_id,
      });
      break;
    }

    case "join_room": {
      const room_id = payload?.room_id;
      if (!rooms.has(room_id)) {
        send(client.ws, { type: "error", message: "Room not found" });
        return;
      }

      if (client.room_id) {
        rooms.get(client.room_id)?.delete(userId);
      }

      client.room_id = room_id;
      rooms.get(room_id).add(userId);

      send(client.ws, { type: "room_joined", room_id });

      broadcast(
        room_id,
        {
          type: "user_joined",
          username: client.username,
        },
        userId,
      );
      break;
    }

    case "message":
      if (!client.room_id) {
        send(client.ws, { type: "error", message: "Not in a room" });
        return;
      }

      broadcast(client.room_id, {
        type: "message",
        username: client.username,
        text: payload?.text,
        timestamp: Date.now(),
      });
      break;

    default:
      send(client.ws, { type: "error", message: "Unknown type" });
  }
}

server.listen(PORT, () => {
  console.log("=================================");
  console.log("    🟢 SERVER UP AND RUNNING 🟢");
  console.log("=================================");
  console.log(`PORT: ${PORT}`);
  console.log(`LOCAL IP: ${LOCAL_IP}`);
  console.log(`WEBSOCKET URL: ${WEB_SOCKET_URL}`);
  console.log(`SERVER URL: ${SERVER_URL}`);
  console.log(`CHAT PORTAL: ${CHAT_CLIENT_URL}`);
  console.log("=================================");
});
