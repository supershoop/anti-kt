const canvas = document.getElementById("canvas");
const statusEl = document.getElementById("status");
const connectionEl = document.getElementById("connection");
const topLabelEl = document.getElementById("top-label");
const runtimeMessageEl = document.getElementById("runtime-message");
const predictionsEl = document.getElementById("predictions");
const clipsEl = document.getElementById("clips");
const startButton = document.getElementById("start");

const ctx = canvas.getContext("2d");
const PRE_EVENT_SECONDS = 5;
const POST_EVENT_SECONDS = 5;
const RECORDER_TIMESLICE_MS = 1000;
const CLIP_COOLDOWN_MS = 6000;

let model;
let webcam;
let socket;
let running = false;
let frameErrorCount = 0;
let mediaRecorder;
let rollingChunks = [];
let activeClip = null;
let lastClipStartedAt = 0;
const evidenceLinks = new Set();

function setRuntimeMessage(message, isError = false) {
  runtimeMessageEl.textContent = message;
  runtimeMessageEl.className = `runtime-message ${isError ? "error" : ""}`;
}

function statusClassForCategory(category) {
  const normalized = String(category || "").trim().toLowerCase();
  if (normalized === "fail") {
    return "fail";
  }
  if (normalized === "risky") {
    return "risky";
  }
  return "clear";
}

