const fs = require("fs");
const http = require("http");
const path = require("path");

const express = require("express");
const { SerialPort } = require("serialport");
const { WebSocket, WebSocketServer } = require("ws");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const config = {
    host: "127.0.0.1",
    port: 3000,
    arduinoPort: null,
    baudRate: 9600,
    threshold: 5,
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
    } else if (arg === "--threshold") {
      config.threshold = Number(next);
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
  if (!Number.isFinite(config.threshold) || config.threshold < 1) {
    throw new Error("--threshold must be at least 1");
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
        "timestamp,label,confidence,category,status,consecutive_risky_frames\n",
        "utf8"
      );
    }
  }

  write(record) {
    const row = [
      record.timestamp,
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
      setTimeout(() => this.sendStatus(false), 2000);
    });
  }

  sendStatus(cheatingSuspected) {
    const command = cheatingSuspected ? "CHEAT" : "CLEAR";
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

const EVENT_CATEGORIES = {
  fail: new Set(["standing", "crotch", "croutch", "nothing"]),
  risky: new Set(["leaning left", "leaning right", "hand"]),
  allClear: new Set(["normal"])
};

function categoryForLabel(label, confidence, confidenceThreshold) {
  if (confidence < confidenceThreshold) {
    return "All Clear";
  }

  const normalized = String(label).trim().toLowerCase();
  if (EVENT_CATEGORIES.fail.has(normalized)) {
    return "Fail";
  }
  if (EVENT_CATEGORIES.risky.has(normalized)) {
    return "Risky";
  }
  if (EVENT_CATEGORIES.allClear.has(normalized)) {
    return "All Clear";
  }
  return "All Clear";
}

class AlertState {
  constructor(threshold, confidenceThreshold) {
    this.threshold = threshold;
    this.confidenceThreshold = confidenceThreshold;
    this.consecutiveRiskyFrames = 0;
  }

  update(label, confidence) {
    const category = categoryForLabel(label, confidence, this.confidenceThreshold);
    const alertCategory = category === "Fail" || category === "Risky";
    this.consecutiveRiskyFrames = alertCategory ? this.consecutiveRiskyFrames + 1 : 0;
    const cheatingSuspected = alertCategory && this.consecutiveRiskyFrames >= this.threshold;
    return {
      category,
      status: category,
      cheatingSuspected,
      consecutiveRiskyFrames: this.consecutiveRiskyFrames
    };
  }
}

function createApp(config) {
  const app = express();
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json());
  app.use(express.static(path.join(ROOT, "public")));
  app.use("/model", express.static(path.join(ROOT, "model")));
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
      confidenceThreshold: config.confidence
    });
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
  const logger = new CsvLogger(config.logPath);
  const arduino = new ArduinoDisplay(config.arduinoPort, config.baudRate);
  const alerts = new AlertState(config.threshold, config.confidence);

  const app = createApp(config);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/status" });
  let latestStatus = null;

  arduino.open();

  wss.on("connection", (socket) => {
    if (latestStatus) {
      socket.send(JSON.stringify(latestStatus));
    }

    socket.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid JSON message" }));
        return;
      }

      if (event.type !== "classification") {
        return;
      }

      const label = String(event.label || "");
      const confidence = Number(event.confidence || 0);
      const decision = alerts.update(label, confidence);
      const timestamp = new Date().toISOString();
      latestStatus = {
        type: "status",
        timestamp,
        status: decision.status,
        category: decision.category,
        cheating_suspected: decision.cheatingSuspected,
        label,
        confidence,
        consecutive_risky_frames: decision.consecutiveRiskyFrames,
        predictions: Array.isArray(event.predictions) ? event.predictions : []
      };

      arduino.sendStatus(decision.cheatingSuspected);
      logger.write({
        timestamp,
        label,
        confidence,
        category: decision.category,
        status: decision.status,
        consecutiveRiskyFrames: decision.consecutiveRiskyFrames
      });
      broadcast(wss.clients, latestStatus);
      console.log(
        `${latestStatus.status}: ${label} (${(confidence * 100).toFixed(1)}%), ` +
          `streak=${decision.consecutiveRiskyFrames}`
      );
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`Backend listening on http://${config.host}:${config.port}`);
    console.log(`WebSocket status feed at ws://${config.host}:${config.port}/status`);
    console.log("Event mapping: Fail=Standing/Crotch/Nothing, Risky=Leaning Left/Leaning Right/Hand, All Clear=Normal");
  });
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
