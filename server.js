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

app.disable('x-powered-by');
app.use(express.static(publicDirectory));

app.get('/api/streams', (_request, response) => {
  response.json(streams);
});

app.listen(port, () => {
  console.log(`PBB Live dashboard listening on port ${port}`);
});