function websocketURL() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/status`;
}

function connectSocket() {
  socket = new WebSocket(websocketURL());
  socket.addEventListener("open", () => {
    connectionEl.textContent = "Connected";
  });
  socket.addEventListener("close", () => {
    connectionEl.textContent = "Disconnected";
    setTimeout(connectSocket, 1000);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "status") {
      if (message.type === "evidence") {
        addClipLink(message.video_url, message.filename, message);
      }
      return;
    }
    const category = message.category || message.status;
    statusEl.textContent = category;
    statusEl.className = `status ${statusClassForCategory(category)}`;
    maybeCaptureEventClip(message);
  });
}

async function loadModel() {
  if (!window.tmPose) {
    throw new Error("Teachable Machine Pose library did not load");
  }
  setRuntimeMessage("Loading model");
  const config = await fetch("/config.json").then((response) => response.json());
  model = await tmPose.load(config.modelURL, config.metadataURL);
  setRuntimeMessage("Model loaded");
}

async function startCamera() {
  startButton.disabled = true;
  startButton.textContent = "Starting";
  topLabelEl.textContent = "Starting camera";
  setRuntimeMessage("Preparing model");

  if (!model) {
    await loadModel();
  }

  setRuntimeMessage("Requesting camera access");
  const width = 640;
  const height = 480;
  webcam = new tmPose.Webcam(width, height, true);
  await webcam.setup();
  setRuntimeMessage("Starting video stream");
  await webcam.play();
  canvas.width = width;
  canvas.height = height;
  startVideoRecorder();
  running = true;
  frameErrorCount = 0;
  startButton.textContent = "Camera running";
  topLabelEl.textContent = "Classifying";
  setRuntimeMessage("Camera running");
  window.requestAnimationFrame(loop);
}

function startVideoRecorder() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    return;
  }
  if (!canvas.captureStream || !window.MediaRecorder) {
    setRuntimeMessage("Video evidence recording is not supported by this browser", true);
    return;
  }

  const stream = canvas.captureStream(24);
  const options = preferredRecorderOptions();
  mediaRecorder = new MediaRecorder(stream, options);
  rollingChunks = [];
  activeClip = null;

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size === 0) {
      return;
    }

    const chunk = { blob: event.data, timestamp: Date.now() };
    rollingChunks.push(chunk);
    trimRollingChunks();

    if (activeClip) {
      activeClip.postChunks.push(chunk);
    }
  });
  mediaRecorder.addEventListener("error", (event) => {
    setRuntimeMessage(`Video recorder error: ${event.error?.message || "unknown error"}`, true);
  });
  mediaRecorder.start(RECORDER_TIMESLICE_MS);
}

function preferredRecorderOptions() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  return mimeType ? { mimeType } : {};
}

function trimRollingChunks() {
  const cutoff = Date.now() - PRE_EVENT_SECONDS * 1000;
  rollingChunks = rollingChunks.filter((chunk) => chunk.timestamp >= cutoff);
}

function maybeCaptureEventClip(status) {
  const category = String(status.category || status.status || "").trim().toLowerCase();
  if ((category !== "fail" && category !== "risky") || status.cheating_suspected !== true) {
    return;
  }
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return;
  }

  const now = Date.now();
  if (activeClip || now - lastClipStartedAt < CLIP_COOLDOWN_MS) {
    return;
  }

  lastClipStartedAt = now;
  activeClip = {
    id: `${status.category}-${new Date(status.timestamp || now).toISOString()}`,
    eventTimestamp: status.timestamp || new Date(now).toISOString(),
    category: status.category || status.status,
    label: status.label,
    confidence: status.confidence,
    alertDurationSeconds: status.alert_duration_seconds,
    preChunks: [...rollingChunks],
    postChunks: []
  };
  setRuntimeMessage(`Recording evidence clip for ${activeClip.category}`);

  setTimeout(() => {
    finalizeEventClip();
  }, POST_EVENT_SECONDS * 1000);
}

async function finalizeEventClip() {
  if (!activeClip) {
    return;
  }

  const clip = activeClip;
  activeClip = null;
  const blobs = [...clip.preChunks, ...clip.postChunks].map((chunk) => chunk.blob);
  if (blobs.length === 0) {
    setRuntimeMessage("Evidence clip skipped: no video data available", true);
    return;
  }

  const mimeType = mediaRecorder?.mimeType || "video/webm";
  const blob = new Blob(blobs, { type: mimeType });
  const filename = evidenceFilename(clip);
  setRuntimeMessage(`Uploading evidence clip ${filename}`);

  try {
    const evidence = await uploadClip(blob, filename, clip);
    addClipLink(evidence.video_url, evidence.filename, evidence);
    setRuntimeMessage(`Uploaded evidence clip ${evidence.filename}`);
  } catch (error) {
    setRuntimeMessage(`Evidence upload failed: ${error.message}`, true);
    console.error(error);
  }
}

function evidenceFilename(clip) {
  const safeCategory = String(clip.category).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const safeLabel = String(clip.label).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const safeTimestamp = new Date(clip.eventTimestamp).toISOString().replace(/[:.]/g, "-");
  return `evidence-${safeTimestamp}-${safeCategory}-${safeLabel}.webm`;
}

async function uploadClip(blob, filename, clip) {
  const form = new FormData();
  form.append("timestamp", clip.eventTimestamp);
  form.append("category", clip.category);
  form.append("status", clip.category);
  form.append("label", clip.label);
  form.append("confidence", String(clip.confidence ?? 0));
  form.append("alert_duration_seconds", String(clip.alertDurationSeconds ?? 0));
  form.append("video", blob, filename);

  const response = await fetch("/evidence", {
    method: "POST",
    body: form
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function addClipLink(url, filename, clip) {
  if (!url) {
    return;
  }
  const key = clip.id || url;
  if (evidenceLinks.has(key)) {
    return;
  }
  evidenceLinks.add(key);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.textContent = `${clip.category} ${new Date(clip.timestamp || clip.eventTimestamp).toLocaleTimeString()}`;

  const row = document.createElement("div");
  row.className = "clip";
  row.appendChild(link);
  clipsEl.prepend(row);
}

async function loop() {
  if (!running) {
    return;
  }
  try {
    webcam.update();
    await predict();
    frameErrorCount = 0;
  } catch (error) {
    frameErrorCount += 1;
    setRuntimeMessage(error.message, true);
    console.error(error);
    if (frameErrorCount >= 5) {
      running = false;
      startButton.disabled = false;
      startButton.textContent = "Restart camera";
      topLabelEl.textContent = "Classification stopped";
      return;
    }
  }
  window.requestAnimationFrame(loop);
}

async function predict() {
  const { pose, posenetOutput } = await model.estimatePose(webcam.canvas);
  const predictions = await model.predict(posenetOutput);
  predictions.sort((a, b) => b.probability - a.probability);
  const top = predictions[0];

  drawPose(pose);
  topLabelEl.textContent = `${top.className} ${(top.probability * 100).toFixed(1)}%`;
  predictionsEl.replaceChildren(
    ...predictions.map((prediction) => {
      const row = document.createElement("div");
      row.className = "prediction";
      row.innerHTML = `<span>${prediction.className}</span><span>${(
        prediction.probability * 100
      ).toFixed(1)}%</span>`;
      return row;
    })
  );

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "classification",
        label: top.className,
        confidence: top.probability,
        predictions: predictions.map((prediction) => ({
          label: prediction.className,
          confidence: prediction.probability
        }))
      })
    );
  }
}

function drawPose(pose) {
  ctx.drawImage(webcam.canvas, 0, 0);
  if (!pose) {
    return;
  }
  tmPose.drawKeypoints(pose.keypoints, 0.5, ctx);
  tmPose.drawSkeleton(pose.keypoints, 0.5, ctx);
}

connectSocket();
startButton.addEventListener("click", () => {
  startCamera().catch((error) => {
    startButton.disabled = false;
    startButton.textContent = "Start camera";
    connectionEl.textContent = error.message;
    topLabelEl.textContent = "Camera not running";
    setRuntimeMessage(error.message, true);
    console.error(error);
  });
});
