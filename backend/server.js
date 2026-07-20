/**
 * ============================================================================
 *  Video-to-Frames Suite — Backend
 * ============================================================================
 *  This server is intentionally minimal. Per the project's architecture
 *  constraints, ALL heavy lifting (video decoding, frame extraction, canvas
 *  rendering, ZIP packaging, PDF compilation) happens 100% client-side in the
 *  browser. This keeps the app compatible with Vercel's serverless function
 *  memory/timeout limits, since we never buffer video or image binaries on
 *  the server.
 *
 *  This backend currently exists purely as a lightweight health-check /
 *  status service that the frontend dashboard pings to confirm the API
 *  layer is alive. Extend it later with real routes (auth, persistence,
 *  metadata storage, etc.) as needed — the client-side processing pipeline
 *  will not be affected either way.
 * ============================================================================
 */

const express = require('express');

const app = express();
const PORT = 6000;

// NOTE: No CORS middleware is configured here per project requirements
// (assumed to work out-of-the-box in this environment). If you deploy this
// backend to a separate origin than the frontend, you will need to add the
// `cors` package and enable it explicitly.

app.use(express.json());

// ----------------------------------------------------------------------------
// Simple request logger (production-minimalist — no external dependency)
// ----------------------------------------------------------------------------
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.originalUrl}`);
  next();
});

// ----------------------------------------------------------------------------
// GET /api/status — Health check endpoint
// ----------------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'healthy',
    service: 'video-to-frames-suite-backend',
    message: 'Server is up and running.',
    architecture: 'client-side-processing',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------------
// Root route — friendly landing message for anyone hitting the API directly
// ----------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Video-to-Frames Suite API. See GET /api/status for health info.',
  });
});

// ----------------------------------------------------------------------------
// 404 handler
// ----------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ----------------------------------------------------------------------------
// Centralized error handler
// ----------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error.',
  });
});

app.listen(PORT, () => {
  console.log(`✅ Video-to-Frames Suite backend listening on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/status`);
});
