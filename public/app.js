const canvas = document.getElementById("canvas");
const statusEl = document.getElementById("status");
const connectionEl = document.getElementById("connection");
const topLabelEl = document.getElementById("top-label");
const runtimeMessageEl = document.getElementById("runtime-message");
const predictionsEl = document.getElementById("predictions");
const startButton = document.getElementById("start");

const ctx = canvas.getContext("2d");
let model;
let webcam;
let socket;
let running = false;
let frameErrorCount = 0;

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
      return;
    }
    const category = message.category || message.status;
    statusEl.textContent = category;
    statusEl.className = `status ${statusClassForCategory(category)}`;
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
  running = true;
  frameErrorCount = 0;
  startButton.textContent = "Camera running";
  topLabelEl.textContent = "Classifying";
  setRuntimeMessage("Camera running");
  window.requestAnimationFrame(loop);
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
