# anti-kt

Real-time exam room posture/behavior classifier backend.

The Python backend opens a camera with OpenCV, feeds frames into an exported
Teachable Machine TFLite model, applies a consecutive-frame alert threshold,
logs classifications, and sends status updates to an Arduino over `pyserial`.
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
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install
```

TensorFlow is required for Keras `.h5` / `.keras` models. If you use a TFLite
model instead, you can install `tflite-runtime` where it is available.
`npm install` installs the small PoseNet sidecar used when a Teachable Machine
pose model has a flat 14,739-value input.

## Model files

Place your model files under `model/`, for example:

```text
model/model.h5
model/metadata.json
```

The Python runtime supports Keras `.h5`, Keras `.keras`, and TFLite `.tflite`
models. For `.h5` / `.keras`, labels are loaded from `--labels` when provided,
then from a sibling `labels.txt`, then from a sibling Teachable Machine
`metadata.json`.

Teachable Machine pose models are supported through a PoseNet preprocessing
sidecar. The backend mirrors the Teachable Machine pose preprocessing: pad and
resize the frame, extract PoseNet heatmaps and offsets, concatenate them on the
channel axis, flatten to the 14,739-value vector expected by the `.h5`
classifier, and then run the Keras model.

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
PYTHONPATH=src python -m anti_kt.cli \
  --model model/model.h5 \
  --arduino-port /dev/cu.usbmodem1101 \
  --camera-index 0 \
  --threshold 5 \
  --confidence 0.7 \
  --ws-host 127.0.0.1 \
  --ws-port 8765 \
  --cheating-label cheating
```

You can pass `--cheating-label` multiple times if the model has several risky
classes, for example `phone`, `looking away`, or `suspicious`.

The LCD displays:

- `All clear` while the alert threshold is not met.
- `Cheating suspected` once the model predicts a risky class for the configured
  number of consecutive confident frames.

Classification logs are written to `logs/classifications.csv`.

## WebSocket interface

The backend opens a WebSocket status feed at:

```text
ws://127.0.0.1:8765/status
```

Use `--ws-host` and `--ws-port` to change the bind address. For another device
on the same network to connect, bind to `0.0.0.0` and connect to the computer's
LAN IP address.

Each connected client receives one JSON message per inference loop. A newly
connected client also receives the latest known status immediately.

Example message:

```json
{
  "timestamp": "2026-06-13T14:30:12.123",
  "status": "Cheating suspected",
  "cheating_suspected": true,
  "label": "cheating",
  "confidence": 0.938211,
  "consecutive_risky_frames": 5,
  "type": "status"
}
```

Fields:

- `type`: always `status`.
- `timestamp`: local backend timestamp for the inference result.
- `status`: display-ready status, either `All clear` or `Cheating suspected`.
- `cheating_suspected`: boolean alert state after applying the consecutive-frame threshold.
- `label`: raw top model label for the current frame.
- `confidence`: model confidence for `label`.
- `consecutive_risky_frames`: current risky-frame streak.

Minimal browser client:

```html
<script>
  const socket = new WebSocket("ws://127.0.0.1:8765/status");
  socket.onmessage = (event) => {
    const status = JSON.parse(event.data);
    console.log(status.cheating_suspected, status.status, status.label);
  };
</script>
```
