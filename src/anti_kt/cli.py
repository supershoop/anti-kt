from __future__ import annotations

import argparse
from pathlib import Path

from anti_kt.runtime import ExamRoomClassifier, RuntimeConfig


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the anti-kt exam room classifier")
    parser.add_argument("--model", type=Path, required=True, help="Path to the exported .tflite model")
    parser.add_argument("--labels", type=Path, required=True, help="Path to labels.txt")
    parser.add_argument("--arduino-port", required=True, help="Serial port, for example /dev/cu.usbmodem1101")
    parser.add_argument("--camera-index", type=int, default=0, help="OpenCV camera index")
    parser.add_argument("--threshold", type=int, default=5, help="Consecutive risky frames before alerting")
    parser.add_argument("--confidence", type=float, default=0.7, help="Minimum confidence to count a risky class")
    parser.add_argument("--interval", type=float, default=0.2, help="Seconds between inferences")
    parser.add_argument("--log", type=Path, default=Path("logs/classifications.csv"), help="CSV log path")
    parser.add_argument(
        "--cheating-label",
        action="append",
        dest="cheating_labels",
        default=None,
        help="Label that should count as risky. Can be passed multiple times.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = RuntimeConfig(
        model_path=args.model,
        labels_path=args.labels,
        arduino_port=args.arduino_port,
        camera_index=args.camera_index,
        cheating_labels=frozenset(args.cheating_labels or {"cheating", "looking away", "phone", "suspicious"}),
        consecutive_threshold=args.threshold,
        confidence_threshold=args.confidence,
        interval_seconds=args.interval,
        log_path=args.log,
    )
    ExamRoomClassifier(config).run()


if __name__ == "__main__":
    main()

