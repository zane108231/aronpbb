'use strict';

const express = require('express');
const path = require('node:path');

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

app.listen(port, () => {
  console.log(`PBB Live dashboard listening on port ${port}`);
});
