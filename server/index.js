const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const config = require('./config');

// Ensure directories exist
[config.INPUT_DIR, config.OUTPUT_DIR, config.DATA_DIR].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

const app = express();
const server = http.createServer(app);

// WebSocket server for render progress
const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// Make broadcast available to routes
app.set('broadcast', broadcast);

// Middleware
app.use(express.json());
app.use(express.static(path.join(config.ROOT, 'public')));

// Serve input HTML files so Puppeteer and iframe can access them
app.use('/input', express.static(config.INPUT_DIR));
app.use('/output', express.static(config.OUTPUT_DIR));
app.use('/data/thumbs', express.static(path.join(config.DATA_DIR, 'thumbs')));

// Routes
app.use('/api/files', require('./routes/files'));
app.use('/api/timing', require('./routes/timing'));
app.use('/api/render', require('./routes/render'));
app.use('/api/import', require('./routes/import'));
app.use('/api/export', require('./routes/export'));

// Watch input folder for new files
const watcher = chokidar.watch(config.INPUT_DIR, {
  ignored: /(^|[\/\\])\./,
  ignoreInitial: true,
});

watcher.on('add', (filePath) => {
  if (filePath.endsWith('.html')) {
    broadcast({ type: 'file-added', name: path.basename(filePath) });
  }
});

watcher.on('unlink', (filePath) => {
  if (filePath.endsWith('.html')) {
    broadcast({ type: 'file-removed', name: path.basename(filePath) });
  }
});

server.listen(config.PORT, () => {
  console.log(`\n  HTML-to-Video Renderer`);
  console.log(`  ─────────────────────`);
  console.log(`  UI:     http://localhost:${config.PORT}`);
  console.log(`  Input:  ${config.INPUT_DIR}`);
  console.log(`  Output: ${config.OUTPUT_DIR}\n`);
});
