from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from anti_kt.alert import ConsecutiveFrameAlert
from anti_kt.arduino import ArduinoConfig, ArduinoStatusDisplay
from anti_kt.camera import CameraFrameSource
from anti_kt.logger import ClassificationRecord, CsvClassificationLogger
from anti_kt.model import load_image_classifier
from anti_kt.websocket_status import StatusEvent, WebSocketStatusServer


@dataclass(frozen=True)
class RuntimeConfig:
    model_path: Path
    labels_path: Path | None
    arduino_port: str
    camera_index: int = 0
    cheating_labels: frozenset[str] = frozenset({"Standing", "Phone", "Croutch", "suspicious"})
    consecutive_threshold: int = 5
    confidence_threshold: float = 0.7
    interval_seconds: float = 0.2
    log_path: Path = Path("logs/classifications.csv")
    websocket_host: str = "127.0.0.1"
    websocket_port: int = 8765


class ExamRoomClassifier:
    def __init__(self, config: RuntimeConfig) -> None:
        self.config = config
        self.classifier = load_image_classifier(config.model_path, config.labels_path)
        self.alerts = ConsecutiveFrameAlert(set(config.cheating_labels), config.consecutive_threshold)

    def run(self) -> None:
        camera = CameraFrameSource(self.config.camera_index)
        arduino = ArduinoStatusDisplay(ArduinoConfig(port=self.config.arduino_port))
        logger = CsvClassificationLogger(self.config.log_path)
        websocket_server = WebSocketStatusServer(self.config.websocket_host, self.config.websocket_port)

        websocket_server.start()
        print(f"WebSocket status server listening on {websocket_server.url}", flush=True)

        try:
            with camera, arduino, logger:
                arduino.send_status(False)
                for frame in camera.frames():
                    prediction = self.classifier.predict(frame)
                    label_for_alert = (
                        prediction.label
                        if prediction.confidence >= self.config.confidence_threshold
                        else "uncertain"
                    )
                    decision = self.alerts.update(label_for_alert)
                    timestamp = datetime.now()
                    arduino.send_status(decision.should_alert)
                    logger.write(
                        ClassificationRecord(
                            timestamp=timestamp,
                            label=prediction.label,
                            confidence=prediction.confidence,
                            status=decision.status,
                            consecutive_risky_frames=decision.consecutive_risky_frames,
                        )
                    )
                    websocket_server.broadcast(
                        StatusEvent(
                            timestamp=timestamp,
                            status=decision.status,
                            cheating_suspected=decision.should_alert,
                            label=prediction.label,
                            confidence=prediction.confidence,
                            consecutive_risky_frames=decision.consecutive_risky_frames,
                        )
                    )
                    print(
                        f"{decision.status}: {prediction.label} "
                        f"({prediction.confidence:.2%}), streak={decision.consecutive_risky_frames}",
                        flush=True,
                    )
                    time.sleep(self.config.interval_seconds)
        finally:
            websocket_server.stop()
