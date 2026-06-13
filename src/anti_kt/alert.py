from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AlertDecision:
    status: str
    should_alert: bool
    consecutive_risky_frames: int


class ConsecutiveFrameAlert:
    def __init__(self, cheating_labels: set[str], threshold: int) -> None:
        if threshold < 1:
            raise ValueError("threshold must be at least 1")
        self.cheating_labels = {label.lower() for label in cheating_labels}
        self.threshold = threshold
        self._consecutive_risky_frames = 0

    def update(self, label: str) -> AlertDecision:
        is_risky = label.lower() in self.cheating_labels
        if is_risky:
            self._consecutive_risky_frames += 1
        else:
            self._consecutive_risky_frames = 0

        should_alert = self._consecutive_risky_frames >= self.threshold
        status = "Cheating suspected" if should_alert else "All clear"
        return AlertDecision(
            status=status,
            should_alert=should_alert,
            consecutive_risky_frames=self._consecutive_risky_frames,
        )

