'use strict';

const express = require('express');
const path = require('node:path');
const cenc = require('./cenc');

const app = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);
const publicDirectory = path.join(__dirname, 'public');

const streams = [
  { id: 'all', name: 'All Access' },
  { id: 'ext', name: 'External Den' },
  { id: 'din', name: 'Dining Area' },
  { id: 'main', name: 'PBB Collab 3.0 Live' }
];
const activeViewers = new Map();
const viewerTimeoutMs = 30_000;
const chatMessages = [];
const chatClients = new Set();
const chatHistoryLimit = 100;
let nextChatMessageId = Date.now();

app.disable('x-powered-by');
app.use('/vendor/shaka-player', express.static(path.join(__dirname, 'node_modules', 'shaka-player', 'dist')));
app.use(express.static(publicDirectory));

app.post('/api/viewers/heartbeat', express.json({ limit: '1kb' }), (request, response) => {
  const viewerId = request.body && request.body.id;
  if (typeof viewerId !== 'string' || !/^[a-z0-9-]{16,64}$/i.test(viewerId)) {
    return response.status(400).json({ error: 'A valid viewer ID is required.' });
  }

  const now = Date.now();
  for (const [id, lastSeen] of activeViewers) {
    if (now - lastSeen >= viewerTimeoutMs) {
      activeViewers.delete(id);
    }
  }

  activeViewers.set(viewerId, now);
  response.set('Cache-Control', 'no-store');
  return response.json({ count: activeViewers.size });
});

app.get('/api/chat/messages', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  return response.json({ messages: chatMessages.slice(-50) });
});

app.get('/api/chat/stream', (_request, response) => {
  response.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.flushHeaders();
  chatClients.add(response);
  response.write(`event: history\ndata: ${JSON.stringify(chatMessages.slice(-50))}\n\n`);

  const keepAlive = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) {
      response.write(': keep-alive\n\n');
    }
  }, 15_000);

  response.on('close', () => {
    clearInterval(keepAlive);
    chatClients.delete(response);
  });
});

function broadcastChatMessage(message) {
  const event = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  for (const client of chatClients) {
    if (client.destroyed || client.writableEnded) {
      chatClients.delete(client);
    } else {
      client.write(event);
    }
  }
}

app.post('/api/chat/messages', express.json({ limit: '2kb' }), (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
  if (!name || name.length > 24 || !text || text.length > 280) {
    return response.status(400).json({ error: 'Enter a name (up to 24 characters) and a message (up to 280 characters).' });
  }

  const message = {
    id: ++nextChatMessageId,
    name,
    text,
    createdAt: new Date().toISOString()
  };
  chatMessages.push(message);
  if (chatMessages.length > chatHistoryLimit) {
    chatMessages.shift();
  }
  broadcastChatMessage(message);

  response.set('Cache-Control', 'no-store');
  return response.status(201).json({ message });
});

app.get('/api/streams', (_request, response) => {
  response.json(streams);
});

/* ========================================================
   CENC DECRYPTION PROXY (iOS / unencrypted segment serving)
   ======================================================== */
const proxyStreams = {
  all: {
    url: 'https://absp-live.akamaized.net/dash/live/2099522/pbbcollab30allaccesslivestream/',
    key: '0c5ed4f9db9d4ee61bbc91b3a51ef8b5',
    token: '88ff41f2e8ae28371d8afc70b7121245'
  },
  ext: {
    url: 'https://absp-live.akamaized.net/dash/live/2099522/pbbcollab30allaccesslivestream-externalden/',
    key: 'af07292597f692726dcac2bd297ddf8e',
    token: 'd704f1b3c3b43631b5c17acd79b38d5d'
  },
  din: {
    url: 'https://absp-live.akamaized.net/dash/live/2099522/pbbcollab30allaccesslivestream-diningarea/',
    key: '3e6de4afee1eff8e14f9506b76ac9ee6',
    token: '6dc8970921e7780c5f0a6b1620999461'
  },
  main: {
    url: 'https://absp-live.akamaized.net/dash/live/2099522/pinoybigbrothercollabedition30live/',
    key: 'f5e17f169ff05ea40c5d3f065f523942',
    token: '797f84fb9a3b7610edc86bfe1f8d1743'
  }
};

const decryptedCache = new Map();
const CACHE_LIMIT = 800;
const CENC_OPTS = { ivMode: 'high', counterMode: 'continuous', coverRemainder: true };

function cacheGet(ch, file) {
  return decryptedCache.get(`${ch}:${file}`);
}

function cacheSet(ch, file, buf) {
  const key = `${ch}:${file}`;
  decryptedCache.delete(key);
  decryptedCache.set(key, buf);
  if (decryptedCache.size > CACHE_LIMIT) {
    decryptedCache.delete(decryptedCache.keys().next().value);
  }
}

async function fetchRemote(fileUrl) {
  const response = await fetch(fileUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X)' }
  });
  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sendMedia(response, buf) {
  response.set({
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store'
  });
  response.send(buf);
}

app.get('/api/segment', async (request, response) => {
  const { ch, file } = request.query;
  const streamConfig = proxyStreams[ch];

  if (!streamConfig || typeof file !== 'string' || file.includes('..') || file.includes('/')) {
    return response.status(404).send('Segment not found');
  }

  try {
    const isInit = /_init\.mp4$/i.test(file);
    let buf = cacheGet(ch, file);
    if (!buf) {
      const remote = await fetchRemote(`${streamConfig.url}${file}?token=${streamConfig.token}`);
      buf = isInit
        ? cenc.decryptInit(remote)
        : cenc.decryptSegment(remote, streamConfig.key, CENC_OPTS);
      cacheSet(ch, file, buf);
    }
    return sendMedia(response, buf);
  } catch (error) {
    console.error(`Error proxying segment (${file}):`, error.message);
    return response.status(500).send('Failed to fetch/decrypt segment');
  }
});

app.get('/stream/:feedId.mpd', async (request, response) => {
  const feedId = request.params.feedId;
  const streamConfig = proxyStreams[feedId];

  if (!streamConfig) {
    return response.status(404).send('Feed not found');
  }

  try {
    const manifestUrl = `${streamConfig.url}manifest.mpd?token=${streamConfig.token}`;
    const upstream = await fetch(manifestUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X)' }
    });
    if (!upstream.ok) {
      throw new Error(`Upstream HTTP ${upstream.status}`);
    }
    let mpdContent = await upstream.text();

    mpdContent = mpdContent.replace(/media="([^"]+)"/g, (match, filename) => {
      return `media="/api/segment?ch=${feedId}&file=${filename}"`;
    });
    mpdContent = mpdContent.replace(/initialization="([^"]+)"/g, (match, filename) => {
      return `initialization="/api/segment?ch=${feedId}&file=${filename}"`;
    });
    mpdContent = mpdContent.replace(/<ContentProtection[\s\S]*?<\/ContentProtection>/g, '');
    mpdContent = mpdContent.replace(/<ContentProtection[^\/]*?\/>/g, '');

    response.set({
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/dash+xml',
      'Cache-Control': 'no-store'
    });
    response.send(mpdContent);
  } catch (error) {
    console.error('Manifest proxy error:', error.message);
    return response.status(500).send('Failed to fetch manifest');
  }
});

app.listen(port, () => {
  console.log(`PBB Live dashboard listening on port ${port}`);
});
