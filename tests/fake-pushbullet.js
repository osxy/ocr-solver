/**
 * Local Pushbullet test double: the REST surface this app uses plus a minimal
 * WebSocket server that can emit `tickle`/`nop`, drop the socket, and inject
 * failures. No Pushbullet account, no token, no network.
 *
 * The WebSocket server is hand-rolled against RFC 6455 rather than pulled in as a
 * dependency: the app has no WebSocket server requirement, and ~70 lines of frame
 * code keeps the "no new dependencies" rule intact. It only needs to speak well
 * enough for Node's built-in WebSocket client (unmasked server frames, masked
 * client frames, ping/pong/close).
 *
 * The clock is part of the double and is shared with the code under test, so a
 * responder that waits out its 3 s rate limit advances simulated time instead of
 * making the suite actually sleep.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

export async function startFakePushbullet({ token = 'o.test-token', clockStart = 1_700_000_000 } = {}) {
  const state = {
    token,
    pushes: [],
    files: new Map(),
    requests: [],
    failures: [],
    clients: new Set(),
    nextId: 1,
    connectionCount: 0,
  };

  let clockSeconds = clockStart;
  const clock = {
    now: () => clockSeconds,
    set: (seconds) => {
      clockSeconds = seconds;
    },
    advance: (seconds) => {
      clockSeconds += seconds;
    },
    sleep: async (ms) => {
      clockSeconds += ms / 1000;
    },
  };

  let baseUrl = '';

  function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  function sendTo(conn, message) {
    if (!conn.socket.writable) return;
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    try {
      conn.socket.write(encodeFrame(text, 0x1));
    } catch {
      // socket is going away; the listener's reconnect path covers it
    }
  }

  function broadcast(message) {
    for (const conn of state.clients) sendTo(conn, message);
  }

  function onSocketData(conn, chunk) {
    conn.buffer = conn.buffer?.length ? Buffer.concat([conn.buffer, chunk]) : chunk;
    for (;;) {
      const buffer = conn.buffer;
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;

      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
      conn.buffer = buffer.subarray(offset + maskLength + length);

      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      if (opcode === 0x9) {
        conn.socket.write(encodeFrame(payload, 0xa)); // ping -> pong
      } else if (opcode === 0x8) {
        try {
          conn.socket.write(encodeFrame(payload, 0x8));
        } catch {
          // peer is already gone
        }
        conn.socket.end();
        state.clients.delete(conn);
        return;
      }
      // Text/binary frames from the client are ignored: the protocol is one-way here.
    }
  }

  function takeFailure(method, path) {
    const index = state.failures.findIndex((f) => f.method === method && f.path === path && f.times > 0);
    if (index === -1) return null;
    const failure = state.failures[index];
    failure.times -= 1;
    if (failure.times <= 0) state.failures.splice(index, 1);
    return failure;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsedBody = null;
      if (raw) {
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          parsedBody = raw;
        }
      }
      state.requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: parsedBody,
        headers: req.headers,
      });

      const failure = takeFailure(req.method, url.pathname);
      if (failure) {
        return json(res, failure.status, failure.body ?? { error: { type: 'rate_limit', message: 'simulated failure' } });
      }

      // Pre-signed S3 URLs carry no auth; the fetcher must not send the token here.
      if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        const iden = decodeURIComponent(url.pathname.slice('/files/'.length));
        const file = state.files.get(iden);
        if (!file) return json(res, 404, { error: { message: 'no such file' } });
        res.writeHead(200, { 'content-type': file.mime, 'content-length': file.data.length });
        res.end(file.data);
        return;
      }

      if (!(typeof req.headers['access-token'] === 'string' && req.headers['access-token'] === token)) {
        return json(res, 401, { error: { type: 'invalid_token', message: 'missing or invalid access token' } });
      }

      if (req.method === 'GET' && url.pathname === '/v2/pushes') {
        const after = url.searchParams.get('modified_after');
        const limitRaw = Number(url.searchParams.get('limit') ?? 100);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
        let list = [...state.pushes].sort((a, b) => a.modified - b.modified);
        if (after != null && after !== '') list = list.filter((push) => push.modified > Number(after));
        return json(res, 200, { pushes: list.slice(0, limit) });
      }

      if (req.method === 'POST' && url.pathname === '/v2/pushes') {
        if (!parsedBody || typeof parsedBody !== 'object') {
          return json(res, 400, { error: { type: 'invalid_request', message: 'body required' } });
        }
        const push = {
          ...parsedBody,
          iden: `push-${state.nextId++}`,
          created: clock.now(),
          modified: clock.now(),
          active: true,
          dismissed: false,
          direction: 'outgoing', // created through the API, i.e. by us
          sender_iden: 'me',
        };
        state.pushes.push(push);
        return json(res, 200, push);
      }

      return json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
    });
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    if (!url.pathname.startsWith('/websocket/') || !key) {
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    const conn = { socket, buffer: Buffer.alloc(0) };
    state.clients.add(conn);
    state.connectionCount += 1;
    socket.on('data', (chunk) => onSocketData(conn, chunk));
    socket.on('close', () => state.clients.delete(conn));
    socket.on('error', () => state.clients.delete(conn));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    streamUrl: `ws://127.0.0.1:${port}/websocket/${token}`,
    token,
    clock,
    state,
    get pushes() {
      return state.pushes;
    },
    /** Our own replies, the ones the responder sent. */
    get notePushes() {
      return state.pushes.filter((push) => push.type === 'note');
    },
    get filePushes() {
      return state.pushes.filter((push) => push.type === 'file');
    },
    get requests() {
      return state.requests;
    },
    get connectionCount() {
      return state.connectionCount;
    },
    get openStreams() {
      return state.clients.size;
    },

    /** Add an inbound file push and serve its bytes on a fake pre-signed URL. */
    pushImage({
      iden = null,
      fileName = 'puzzle.png',
      fileType = 'image/png',
      data = Buffer.alloc(0),
      modified = null,
      direction = 'incoming',
      senderIden = 'sender-user',
      senderEmail = 'sender@example.test',
      sourceDeviceIden = 'dev-phone',
      active = true,
    } = {}) {
      clock.advance(0.001); // keep modified strictly increasing
      const sequence = state.nextId++;
      const id = iden ?? `file-${sequence}`;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '');
      state.files.set(id, { data: buffer, mime: fileType || 'application/octet-stream' });
      const push = {
        iden: id,
        type: 'file',
        active,
        direction,
        file_name: fileName,
        file_type: fileType,
        file_url: `${baseUrl}/files/${id}`,
        file_size: buffer.length,
        created: clock.now(),
        modified: modified ?? clock.now(),
        sender_iden: senderIden,
        sender_email: senderEmail,
        source_device_iden: sourceDeviceIden,
      };
      state.pushes.push(push);
      return push;
    },

    /** Add an arbitrary push object (a note, a deleted file, ...). */
    pushRaw(push) {
      clock.advance(0.001);
      const stored = {
        iden: push.iden ?? `raw-${state.nextId++}`,
        active: true,
        created: clock.now(),
        modified: clock.now(),
        ...push,
      };
      state.pushes.push(stored);
      return stored;
    },

    tickle(subtype = 'push') {
      broadcast({ type: 'tickle', subtype });
    },
    nop() {
      broadcast({ type: 'nop' });
    },
    sendRaw(message) {
      broadcast(message);
    },

    /** Sever every live stream connection so the client has to reconnect. */
    dropStream() {
      const count = state.clients.size;
      for (const conn of state.clients) {
        try {
          conn.socket.destroy();
        } catch {
          // already destroyed
        }
      }
      state.clients.clear();
      return count;
    },

    /** Make the next `times` matching requests fail with `status`. */
    failNext({ status = 429, times = 1, method = 'POST', path = '/v2/pushes', body = null } = {}) {
      state.failures.push({ status, times, method, path, body });
    },

    async close() {
      for (const conn of state.clients) {
        try {
          conn.socket.destroy();
        } catch {
          // already destroyed
        }
      }
      state.clients.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
