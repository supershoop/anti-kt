const canvas = document.getElementById("canvas");
const statusEl = document.getElementById("status");
const connectionEl = document.getElementById("connection");
const liveBadgeEl = document.getElementById("liveBadge");
const topLabelEl = document.getElementById("top-label");
const runtimeMessageEl = document.getElementById("runtime-message");
const predictionsEl = document.getElementById("predictions");
const startButton = document.getElementById("start");
const modeButton = document.getElementById("modeBtn");
const activeCardEl = document.getElementById("activeCard");
const cardStatusEl = document.getElementById("cardStatus");
const confidenceValueEl = document.getElementById("confidenceValue");
const confidenceBarEl = document.getElementById("confidenceBar");
const alertDurationEl = document.getElementById("alertDuration");
const frameStreakEl = document.getElementById("frameStreak");
const eventThresholdEl = document.getElementById("eventThreshold");
const clockEl = document.getElementById("clock");
const countSafeEl = document.getElementById("cSafe");
const countRiskyEl = document.getElementById("cRisky");
const countFailEl = document.getElementById("cFail");
const flagStatEl = document.getElementById("flagStat");
const studentNameInput = document.getElementById("studentName");
const studentDisplayEl = document.getElementById("studentDisplay");

const ctx = canvas.getContext("2d");
const PRE_EVENT_SECONDS = 5;
const POST_EVENT_SECONDS = 5;
const RECORDER_TIMESLICE_MS = 1000;

let model;
let webcam;
let socket;
let running = false;
let frameErrorCount = 0;
let mediaRecorder;
let rollingChunks = [];
let recorderHeaderChunk = null;
let activeClip = null;
let currentConfirmedCategory = null;
let evidenceUploadURL = null;
let dashboardConnected = false;

function studentName() {
  return studentNameInput.value.trim() || "Unknown student";
}

function updateStudentDisplay() {
  studentDisplayEl.textContent = studentName();
}

function applyTheme(theme) {
  document.documentElement.classList.toggle("light", theme === "light");
}

let theme = localStorage.getItem("inv-theme") || "dark";
applyTheme(theme);
modeButton.addEventListener("click", () => {
  theme = theme === "light" ? "dark" : "light";
  applyTheme(theme);
  localStorage.setItem("inv-theme", theme);
});

function setRuntimeMessage(message, isError = false) {
  runtimeMessageEl.textContent = message;
  runtimeMessageEl.className = `runtime-message ${isError ? "error" : ""}`;
}

function statusClassForCategory(category) {
  const normalized = String(category || "").trim().toLowerCase();
  if (normalized === "flagged" || normalized === "fail") {
    return "fail";
  }
  if (normalized === "caution" || normalized === "risky") {
    return "risky";
  }
  return "safe";
}

function displayStatus(category) {
  return statusClassForCategory(category) === "safe" ? "Normal" : category;
}

function websocketURL() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host || "127.0.0.1:3000";
  return `${protocol}//${host}/status`;
}

function connectSocket() {
  socket = new WebSocket(websocketURL());
  socket.addEventListener("open", () => {
    updateDashboardConnection(false);
  });
  socket.addEventListener("close", () => {
    updateDashboardConnection(false);
    setTimeout(connectSocket, 1000);
  });
  socket.addEventListener("error", () => {
    updateDashboardConnection(false);
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      setRuntimeMessage(`Status parse failed: ${error.message}`, true);
      return;
    }

    if (message.type === "status") {
      applyStatusMessage(message);
      maybeCaptureEventClip(message);
    } else if (message.type === "dashboard_connection") {
      applyDashboardConnection(message);
    }
  });
}

function applyDashboardConnection(message) {
  evidenceUploadURL = message.evidence_upload_url || null;
  updateDashboardConnection(message.connected === true && Boolean(evidenceUploadURL));
}

function updateDashboardConnection(isConnected) {
  dashboardConnected = isConnected;
  connectionEl.textContent = dashboardConnected ? "Live" : "Waiting";
  liveBadgeEl.classList.toggle("connected", dashboardConnected);
}

