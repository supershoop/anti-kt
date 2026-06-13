from __future__ import annotations

from collections.abc import Iterator

import cv2
import numpy as np


class CameraFrameSource:
    def __init__(self, camera_index: int, width: int | None = None, height: int | None = None) -> None:
        self.camera_index = camera_index
        self.width = width
        self.height = height
        self._capture: cv2.VideoCapture | None = None

    def open(self) -> None:
        self._capture = cv2.VideoCapture(self.camera_index)
        if not self._capture.isOpened():
            raise RuntimeError(f"Could not open camera index {self.camera_index}")
        if self.width is not None:
            self._capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        if self.height is not None:
            self._capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)

    def frames(self) -> Iterator[np.ndarray]:
        if self._capture is None:
            self.open()

        while True:
            assert self._capture is not None
            ok, frame_bgr = self._capture.read()
            if not ok:
                raise RuntimeError("Camera read failed")
            yield frame_bgr

    def close(self) -> None:
        if self._capture is not None:
            self._capture.release()

    def __enter__(self) -> "CameraFrameSource":
        self.open()
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

