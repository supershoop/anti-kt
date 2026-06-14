const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const express = require("express");
const multer = require("multer");
const { SerialPort } = require("serialport");
const { WebSocket, WebSocketServer } = require("ws");

const ROOT = path.resolve(__dirname, "..");
const EVIDENCE_DIR = path.join(ROOT, "evidence");

function parseArgs(argv) {
  const config = {
    host: "127.0.0.1",
    port: 3000,
    arduinoPort: null,
    baudRate: 9600,
    eventSeconds: 2,
    confidence: 0.7,
    logPath: path.join(ROOT, "logs", "classifications.csv")
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--host") {
      config.host = next;
      index += 1;
    } else if (arg === "--port") {
      config.port = Number(next);
      index += 1;
    } else if (arg === "--arduino-port") {
      config.arduinoPort = next;
      index += 1;
    } else if (arg === "--baud-rate") {
      config.baudRate = Number(next);
      index += 1;
    } else if (arg === "--threshold" || arg === "--event-seconds") {
      config.eventSeconds = Math.max(2, Number(next));
      index += 1;
    } else if (arg === "--confidence") {
      config.confidence = Number(next);
      index += 1;
    } else if (arg === "--log") {
      config.logPath = path.resolve(next);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(config.port) || config.port < 1) {
    throw new Error("--port must be a positive number");
  }
  if (!Number.isFinite(config.eventSeconds) || config.eventSeconds < 2) {
    throw new Error("--event-seconds must be at least 2");
  }
  return config;
}

class CsvLogger {
  constructor(logPath) {
    this.logPath = logPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size === 0) {
      fs.writeFileSync(
        logPath,
        "timestamp,student_name,label,confidence,category,status,consecutive_risky_frames\n",
        "utf8"
      );
    }
  }

  write(record) {
    const row = [
      record.timestamp,
      csvEscape(record.studentName),
      csvEscape(record.label),
      record.confidence.toFixed(6),
      csvEscape(record.category),
      csvEscape(record.status),
      String(record.consecutiveRiskyFrames)
    ].join(",");
    fs.appendFileSync(this.logPath, `${row}\n`, "utf8");
  }
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function studentNameFrom(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text || "Unknown student";
}

class ArduinoDisplay {
  constructor(portPath, baudRate) {
    this.portPath = portPath;
    this.baudRate = baudRate;
    this.port = null;
    this.lastCommand = null;
  }

  open() {
    if (!this.portPath) {
      console.warn("Arduino disabled: pass --arduino-port to enable serial output.");
      return;
    }

    this.port = new SerialPort({
      path: this.portPath,
      baudRate: this.baudRate,
      autoOpen: false
    });
    this.port.open((error) => {
      if (error) {
        console.error(`Arduino serial open failed: ${error.message}`);
        return;
      }
      console.log(`Arduino serial open on ${this.portPath}`);
      setTimeout(() => this.sendStatus("Normal", ""), 2000);
    });
  }

  sendStatus(status, reason) {
    const command = serialCommandForStatus(status, reason);
    if (command === this.lastCommand || !this.port || !this.port.isOpen) {
      return;
    }
    this.port.write(`${command}\n`, (error) => {
      if (error) {
        console.error(`Arduino serial write failed: ${error.message}`);
      } else {
        this.lastCommand = command;
      }
    });
  }
}

function serialCommandForStatus(status, reason) {
  const normalized = String(status || "").trim().toLowerCase();
  const cleanReason = String(reason || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\r\n]/g, "");

  if (normalized === "flagged") {
    return `FAIL ${cleanReason || "Unknown"}`;
  }
  if (normalized === "caution") {
    return `WARN ${cleanReason || "Unknown"}`;
  }
  return "CLEAR";
}

const EVENT_CATEGORIES = {
  flagged: new Set(["lean right", "lean left", "standing", "nothing", "crotch"]),
  caution: new Set(["look left", "look right", "hands"]),
  normal: new Set(["normal"])
};

function categoryForLabel(label, confidence, confidenceThreshold) {
  if (confidence < confidenceThreshold) {
    return "Normal";
  }

  const normalized = String(label).trim().toLowerCase();
  if (EVENT_CATEGORIES.flagged.has(normalized)) {
    return "Flagged";
  }
  if (EVENT_CATEGORIES.caution.has(normalized)) {
    return "Caution";
  }
  if (EVENT_CATEGORIES.normal.has(normalized)) {
    return "Normal";
  }
  return "Normal";
}

class AlertState {
  constructor(eventSeconds, confidenceThreshold) {
    this.eventSeconds = eventSeconds;
    this.confidenceThreshold = confidenceThreshold;
    this.consecutiveRiskyFrames = 0;
    this.currentAlertCategory = null;
    this.currentAlertStartedAt = null;
  }

