from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass(frozen=True)
class Prediction:
    label: str
    confidence: float


def _load_interpreter(model_path: Path):
    try:
        from tflite_runtime.interpreter import Interpreter
    except ImportError:
        try:
            import tensorflow as tf
        except ImportError as exc:
            raise RuntimeError(
                "Install either tflite-runtime or tensorflow to run a .tflite model"
            ) from exc
        return tf.lite.Interpreter(model_path=str(model_path))
    return Interpreter(model_path=str(model_path))


class TFLiteImageClassifier:
    def __init__(self, model_path: Path, labels_path: Path) -> None:
        self.model_path = model_path
        self.labels = self._read_labels(labels_path)
        self.interpreter = _load_interpreter(model_path)
        self.interpreter.allocate_tensors()
        self.input_details = self.interpreter.get_input_details()[0]
        self.output_details = self.interpreter.get_output_details()[0]
        _, self.input_height, self.input_width, self.channels = self.input_details["shape"]
        if self.channels != 3:
            raise ValueError("Expected an image model with 3 input channels")

    def predict(self, frame_bgr: np.ndarray) -> Prediction:
        input_tensor = self._preprocess(frame_bgr)
        self.interpreter.set_tensor(self.input_details["index"], input_tensor)
        self.interpreter.invoke()
        output = self.interpreter.get_tensor(self.output_details["index"])[0]
        if np.issubdtype(output.dtype, np.integer):
            output = self._dequantize(output, self.output_details)

        class_index = int(np.argmax(output))
        confidence = float(output[class_index])
        label = self.labels[class_index] if class_index < len(self.labels) else str(class_index)
        return Prediction(label=label, confidence=confidence)

    def _preprocess(self, frame_bgr: np.ndarray) -> np.ndarray:
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(frame_rgb, (self.input_width, self.input_height), interpolation=cv2.INTER_AREA)
        batched = np.expand_dims(resized, axis=0)

        dtype = self.input_details["dtype"]
        if np.issubdtype(dtype, np.floating):
            # Teachable Machine image models commonly expect normalized RGB values.
            batched = (batched.astype(np.float32) / 127.5) - 1.0
        else:
            batched = batched.astype(dtype)

        return batched

    @staticmethod
    def _dequantize(values: np.ndarray, tensor_details: dict) -> np.ndarray:
        scale, zero_point = tensor_details.get("quantization", (0.0, 0))
        if scale == 0:
            return values.astype(np.float32)
        return scale * (values.astype(np.float32) - zero_point)

    @staticmethod
    def _read_labels(labels_path: Path) -> list[str]:
        labels: list[str] = []
        for line in labels_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            parts = stripped.split(maxsplit=1)
            labels.append(parts[1] if parts[0].isdigit() and len(parts) > 1 else stripped)
        return labels
