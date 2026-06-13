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
pip install tensorflow
```

If you prefer the smaller runtime, install `tflite-runtime` instead of
`tensorflow` when it is available for your platform.

## Model files

Export your Teachable Machine image model as TensorFlow Lite and place the files
under `models/`, for example:

```text
models/model.tflite
models/labels.txt
```

The Python runtime directly supports `.tflite`. If you exported TF.js instead,
convert it to TFLite or export the TFLite version from Teachable Machine before
running this backend.

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
  --model models/model.tflite \
  --labels models/labels.txt \
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
