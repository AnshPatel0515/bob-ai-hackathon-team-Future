'use strict';
require('dotenv').config();

const http          = require('http');
const app           = require('./src/app');
const { pool }      = require('./src/config/db');
const socketManager = require('./src/realtime/socketManager');
const periodicJobs  = require('./src/realtime/periodicJobs');

const PORT = parseInt(process.env.PORT || '3000', 10);
l  // 1. Verify database connection
  try {
    const { rows } = await pool.query('SELECT NOW() AS db_time');
    console.log(`[DB] Connected — server time: ${rows[0].db_time}`);
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    console.error('Ensure PostgreSQL is running and .env is configured correctly.');
    process.exit(1);
  }

  // 2. Create HTTP server (wraps Express so Socket.IO can share it)
  const httpServer = http.createServer(app);

  // 3. Attach Socket.IO
  socketManager.init(httpServer);

  // 4. Start periodic background jobs
  periodicJobs.start();

  // 5. Listen
  httpServer.listen(PORT, () => {
    console.log(`[API] Supply Chain API  →  http://localhost:${PORT}`);
    console.log(`[WS]  Socket.IO         →  ws://localhost:${PORT}`);
    console.log(`[API] Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // 6. Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[API] ${signal} received — shutting down gracefully`);
    periodicJobs.stop();
    httpServer.close(async () => {
      await pool.end();
      console.log('[DB] Pool closed');
      process.exit(0);
    });
    // Force exit after 10 s if connections don't drain
    setTimeout(() => process.exit(1), 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('[API] Unhandled promise rejection:', reason);
  });
}

start();
