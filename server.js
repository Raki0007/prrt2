'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { attachSocket } = require('./src/socket');
const api = require('./src/routes');
const { DB_PATH } = require('./src/db');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// API
app.use('/api', api);

// Static frontend
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = http.createServer(app);
attachSocket(server);

server.listen(PORT, HOST, () => {
  console.log(`prrt2 chat server listening on http://${HOST}:${PORT}`);
  console.log(`database: ${DB_PATH}`);
});