function applyStatusMessage(message) {
  const category = message.category || message.status || "Normal";
  const statusClass = statusClassForCategory(category);
  const display = displayStatus(category);
  const confidencePercent = Math.max(0, Math.min(100, Number(message.confidence || 0) * 100));
  const wasFail = activeCardEl.classList.contains("fail");

  statusEl.textContent = display;
  statusEl.className = `status-tag ${statusClass}`;

  activeCardEl.classList.remove("safe", "risky", "fail", "flash");
  activeCardEl.classList.add(statusClass);
  cardStatusEl.textContent = statusClass === "safe" ? "Normal" : display;
  topLabelEl.textContent = message.label
    ? `${message.label} ${confidencePercent.toFixed(1)}%`
    : "Waiting for classifier";
  confidenceValueEl.textContent = Math.round(confidencePercent);
  confidenceBarEl.style.width = `${confidencePercent.toFixed(1)}%`;
  alertDurationEl.textContent = `${Number(message.alert_duration_seconds || 0).toFixed(1)}s`;
  frameStreakEl.textContent = String(message.consecutive_risky_frames || 0);
  eventThresholdEl.textContent = `${Number(message.event_threshold_seconds || 2).toFixed(1)}s`;

  if (statusClass === "fail" && !wasFail) {
    activeCardEl.classList.add("flash");
  }

  updateSummary(statusClass);
  renderPredictions(message.predictions || []);
}

function updateSummary(statusClass) {
  countSafeEl.textContent = statusClass === "safe" ? "1" : "0";
  countRiskyEl.textContent = statusClass === "risky" ? "1" : "0";
  countFailEl.textContent = statusClass === "fail" ? "1" : "0";
  flagStatEl.classList.toggle("zero", statusClass !== "fail");
}

function renderPredictions(predictions) {
  if (!predictions.length) {
    predictionsEl.replaceChildren(emptyLine("No predictions yet"));
    return;
  }

  predictionsEl.replaceChildren(
    ...predictions.map((prediction) => {
      const confidencePercent = Math.max(0, Math.min(100, Number(prediction.confidence || 0) * 100));
      const row = document.createElement("div");
      row.className = "prediction";

      const label = document.createElement("span");
      label.className = "prediction-label";
      label.textContent = prediction.label || "Unknown";

      const value = document.createElement("span");
      value.textContent = `${confidencePercent.toFixed(1)}%`;

      const track = document.createElement("div");
      track.className = "prediction-track";
      const fill = document.createElement("i");
      fill.style.width = `${confidencePercent.toFixed(1)}%`;
      track.appendChild(fill);

      row.append(label, value, track);
      return row;
    })
  );
}

function emptyLine(text) {
  const row = document.createElement("div");
  row.className = "prediction";
  row.textContent = text;
  return row;
}

async function loadModel() {
  if (!window.tmPose) {
    throw new Error("Teachable Machine Pose library did not load");
  }
  setRuntimeMessage("Loading model");
  const config = await fetch("/config.json").then((response) => response.json());
  evidenceUploadURL = config.evidenceUploadURL || null;
  updateDashboardConnection(config.dashboardConnected === true && Boolean(evidenceUploadURL));
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
    setRuntimeMessage("Evidence recording is not supported by this browser", true);
    return;
  }

  const stream = canvas.captureStream(24);
  const options = preferredRecorderOptions();
  mediaRecorder = new MediaRecorder(stream, options);
  rollingChunks = [];
  recorderHeaderChunk = null;
  activeClip = null;

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size === 0) {
      return;
    }

    const isHeader = recorderHeaderChunk === null;
    const chunk = { blob: event.data, timestamp: Date.now(), isHeader };
    if (isHeader) {
      recorderHeaderChunk = chunk;
    }
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
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  return mimeType ? { mimeType } : {};
}

function trimRollingChunks() {
  const cutoff = Date.now() - PRE_EVENT_SECONDS * 1000;
  rollingChunks = rollingChunks.filter((chunk) => chunk.timestamp >= cutoff);
}

