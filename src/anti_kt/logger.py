from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass(frozen=True)
class ClassificationRecord:
    timestamp: datetime
    label: str
    confidence: float
    status: str
    consecutive_risky_frames: int


class CsvClassificationLogger:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = self.path.open("a", newline="", encoding="utf-8")
        self._writer = csv.DictWriter(
            self._file,
            fieldnames=[
                "timestamp",
                "label",
                "confidence",
                "status",
                "consecutive_risky_frames",
            ],
        )
        if self.path.stat().st_size == 0:
            self._writer.writeheader()

    def write(self, record: ClassificationRecord) -> None:
        self._writer.writerow(
            {
                "timestamp": record.timestamp.isoformat(timespec="milliseconds"),
                "label": record.label,
                "confidence": f"{record.confidence:.6f}",
                "status": record.status,
                "consecutive_risky_frames": record.consecutive_risky_frames,
            }
        )
        self._file.flush()

    def close(self) -> None:
        self._file.close()

    def __enter__(self) -> "CsvClassificationLogger":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

