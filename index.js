const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve a test route
app.get('/metrics', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// WebSocket for live metrics
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send live metrics every second
  const interval = setInterval(() => {
    const metric = {
      usersOnline: Math.floor(Math.random() * 100),
      timestamp: new Date(),
    };
    ws.send(JSON.stringify(metric));
  }, 1000);

  ws.on('close', () => clearInterval(interval));
});
