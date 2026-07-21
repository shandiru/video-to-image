/**
 * ============================================================================
 *  VideoProcessor.jsx
 * ============================================================================
 *  The core of the Video-to-Frames Suite dashboard.
 *
 *  ARCHITECTURE NOTE:
 *  Every expensive operation in this component (video decoding, per-frame
 *  canvas rendering, ZIP compression, PDF compilation) runs entirely in the
 *  browser. Nothing is uploaded to the backend. This is deliberate: it lets
 *  the app live on Vercel without ever touching a serverless function's
 *  memory ceiling or execution-time limit, no matter how large the source
 *  video or how many frames are extracted.
 *
 *  The backend (http://localhost:5000) is only used for a lightweight
 *  "/api/status" ping so the dashboard can show whether the API layer is
 *  reachable — it never receives video or image data.
 * ============================================================================
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { jsPDF } from 'jspdf';

// Hardcoded per project constraints — no .env files, no dynamic config.
const API_BASE_URL = 'https://video-to-image-tclx.vercel.app';

// ----------------------------------------------------------------------------
// Small presentational helpers
// ----------------------------------------------------------------------------

function StatusPill({ status }) {
  const config = {
    checking: { label: 'Checking API…', dot: 'bg-amber-400', text: 'text-amber-300', ring: 'ring-amber-400/30' },
    online: { label: 'API Online', dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'ring-emerald-400/30' },
    offline: { label: 'API Offline', dot: 'bg-rose-400', text: 'text-rose-300', ring: 'ring-rose-400/30' },
  }[status];

  return (
    <div className={`inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 ring-1 ${config.ring} backdrop-blur`}>
      <span className={`h-2 w-2 rounded-full ${config.dot} ${status === 'checking' ? 'animate-pulse' : ''}`} />
      <span className={`text-xs font-medium tracking-wide ${config.text}`}>{config.label}</span>
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-[11px] font-medium uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-semibold ${accent || 'text-slate-100'}`}>{value}</p>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Main component
// ----------------------------------------------------------------------------

export default function VideoProcessor() {
  // ---- Backend status ------------------------------------------------------
  const [apiStatus, setApiStatus] = useState('checking');

  // ---- Source video state ---------------------------------------------------
  const [videoFile, setVideoFile] = useState(null);
  const [videoURL, setVideoURL] = useState(null);
  const [videoMeta, setVideoMeta] = useState({ duration: 0, width: 0, height: 0 });

  // ---- Extraction configuration ---------------------------------------------
  const [mode, setMode] = useState('interval'); // 'interval' | 'splits'
  const [intervalSeconds, setIntervalSeconds] = useState(1);
  const [totalSplits, setTotalSplits] = useState(24);

  // ---- Processing state -------------------------------------------------
  const [frames, setFrames] = useState([]); // [{ id, dataUrl, timestamp }]
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // ---- Refs ------------------------------------------------------------
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const objectUrlRef = useRef(null); // tracked separately so cleanup always has the latest value
  const cancelRequestedRef = useRef(false);

  // ==========================================================================
  // Backend health check
  // ==========================================================================
  useEffect(() => {
    let isMounted = true;

    const checkStatus = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/status`);
        if (!isMounted) return;
        setApiStatus(res.ok ? 'online' : 'offline');
      } catch (err) {
        if (isMounted) setApiStatus('offline');
      }
    };

    checkStatus();
    const intervalId = setInterval(checkStatus, 15000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, []);

  // ==========================================================================
  // MEMORY MANAGEMENT: revoke the previous object URL whenever it changes,
  // and again on unmount. Object URLs pin the underlying video Blob in
  // memory until explicitly revoked — for large video files, forgetting
  // this is a fast route to a memory leak / tab crash.
  // ==========================================================================
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  // ==========================================================================
  // File selection
  // ==========================================================================
  const handleFileChange = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('video/')) {
      setErrorMessage('Please select a valid video file.');
      return;
    }

    // Revoke the previous object URL before creating a new one — otherwise
    // every re-upload silently leaks the prior video's memory allocation.
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }

    const newUrl = URL.createObjectURL(file);
    objectUrlRef.current = newUrl;

    setVideoFile(file);
    setVideoURL(newUrl);
    setVideoMeta({ duration: 0, width: 0, height: 0 });
    setFrames([]); // clear previous frames — each holds a full-resolution base64 WebP string
    setErrorMessage('');
    setProgress({ done: 0, total: 0 });
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setVideoMeta({
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    });
  }, []);

  // ==========================================================================
  // Build the ordered list of timestamps to capture, based on the selected
  // extraction mode.
  // ==========================================================================
  const buildTimestamps = useCallback(() => {
    const { duration } = videoMeta;
    if (!duration || duration <= 0) return [];

    const timestamps = [];
    const SAFETY_MARGIN = 0.05; // stay slightly clear of the exact end-of-stream

    if (mode === 'interval') {
      // NOTE: browsers cannot actually decode distinct frames faster than the
      // source video's own frame rate (commonly ~1/24s–1/60s). Steps smaller
      // than that will frequently land on the same decoded frame — the
      // 'seeked' event still fires correctly, but consecutive frames may be
      // visually identical. We still honor arbitrarily small steps here.
      const step = Math.max(0.000001, Number(intervalSeconds) || 1);
      for (let t = 0; t < duration - SAFETY_MARGIN; t += step) {
        timestamps.push(Number(t.toFixed(6)));
      }
      // Always guarantee at least one frame for very short clips.
      if (timestamps.length === 0) timestamps.push(0);
    } else {
      const splits = Math.max(1, Math.floor(Number(totalSplits) || 1));
      const sectionLength = duration / splits;
      for (let i = 0; i < splits; i += 1) {
        // Capture the midpoint of each section — the most representative
        // frame for that slice of the timeline.
        const t = Math.min(duration - SAFETY_MARGIN, i * sectionLength + sectionLength / 2);
        timestamps.push(Number(Math.max(0, t).toFixed(3)));
      }
    }

    return timestamps;
  }, [videoMeta, mode, intervalSeconds, totalSplits]);

  // ==========================================================================
  // Seek the hidden <video> element to an exact timestamp and resolve once
  // the browser has actually decoded that frame (the 'seeked' event).
  // ==========================================================================
  const seekToTime = useCallback((video, time) => {
    return new Promise((resolve, reject) => {
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Failed to seek to timestamp ${time}s`));
      };
      const cleanup = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);

      // Edge case: if the target time is (numerically) identical to the
      // video's current time, the browser will NOT fire a 'seeked' event
      // because no seek actually occurs. We detect this and resolve on the
      // next animation frame instead so the pipeline never stalls.
      if (Math.abs(video.currentTime - time) < 0.001) {
        cleanup();
        requestAnimationFrame(() => resolve());
        return;
      }

      video.currentTime = time;
    });
  }, []);

  // ==========================================================================
  // THE EXTRACTION ENGINE
  // Sequential onseeked timeline loop — one frame at a time, in order, so the
  // canvas + video element are never asked to juggle two decode targets at
  // once (which is what causes blank/garbled frames in naive implementations).
  // ==========================================================================
  const handleExtractFrames = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !videoFile) {
      setErrorMessage('Please upload a video first.');
      return;
    }
    if (!videoMeta.duration) {
      setErrorMessage('Video metadata is still loading — please wait a moment and try again.');
      return;
    }

    const timestamps = buildTimestamps();
    if (timestamps.length === 0) {
      setErrorMessage('Could not compute any extraction points for this configuration.');
      return;
    }

    setIsProcessing(true);
    setErrorMessage('');
    setFrames([]);
    setProgress({ done: 0, total: timestamps.length });
    cancelRequestedRef.current = false;

    // CRITICAL QUALITY REQUIREMENT: the canvas must match the video's native
    // decoded resolution exactly. We never downscale — the canvas is sized
    // once per extraction run directly from videoWidth/videoHeight.
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { alpha: false });

    const collected = [];

    try {
      for (let i = 0; i < timestamps.length; i += 1) {
        if (cancelRequestedRef.current) break;

        const t = timestamps[i];
        // eslint-disable-next-line no-await-in-loop
        await seekToTime(video, t);

        // Draw the currently-decoded frame at full native resolution.
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Maximum fidelity export — quality argument of 1.0 requests the
        // highest-quality WebP encoding the browser supports (WebP gives
        // better quality-per-byte than JPEG at the same quality setting,
        // and supports alpha if the source ever needs it).
        const dataUrl = canvas.toDataURL('image/webp', 1.0);

        collected.push({
          id: i + 1,
          dataUrl,
          timestamp: t,
        });

        setProgress({ done: i + 1, total: timestamps.length });
        // Push incrementally so the preview grid fills in live rather than
        // waiting for the entire (potentially large) batch to finish.
        setFrames([...collected]);
      }
    } catch (err) {
      setErrorMessage(`Extraction failed: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [videoFile, videoMeta, buildTimestamps, seekToTime]);

  const handleCancel = useCallback(() => {
    cancelRequestedRef.current = true;
  }, []);

  // ==========================================================================
  // EXPORT: ZIP (jszip + file-saver)
  // ==========================================================================
  const handleDownloadZip = useCallback(async () => {
    if (frames.length === 0) return;
    setIsExportingZip(true);
    setErrorMessage('');

    try {
      const zip = new JSZip();
      const folder = zip.folder('frames');

      frames.forEach((frame) => {
        // Strip the "data:image/webp;base64," prefix — JSZip wants raw base64.
        const base64Data = frame.dataUrl.split(',')[1];
        const paddedIndex = String(frame.id).padStart(3, '0');
        folder.file(`frame_${paddedIndex}.webp`, base64Data, { base64: true });
      });

      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      const baseName = (videoFile?.name || 'video').replace(/\.[^/.]+$/, '');
      saveAs(blob, `${baseName}_frames.zip`);
    } catch (err) {
      setErrorMessage(`ZIP export failed: ${err.message}`);
    } finally {
      setIsExportingZip(false);
    }
  }, [frames, videoFile]);

  // ==========================================================================
  // EXPORT: PDF (jspdf) — one frame per page, centered, aspect-preserved.
  // ==========================================================================
  const handleDownloadPdf = useCallback(async () => {
    if (frames.length === 0) return;
    setIsExportingPdf(true);
    setErrorMessage('');

    try {
      // Use the source video's own aspect ratio to decide page orientation,
      // so frames are never stretched or letterboxed awkwardly.
      const isLandscape = videoMeta.width >= videoMeta.height;
      const pdf = new jsPDF({
        orientation: isLandscape ? 'landscape' : 'portrait',
        unit: 'pt',
        format: 'a4',
      });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 24; // pt
      const usableWidth = pageWidth - margin * 2;
      const usableHeight = pageHeight - margin * 2 - 20; // reserve space for the caption line

      frames.forEach((frame, index) => {
        if (index > 0) pdf.addPage(undefined, isLandscape ? 'landscape' : 'portrait');

        // Fit the image within the usable area while preserving its native
        // aspect ratio exactly — no stretching, no clipping.
        const imgRatio = videoMeta.width / videoMeta.height;
        const boxRatio = usableWidth / usableHeight;

        let drawWidth;
        let drawHeight;
        if (imgRatio > boxRatio) {
          drawWidth = usableWidth;
          drawHeight = usableWidth / imgRatio;
        } else {
          drawHeight = usableHeight;
          drawWidth = usableHeight * imgRatio;
        }

        // Center the image both horizontally and vertically within the page.
        const x = (pageWidth - drawWidth) / 2;
        const y = margin + (usableHeight - drawHeight) / 2;

        pdf.addImage(frame.dataUrl, 'WEBP', x, y, drawWidth, drawHeight, undefined, 'FAST');

        // Caption: frame number + timestamp, centered beneath the image.
        pdf.setFontSize(9);
        pdf.setTextColor(120, 120, 120);
        const caption = `Frame #${frame.id}  •  t = ${frame.timestamp.toFixed(2)}s`;
        const textWidth = pdf.getTextWidth(caption);
        pdf.text(caption, (pageWidth - textWidth) / 2, pageHeight - margin + 8);
      });

      const baseName = (videoFile?.name || 'video').replace(/\.[^/.]+$/, '');
      pdf.save(`${baseName}_frames.pdf`);
    } catch (err) {
      setErrorMessage(`PDF export failed: ${err.message}`);
    } finally {
      setIsExportingPdf(false);
    }
  }, [frames, videoMeta, videoFile]);

  // ==========================================================================
  // Derived UI values
  // ==========================================================================
  const timestampPreviewCount = videoMeta.duration ? buildTimestamps().length : 0;
  const progressPercent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const formatDuration = (secs) => {
    if (!secs) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  // Rough in-memory footprint estimate for the extracted frame batch —
  // helps the user understand why very long videos / very short intervals
  // can get memory-heavy in the browser tab itself.
  const estimatedMemoryMB = frames.reduce((sum, f) => sum + f.dataUrl.length, 0) / (1024 * 1024) * 0.75;

  return (
    <div className="min-h-screen bg-[#0A0D14] text-slate-100">
      {/* Ambient background glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/4 h-[32rem] w-[32rem] rounded-full bg-indigo-600/20 blur-[120px]" />
        <div className="absolute top-1/3 -right-40 h-[28rem] w-[28rem] rounded-full bg-violet-600/10 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-7xl px-6 py-10">
        {/* ---------------------------------------------------------------- */}
        {/* Header */}
        {/* ---------------------------------------------------------------- */}
        <header className="mb-10 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-indigo-400/20 bg-indigo-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-widest text-indigo-300">
              Client-Side Rendering Engine
            </div>
            <h1 className="font-mono text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Video<span className="text-indigo-400">-to-</span>Frames Suite
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Native-resolution frame extraction, entirely in your browser. Nothing leaves your machine.
            </p>
          </div>
          <StatusPill status={apiStatus} />
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* ================================================================ */}
          {/* LEFT: Control Center */}
          {/* ================================================================ */}
          <div className="lg:col-span-4">
            <div className="sticky top-6 space-y-6">
              {/* Upload card */}
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 shadow-xl shadow-black/20 backdrop-blur">
                <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-slate-300">
                  01 · Source Video
                </h2>

                <label
                  htmlFor="video-upload"
                  className="group flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-white/15 bg-black/20 px-4 py-8 text-center transition hover:border-indigo-400/50 hover:bg-indigo-500/5"
                >
                  <svg
                    className="mb-3 h-9 w-9 text-slate-500 transition group-hover:text-indigo-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9m0 0-3 3m3-3 3 3M4.5 19.5h15a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5h-15A1.5 1.5 0 0 0 3 6v12a1.5 1.5 0 0 0 1.5 1.5Z" />
                  </svg>
                  <span className="text-sm font-medium text-slate-200">
                    {videoFile ? videoFile.name : 'Click to select a video file'}
                  </span>
                  <span className="mt-1 text-xs text-slate-500">MP4, WebM, MOV — any browser-decodable format</span>
                  <input id="video-upload" type="file" accept="video/*" onChange={handleFileChange} className="hidden" />
                </label>

                {videoFile && (
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    <StatCard label="Duration" value={formatDuration(videoMeta.duration)} />
                    <StatCard label="Width" value={videoMeta.width || '—'} />
                    <StatCard label="Height" value={videoMeta.height || '—'} />
                  </div>
                )}
              </div>

              {/* Extraction configuration card */}
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 shadow-xl shadow-black/20 backdrop-blur">
                <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-slate-300">
                  02 · Extraction Mode
                </h2>

                <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-black/30 p-1">
                  <button
                    type="button"
                    onClick={() => setMode('interval')}
                    className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                      mode === 'interval' ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    By Time Step
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('splits')}
                    className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                      mode === 'splits' ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    By Total Splits
                  </button>
                </div>

                {mode === 'interval' ? (
                  <div>
                    <label className="mb-2 block text-xs font-medium text-slate-400">
                      Capture 1 frame every{' '}
                      <span className="font-mono text-indigo-300">
                        {intervalSeconds < 0.01 ? Number(intervalSeconds).toFixed(6) : Number(intervalSeconds).toFixed(2)}s
                      </span>
                    </label>

                    {/* Slider gives a fast, continuous drag from 0.000001s up
                        to 10s. NOTE: browsers cannot actually decode distinct
                        frames faster than the source video's own frame rate
                        (commonly ~1/24s–1/60s) — sub-frame-rate steps are
                        honored, but consecutive captures may repeat the same
                        decoded frame. See buildTimestamps() for details. */}
                    <input
                      type="range"
                      min="0.000001"
                      max="10"
                      step="0.000001"
                      value={intervalSeconds}
                      onChange={(e) => setIntervalSeconds(Number(parseFloat(e.target.value).toFixed(6)))}
                      className="mb-3 w-full accent-indigo-500"
                    />

                    {/* Direct numeric entry — far more practical than
                        dragging a slider when the target step is a tiny
                        fraction of a second. */}
                    <input
                      type="number"
                      min="0.000001"
                      max="10"
                      step="0.000001"
                      value={intervalSeconds}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!Number.isNaN(v)) setIntervalSeconds(Math.max(0.000001, v));
                      }}
                      className="mb-3 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-xs text-slate-200 focus:border-indigo-400/50 focus:outline-none"
                    />

                    <div className="flex flex-wrap gap-2">
                      {[0.000001, 0.0001, 0.001, 0.01, 0.1, 0.5, 1, 2, 5].map((val) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setIntervalSeconds(val)}
                          className={`rounded-full px-3 py-1 text-xs font-mono transition ${
                            intervalSeconds === val
                              ? 'bg-indigo-500 text-white'
                              : 'bg-white/5 text-slate-400 hover:bg-white/10'
                          }`}
                        >
                          {val}s
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="mb-2 block text-xs font-medium text-slate-400">
                      Split entire video into{' '}
                      <span className="font-mono text-indigo-300">{totalSplits}</span> equal frames
                    </label>
                    <input
                      type="range"
                      min="2"
                      max="200"
                      step="1"
                      value={totalSplits}
                      onChange={(e) => setTotalSplits(parseInt(e.target.value, 10))}
                      className="mb-3 w-full accent-indigo-500"
                    />
                    <div className="flex flex-wrap gap-2">
                      {[10, 24, 50, 100].map((val) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setTotalSplits(val)}
                          className={`rounded-full px-3 py-1 text-xs font-mono transition ${
                            totalSplits === val
                              ? 'bg-indigo-500 text-white'
                              : 'bg-white/5 text-slate-400 hover:bg-white/10'
                          }`}
                        >
                          {val}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {videoMeta.duration > 0 && (
                  <p className="mt-4 rounded-lg bg-black/30 px-3 py-2 text-xs text-slate-400">
                    This configuration will extract{' '}
                    <span className="font-mono font-semibold text-indigo-300">{timestampPreviewCount}</span> frames
                    at full native resolution ({videoMeta.width}×{videoMeta.height}).
                  </p>
                )}
              </div>

              {/* Action card */}
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 shadow-xl shadow-black/20 backdrop-blur">
                <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-slate-300">
                  03 · Run &amp; Export
                </h2>

                {!isProcessing ? (
                  <button
                    type="button"
                    onClick={handleExtractFrames}
                    disabled={!videoFile || !videoMeta.duration}
                    className="w-full rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:from-indigo-400 hover:to-violet-400 disabled:cursor-not-allowed disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 disabled:shadow-none"
                  >
                    Extract Frames
                  </button>
                ) : (
                  <div className="space-y-2">
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-black/40">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-150"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span className="font-mono">
                        {progress.done} / {progress.total} frames ({progressPercent}%)
                      </span>
                      <button type="button" onClick={handleCancel} className="font-medium text-rose-400 hover:text-rose-300">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handleDownloadZip}
                    disabled={frames.length === 0 || isExportingZip}
                    className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isExportingZip ? 'Zipping…' : 'Download ZIP'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadPdf}
                    disabled={frames.length === 0 || isExportingPdf}
                    className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isExportingPdf ? 'Compiling…' : 'Download PDF'}
                  </button>
                </div>

                {frames.length > 0 && (
                  <p className="mt-3 text-center text-[11px] text-slate-500">
                    ~{estimatedMemoryMB.toFixed(1)} MB held in browser memory for {frames.length} frame
                    {frames.length !== 1 ? 's' : ''}.
                  </p>
                )}

                {errorMessage && (
                  <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                    {errorMessage}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ================================================================ */}
          {/* RIGHT: Preview Grid */}
          {/* ================================================================ */}
          <div className="lg:col-span-8">
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 shadow-xl shadow-black/20 backdrop-blur">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-300">
                  Frame Preview
                </h2>
                {frames.length > 0 && (
                  <span className="rounded-full bg-white/5 px-3 py-1 font-mono text-xs text-slate-400">
                    {frames.length} frame{frames.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {frames.length === 0 && !isProcessing && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 py-24 text-center">
                  <svg
                    className="mb-3 h-10 w-10 text-slate-700"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M2.25 15.75l5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3 4.5h18v15H3v-15Z"
                    />
                  </svg>
                  <p className="text-sm text-slate-500">No frames extracted yet.</p>
                  <p className="mt-1 text-xs text-slate-600">Upload a video and hit “Extract Frames” to populate this grid.</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                {frames.map((frame) => (
                  <div
                    key={frame.id}
                    className="group relative overflow-hidden rounded-xl border border-white/10 bg-black/30 shadow-md transition hover:border-indigo-400/40 hover:shadow-indigo-500/10"
                  >
                    <img
                      src={frame.dataUrl}
                      alt={`Extracted frame ${frame.id}`}
                      className="aspect-video w-full object-cover"
                      loading="lazy"
                    />
                    <span className="absolute left-2 top-2 rounded-md bg-black/70 px-2 py-0.5 font-mono text-[11px] font-semibold text-indigo-300 backdrop-blur">
                      #{frame.id}
                    </span>
                    <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-2 py-0.5 font-mono text-[10px] text-slate-300 backdrop-blur opacity-0 transition group-hover:opacity-100">
                      {frame.timestamp.toFixed(2)}s
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ====================================================================
          HIDDEN PROCESSING ELEMENTS
          These are never displayed — they exist purely to give the browser's
          native decoder something to seek/draw from. Keeping them off-screen
          (rather than unmounted) lets us reuse a single decode pipeline for
          the entire extraction run instead of re-initializing per frame.
      ==================================================================== */}
      <div className="hidden">
        {videoURL && (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            ref={videoRef}
            src={videoURL}
            onLoadedMetadata={handleLoadedMetadata}
            preload="auto"
            muted
            playsInline
          />
        )}
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