  update(label, confidence, timestampMs = Date.now()) {
    const candidateCategory = categoryForLabel(label, confidence, this.confidenceThreshold);
    const alertCategory = candidateCategory === "Flagged" || candidateCategory === "Caution";

    if (!alertCategory) {
      this.consecutiveRiskyFrames = 0;
      this.currentAlertCategory = null;
      this.currentAlertStartedAt = null;
    } else if (this.currentAlertCategory !== candidateCategory) {
      this.consecutiveRiskyFrames = 1;
      this.currentAlertCategory = candidateCategory;
      this.currentAlertStartedAt = timestampMs;
    } else {
      this.consecutiveRiskyFrames += 1;
    }

    const alertDurationSeconds =
      alertCategory && this.currentAlertStartedAt !== null
        ? (timestampMs - this.currentAlertStartedAt) / 1000
        : 0;
    const cheatingSuspected = alertCategory && alertDurationSeconds >= this.eventSeconds;
    const confirmedCategory = cheatingSuspected ? candidateCategory : "Normal";

    return {
      category: confirmedCategory,
      status: confirmedCategory,
      cheatingSuspected,
      consecutiveRiskyFrames: this.consecutiveRiskyFrames,
      pendingCategory: alertCategory ? candidateCategory : "Normal",
      alertDurationSeconds
    };
  }
}

function safeFilePart(value, fallback) {
  const text = String(value || fallback)
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return text || fallback;
}

function createEvidenceUpload() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  return multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 400,
      fileSize: 3 * 1024 * 1024
    },
    fileFilter: (_request, file, callback) => {
      if (
        (file.fieldname === "video" && file.mimetype.startsWith("video/")) ||
        (file.fieldname === "frames" && file.mimetype === "image/jpeg")
      ) {
        callback(null, true);
        return;
      }
      callback(new Error("Evidence upload must include a video file or JPEG frames"));
    }
  });
}

function evidenceFilename(request) {
  const requested = String(request.body.filename || "").trim();
  if (requested) {
    return `${safeFilePart(path.basename(requested, path.extname(requested)), "evidence")}.webm`;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const student = safeFilePart(request.body.student_name, "unknown-student");
  const category = safeFilePart(request.body.category || request.body.status, "event");
  const label = safeFilePart(request.body.label, "unknown");
  return `evidence-${timestamp}-${student}-${category}-${label}.webm`;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 30000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve();
    });
  });
}

