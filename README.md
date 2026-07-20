# Video-to-Frames Suite

A MERN-style dashboard where **all video/image processing happens client-side**
(HTML5 Canvas), so it can be deployed on Vercel without hitting serverless
memory or timeout limits. The Express backend is intentionally minimal — a
health-check API only.

## Run the backend

```bash
cd backend
npm install
npm start
# -> http://localhost:5000/api/status
```

## Run the frontend

```bash
cd frontend
npm install
npm run dev
# -> http://localhost:5173
```

`VideoProcessor.jsx` calls `http://localhost:5000` directly (hardcoded, no
`.env`, per project requirements) — make sure the backend is running so the
"API Online" status pill goes green. The frame-extraction pipeline itself
works fully offline from the backend's perspective; the status check is
purely cosmetic.

## Notes on memory management

- Every video upload revokes the previous `URL.createObjectURL()` reference
  before creating a new one (see `handleFileChange` in `VideoProcessor.jsx`).
- The object URL is also revoked on component unmount.
- Extracted frames are stored as base64 JPEG strings in React state — for
  very long videos with very short intervals, this can grow large. The UI
  surfaces a live estimate of the in-memory footprint next to the export
  buttons so users can gauge this before exporting.
- The hidden `<canvas>` is reused across the whole extraction run rather than
  recreated per frame, avoiding repeated GPU/CPU buffer allocation.