function maybeCaptureEventClip(status) {
  const category = String(status.category || status.status || "").trim();
  const normalized = category.toLowerCase();
  const confirmedAlert =
    status.cheating_suspected === true &&
    (normalized === "flagged" || normalized === "caution" || normalized === "fail" || normalized === "risky");

  if (!confirmedAlert) {
    currentConfirmedCategory = null;
    return;
  }
  if (currentConfirmedCategory === normalized || activeClip) {
    return;
  }
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return;
  }

  currentConfirmedCategory = normalized;
  activeClip = {
    eventTimestamp: status.timestamp || new Date().toISOString(),
    studentName: status.student_name || studentName(),
    category,
    label: status.label || "Unknown",
    confidence: status.confidence,
    alertDurationSeconds: status.alert_duration_seconds,
    preChunks: [...rollingChunks],
    postChunks: [],
    evidenceChunks: [],
    evidenceRecorder: null
  };
  if (!startEvidenceRecorder(activeClip)) {
    activeClip = null;
    setRuntimeMessage("Evidence clip skipped: recorder unavailable", true);
    return;
  }
  setRuntimeMessage(`Recording ${category} evidence clip`);

  setTimeout(() => {
    finalizeEventClip();
  }, POST_EVENT_SECONDS * 1000);
}

function startEvidenceRecorder(clip) {
  if (!canvas.captureStream || !window.MediaRecorder) {
    return false;
  }

  const recorder = new MediaRecorder(canvas.captureStream(24), preferredRecorderOptions());
  clip.evidenceRecorder = recorder;
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      clip.evidenceChunks.push(event.data);
    }
  });
  recorder.addEventListener("error", (event) => {
    setRuntimeMessage(`Evidence recorder error: ${event.error?.message || "unknown error"}`, true);
  });
  recorder.start();
  return true;
}

function stopEvidenceRecorder(clip) {
  return new Promise((resolve) => {
    const recorder = clip.evidenceRecorder;
    if (!recorder || recorder.state === "inactive") {
      resolve(clip.evidenceChunks);
      return;
    }

    recorder.addEventListener("stop", () => resolve(clip.evidenceChunks), { once: true });
    try {
      recorder.requestData();
    } catch (_) {
      // Some browsers throw if no data is ready yet; stop still emits the final blob.
    }
    recorder.stop();
  });
}

async function finalizeEventClip() {
  if (!activeClip) {
    return;
  }

  const clip = activeClip;
  activeClip = null;
  const blobs = await stopEvidenceRecorder(clip);
  if (blobs.length === 0) {
    setRuntimeMessage("Evidence clip skipped: no video data available", true);
    return;
  }

  const mimeType = mediaRecorder?.mimeType || "video/webm";
  const blob = new Blob(blobs, { type: mimeType });
  const filename = evidenceFilename(clip);
  setRuntimeMessage(`Uploading ${filename}`);

  try {
    const evidence = await uploadClip(blob, filename, clip);
    setRuntimeMessage(`Uploaded ${evidence.filename || evidence.id || filename}`);
  } catch (error) {
    setRuntimeMessage(`Evidence upload failed: ${error.message}`, true);
    console.error(error);
  }
}

function evidenceFilename(clip) {
  const safeStudent = String(clip.studentName || "unknown-student")
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();
  const safeCategory = String(clip.category).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const safeLabel = String(clip.label).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const safeTimestamp = new Date(clip.eventTimestamp).toISOString().replace(/[:.]/g, "-");
  return `evidence-${safeTimestamp}-${safeStudent}-${safeCategory}-${safeLabel}.webm`;
}

async function uploadClip(blob, filename, clip) {
  const uploadURL = evidenceUploadURL || "/evidence";
  const form = new FormData();
  form.append("timestamp", clip.eventTimestamp);
  form.append("student_name", clip.studentName || studentName());
  form.append("category", clip.category);
  form.append("status", clip.category);
  form.append("label", clip.label);
  form.append("confidence", String(clip.confidence ?? 0));
  form.append("alert_duration_seconds", String(clip.alertDurationSeconds ?? 0));
  form.append("video", blob, filename);

  const response = await fetch(uploadURL, {
    method: "POST",
    body: form
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
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
  renderPredictions(
    predictions.map((prediction) => ({
      label: prediction.className,
      confidence: prediction.probability
    }))
  );

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "classification",
        student_name: studentName(),
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

function updateClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString();
}

renderPredictions([]);
updateStudentDisplay();
updateClock();
setInterval(updateClock, 1000);
connectSocket();
studentNameInput.addEventListener("input", updateStudentDisplay);
startButton.addEventListener("click", () => {
  startCamera().catch((error) => {
    startButton.disabled = false;
    startButton.textContent = "Start camera";
    connectionEl.textContent = "Error";
    topLabelEl.textContent = "Camera not running";
    setRuntimeMessage(error.message, true);
    console.error(error);
  });
});