async function writeEvidenceFileFromUpload(request) {
  const files = Array.isArray(request.files) ? request.files : [];
  const video = files.find((file) => file.fieldname === "video");
  const frames = files
    .filter((file) => file.fieldname === "frames")
    .sort((a, b) => a.originalname.localeCompare(b.originalname));
  const filename = evidenceFilename(request);
  const outputPath = path.join(EVIDENCE_DIR, filename);
  const tempOutputPath = path.join(EVIDENCE_DIR, `.${filename}.${Date.now()}.tmp.webm`);

  if (video) {
    fs.writeFileSync(tempOutputPath, video.buffer);
    fs.renameSync(tempOutputPath, outputPath);
    return { filename, size: video.size };
  }

  if (frames.length === 0) {
    throw new Error("Missing evidence video file or JPEG frames");
  }

  const frameRate = Math.max(1, Math.min(30, Number(request.body.frame_rate || 10)));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anti-kt-evidence-"));
  try {
    frames.forEach((frame, index) => {
      fs.writeFileSync(path.join(tempDir, `frame-${String(index + 1).padStart(4, "0")}.jpg`), frame.buffer);
    });
    await runFfmpeg([
      "-y",
      "-framerate",
      String(frameRate),
      "-i",
      path.join(tempDir, "frame-%04d.jpg"),
      "-c:v",
      "libvpx",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(frameRate),
      tempOutputPath
    ]);
    fs.renameSync(tempOutputPath, outputPath);
  } finally {
    fs.rmSync(tempOutputPath, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { filename, size: fs.statSync(outputPath).size };
}

function createApp(config, onEvidence) {
  const app = express();
  const upload = createEvidenceUpload();
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json());
  app.use(express.static(path.join(ROOT, "public")));
  app.use("/model", express.static(path.join(ROOT, "model")));
  app.use("/evidence", express.static(EVIDENCE_DIR));
  app.post("/evidence", upload.any(), async (request, response, next) => {
    try {
      const file = await writeEvidenceFileFromUpload(request);

      const evidence = {
        type: "evidence",
        id: path.basename(file.filename, path.extname(file.filename)),
        timestamp: request.body.timestamp || new Date().toISOString(),
        received_at: new Date().toISOString(),
        student_name: studentNameFrom(request.body.student_name),
        category: request.body.category || "Unknown",
        status: request.body.status || request.body.category || "Unknown",
        label: request.body.label || "Unknown",
        confidence: Number(request.body.confidence || 0),
        alert_duration_seconds: Number(request.body.alert_duration_seconds || 0),
        video_url: `/evidence/${file.filename}`,
        filename: file.filename,
        size_bytes: file.size
      };

      onEvidence(evidence);
      response.status(201).json(evidence);
    } catch (error) {
      next(error);
    }
  });
  app.get("/vendor/tf.min.js", (_request, response) => {
    response.sendFile(path.join(ROOT, "node_modules", "@tensorflow", "tfjs", "dist", "tf.min.js"));
  });
  app.get("/vendor/teachablemachine-pose.min.js", (_request, response) => {
    response.sendFile(
      path.join(
        ROOT,
        "node_modules",
        "@teachablemachine",
        "pose",
        "dist",
        "teachablemachine-pose.min.js"
      )
    );
  });
  app.get("/config.json", (_request, response) => {
    response.json({
      modelURL: "/model/model.json",
      metadataURL: "/model/metadata.json",
      confidenceThreshold: config.confidence,
      evidenceUploadURL: config.evidenceUploadUrl || null,
      dashboardConnected: config.dashboardConnected === true
    });
  });
  app.use((error, _request, response, _next) => {
    response.status(400).json({ error: error.message || "Upload failed" });
  });
  return app;
}

function broadcast(clients, payload) {
  const message = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function main() {
  const config = parseArgs(process.argv);
  config.dashboardConnected = false;
  config.evidenceUploadUrl = null;
  config.dashboardSocket = null;
  const logger = new CsvLogger(config.logPath);
  const arduino = new ArduinoDisplay(config.arduinoPort, config.baudRate);
  const alerts = new AlertState(config.eventSeconds, config.confidence);

  const app = createApp(config, (evidence) => {
    broadcast(wss.clients, evidence);
    console.log(`Evidence uploaded: ${evidence.video_url}`);
  });
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/status" });
  let latestStatus = null;

  arduino.open();

  wss.on("connection", (socket) => {
    if (latestStatus) {
      socket.send(JSON.stringify(latestStatus));
    }
    socket.send(
      JSON.stringify({
        type: "dashboard_connection",
        connected: config.dashboardConnected,
        evidence_upload_url_configured: Boolean(config.evidenceUploadUrl),
        evidence_upload_url: config.evidenceUploadUrl
      })
    );

    socket.on("close", () => {
      if (socket === config.dashboardSocket) {
        config.dashboardConnected = false;
        config.dashboardSocket = null;
        config.evidenceUploadUrl = null;
        broadcast(wss.clients, {
          type: "dashboard_connection",
          connected: false,
          evidence_upload_url_configured: false,
          evidence_upload_url: null
        });
        console.log("Dashboard disconnected");
      }
    });

    socket.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid JSON message" }));
        return;
      }

      if (event.type === "dashboard_config") {
        const evidenceUploadUrl = String(event.evidence_upload_url || "").trim();
        if (!evidenceUploadUrl) {
          socket.send(JSON.stringify({ type: "error", message: "Missing evidence_upload_url" }));
          return;
        }

        try {
          new URL(evidenceUploadUrl);
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "Invalid evidence_upload_url" }));
          return;
        }

        config.dashboardConnected = true;
        config.dashboardSocket = socket;
        config.evidenceUploadUrl = evidenceUploadUrl;
        const dashboardConnection = {
          type: "dashboard_connection",
          connected: true,
          evidence_upload_url_configured: true,
          evidence_upload_url: evidenceUploadUrl
        };
        socket.send(JSON.stringify({ type: "dashboard_config_ack", evidence_upload_url: evidenceUploadUrl }));
        broadcast(wss.clients, dashboardConnection);
        console.log(`Dashboard configured evidence upload URL: ${evidenceUploadUrl}`);
        return;
      }

      if (event.type !== "classification") {
        return;
      }

      const label = String(event.label || "");
      const confidence = Number(event.confidence || 0);
      const studentName = studentNameFrom(event.student_name);
      const timestampMs = Date.now();
      const decision = alerts.update(label, confidence, timestampMs);
      const timestamp = new Date(timestampMs).toISOString();
      latestStatus = {
        type: "status",
        timestamp,
        student_name: studentName,
        status: decision.status,
        category: decision.category,
        cheating_suspected: decision.cheatingSuspected,
        label,
        confidence,
        consecutive_risky_frames: decision.consecutiveRiskyFrames,
        alert_duration_seconds: Number(decision.alertDurationSeconds.toFixed(3)),
        event_threshold_seconds: config.eventSeconds,
        predictions: Array.isArray(event.predictions) ? event.predictions : []
      };

      arduino.sendStatus(decision.status, label);
      logger.write({
        timestamp,
        studentName,
        label,
        confidence,
        category: decision.category,
        status: decision.status,
        consecutiveRiskyFrames: decision.consecutiveRiskyFrames
      });
      broadcast(wss.clients, latestStatus);
      console.log(
        `${latestStatus.status}: ${label} (${(confidence * 100).toFixed(1)}%), ` +
          `pending=${decision.pendingCategory}, duration=${decision.alertDurationSeconds.toFixed(1)}s`
      );
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`Backend listening on http://${config.host}:${config.port}`);
    console.log(`WebSocket status feed at ws://${config.host}:${config.port}/status`);
    console.log(`Event threshold: ${config.eventSeconds.toFixed(1)} seconds`);
    console.log(
      "Event mapping: Flagged=Look Right/Look Left/Standing/Nothing/Crotch, " +
        "Caution=Leaning Right/Leaning Left/Hands, Normal=Normal"
    );
  });
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
