# anti-kt

Real-time exam room posture/behavior classifier backend.

The Node backend serves the official Teachable Machine Pose classifier page,
receives classification events over WebSocket, applies a sustained-event alert
threshold, logs classifications, and sends status updates to an Arduino over
serial.
The Arduino sketch drives a 1602A LCD and rings a passive buzzer when cheating
is suspected.

## Hardware

- USB camera or laptop webcam
- Arduino-compatible board
- 1602A 16x2 LCD wired in 4-bit mode
- Passive buzzer on pin 8

Default LCD pin mapping in `arduino/exam_status_controller/exam_status_controller.ino`:

| LCD pin | Arduino pin |
| --- | --- |
| RS | 12 |
| EN | 11 |
| D4 | 5 |
| D5 | 4 |
| D6 | 3 |
| D7 | 2 |

## Install

```bash
npm install
```

## Model files

Place your model files under `model/`, for example:

```text
model/model.json
model/weights.bin
model/metadata.json
```

This is the original TensorFlow.js export from Teachable Machine Pose. The
browser page uses `@teachablemachine/pose` directly, so PoseNet preprocessing
and classifier prediction follow the official Teachable Machine path:

```text
webcam frame -> tmPose.estimatePose(...) -> tmPose.predict(...) -> Node backend
```

## Arduino setup

1. Open `arduino/exam_status_controller/exam_status_controller.ino` in the
   Arduino IDE.
2. Upload it to the board.
3. Find the serial port:

```bash
ls /dev/cu.*
```

On macOS it is usually something like `/dev/cu.usbmodem1101` or
`/dev/cu.usbserial-0001`.

## Run

```bash
npm start -- \
  --arduino-port /dev/cu.usbmodem1101 \
  --event-seconds 2 \
  --confidence 0.7
```

Open the local monitor page:

```text
http://127.0.0.1:3000
```

Click **Start camera** and allow camera access.

Event categories are:

- `Fail`: `Standing`, `Crotch`/`Croutch`, `Nothing`
- `Risky`: `Leaning Left`, `Leaning Right`, `Hand`
- `All Clear`: `Normal`

The LCD and WebSocket status display:

- `All clear` while the event threshold is not met.
- `Cheating suspected` once the model predicts `Fail` or `Risky` continuously
  at 70% confidence or higher for at least 2 seconds.

Classification logs are written to `logs/classifications.csv`.

## Evidence clips

The monitor page keeps a rolling 5-second video buffer in the browser. When a
`Fail` or `Risky` event is confirmed by the backend for at least 2 seconds, it
records the event timestamp and uploads an evidence clip with the previous 5
seconds plus the next 5 seconds of video.

Evidence clips are stored in `evidence/` and served from:

```text
http://127.0.0.1:3000/evidence/<filename>.webm
```

The upload endpoint is:

```text
POST /evidence
Content-Type: multipart/form-data
```

Fields:

- `video`: `.webm` video file.
- `timestamp`: event timestamp.
- `category`: confirmed category, `Fail` or `Risky`.
- `status`: same as `category`.
- `label`: raw top model label.
- `confidence`: raw top model confidence.
- `alert_duration_seconds`: sustained-event duration when the clip was created.

## WebSocket interface

The backend opens a WebSocket status feed at:

```text
ws://127.0.0.1:3000/status
```

Use `--host` and `--port` to change the bind address. For another device on the
same network to connect, bind to `0.0.0.0` and connect to the computer's LAN IP
address.

Each connected client receives one JSON message per classification event. A
newly connected client also receives the latest known status immediately.

Example message:

```json
{
  "timestamp": "2026-06-13T14:30:12.123",
  "status": "All Clear",
  "category": "All Clear",
  "cheating_suspected": false,
  "label": "Hand",
  "confidence": 0.938211,
  "consecutive_risky_frames": 5,
  "alert_duration_seconds": 1.104,
  "event_threshold_seconds": 2,
  "predictions": [
    { "label": "cheating", "confidence": 0.938211 }
  ],
  "type": "status"
}
```

Fields:

- `type`: always `status`.
- `timestamp`: local backend timestamp for the inference result.
- `status`: confirmed display-ready event category, one of `Fail`, `Risky`, or `All Clear`.
- `category`: same category value as `status`.
- `cheating_suspected`: boolean alert state after applying the 70% confidence and sustained-event threshold.
- `label`: raw top model label for the current frame.
- `confidence`: model confidence for `label`.
- `consecutive_risky_frames`: current risky-frame streak.
- `alert_duration_seconds`: how long the current `Fail` or `Risky` category has been continuous.
- `event_threshold_seconds`: configured event duration threshold.
- `predictions`: all class probabilities sent by the classifier page.

When a browser uploads an evidence clip, all WebSocket clients also receive:

```json
{
  "type": "evidence",
  "id": "evidence-2026-06-13T18-42-11-123Z-risky-hand",
  "timestamp": "2026-06-13T18:42:06.000Z",
  "received_at": "2026-06-13T18:42:11.123Z",
  "category": "Risky",
  "status": "Risky",
  "label": "Hand",
  "confidence": 0.938211,
  "alert_duration_seconds": 2.104,
  "video_url": "/evidence/evidence-2026-06-13T18-42-11-123Z-risky-hand.webm",
  "filename": "evidence-2026-06-13T18-42-11-123Z-risky-hand.webm",
  "size_bytes": 384000
}
```

Minimal browser client:

```html
<script>
  const socket = new WebSocket("ws://127.0.0.1:3000/status");
  socket.onmessage = (event) => {
    const status = JSON.parse(event.data);
    console.log(status.cheating_suspected, status.status, status.label);
  };
</script>
```
