require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const http = require('http');
const socketIo = require('socket.io');
const metricsRouter = require('./routes/metrics');
const chainEvents = require('./services/chainEvents');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(express.json());
// Rate limit metrics endpoints: max 60 requests per minute
const metricsLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
// Register metrics routes
app.use('/metrics', metricsLimiter);
app.use('/metrics', metricsRouter);
// Root health endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Analytics service running', metricsBase: '/metrics' });
});

const PORT = process.env.PORT || 4000;
// start socket listener, chain events & server only when run directly (not required by tests)
if (require.main === module) {
  // socket events & chain subscription will be initialized when running directly
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
  });
  chainEvents.start(io);
  server.listen(PORT, () => console.log(`Analytics service listening on ${PORT}`));
}

// export app for testing
module.exports = app;
