const os = require("os");

function parseWebSocketKey(key) {
  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  return crypto
    .createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

function parseFrame(buffer) {
  const firstByte = buffer[0];
  const isFinalFrame = Boolean(firstByte & 0x80);
  const opcode = firstByte & 0x0f;

  const secondByte = buffer[1];
  const isMasked = Boolean(secondByte & 0x80);
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    payloadLength = buffer.readBigUInt64BE(offset);
    offset += 8;
  }

  let maskingKey;
  if (isMasked) {
    maskingKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  const payload = buffer.slice(offset, offset + payloadLength);

  if (isMasked) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskingKey[i % 4];
    }
  }

  return {
    opcode,
    payload: payload.toString("utf8"),
    isFinalFrame,
  };
}

function createFrame(data) {
  const payload = Buffer.from(data);
  const payloadLength = payload.length;

  let frame;
  let offset = 0;

  if (payloadLength < 126) {
    frame = Buffer.allocUnsafe(2 + payloadLength);
    frame[1] = payloadLength;
    offset = 2;
  } else if (payloadLength < 65536) {
    frame = Buffer.allocUnsafe(4 + payloadLength);
    frame[1] = 126;
    frame.writeUInt16BE(payloadLength, 2);
    offset = 4;
  } else {
    frame = Buffer.allocUnsafe(10 + payloadLength);
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(payloadLength), 2);
    offset = 10;
  }

  frame[0] = 0x81; // FIN + text frame
  payload.copy(frame, offset);

  return frame;
}

function getLocalIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // skip internal and non-IPv4 addresses
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

function generateUID() {
  var firstPart = (Math.random() * 46656) | 0;
  var secondPart = (Math.random() * 46656) | 0;
  firstPart = ("000" + firstPart.toString(36)).slice(-3);
  secondPart = ("000" + secondPart.toString(36)).slice(-3);
  return firstPart + secondPart;
}

module.exports = {
  parseFrame,
  createFrame,
  getLocalIPAddress,
  generateUID,
};
