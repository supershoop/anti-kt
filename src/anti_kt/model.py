from __future__ import annotations

import json
import atexit
import base64
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import cv2
import numpy as np


@dataclass(frozen=True)
class Prediction:
    label: str
    confidence: float


class ImageClassifier(Protocol):
    def predict(self, frame_bgr: np.ndarray) -> Prediction:
        ...


def load_image_classifier(model_path: Path, labels_path: Path | None = None) -> ImageClassifier:
    suffix = model_path.suffix.lower()
    if suffix == ".tflite":
        if labels_path is None:
            raise ValueError("A labels file is required for .tflite models")
        return TFLiteImageClassifier(model_path, labels_path)
    if suffix in {".h5", ".keras"}:
        return KerasModelClassifier(model_path, labels_path)
    raise ValueError(f"Unsupported model format '{model_path.suffix}'. Use .h5, .keras, or .tflite.")


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


class KerasModelClassifier:
    def __init__(self, model_path: Path, labels_path: Path | None = None) -> None:
        self.model_path = model_path
        self.model = self._load_model(model_path)
        self.labels = self._load_labels(model_path, labels_path)
        self.input_shape = self._single_input_shape()
        self.metadata = self._load_metadata(model_path)

        if len(self.input_shape) == 4:
            self.input_height, self.input_width, self.channels = self._image_input_shape()
            self.pose_features: PoseNetFeatureExtractor | None = None
        elif len(self.input_shape) == 2:
            feature_count = self.input_shape[1]
            if feature_count != 14739:
                raise ValueError(
                    f"Expected a Teachable Machine pose-feature model with 14739 inputs, "
                    f"got {self.input_shape}."
                )
            self.pose_features = PoseNetFeatureExtractor.from_metadata(self.metadata)
        else:
            raise ValueError(f"Unsupported Keras model input shape: {self.input_shape}")

    def predict(self, frame_bgr: np.ndarray) -> Prediction:
        input_tensor = self._preprocess(frame_bgr)
        output = np.asarray(self.model.predict(input_tensor, verbose=0))[0]
        class_index = int(np.argmax(output))
        confidence = float(output[class_index])
        label = self.labels[class_index] if class_index < len(self.labels) else str(class_index)
        return Prediction(label=label, confidence=confidence)

    def _preprocess(self, frame_bgr: np.ndarray) -> np.ndarray:
        if self.pose_features is not None:
            features = self.pose_features.extract(frame_bgr)
            return np.expand_dims(features.astype(np.float32), axis=0)

        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(frame_rgb, (self.input_width, self.input_height), interpolation=cv2.INTER_AREA)
        batched = np.expand_dims(resized.astype(np.float32), axis=0)
        return (batched / 127.5) - 1.0

    def _single_input_shape(self) -> tuple[Any, ...]:
        input_shape = self.model.input_shape
        if isinstance(input_shape, list):
            input_shape = input_shape[0]
        return tuple(input_shape)

    def _image_input_shape(self) -> tuple[int, int, int]:
        _, height, width, channels = self.input_shape
        if height is None or width is None or channels != 3:
            raise ValueError(f"Expected fixed HxWx3 image input, got {self.input_shape}")
        return int(height), int(width), int(channels)

    @staticmethod
    def _load_model(model_path: Path):
        try:
            import tensorflow as tf
        except ImportError as exc:
            raise RuntimeError("Install tensorflow to run a Keras .h5 model") from exc
        return tf.keras.models.load_model(model_path, compile=False)

    @classmethod
    def _load_labels(cls, model_path: Path, labels_path: Path | None) -> list[str]:
        if labels_path is not None:
            return cls._read_labels(labels_path)

        sibling_labels = model_path.with_name("labels.txt")
        if sibling_labels.exists():
            return cls._read_labels(sibling_labels)

        metadata_path = model_path.with_name("metadata.json")
        if metadata_path.exists():
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            labels = metadata.get("labels", [])
            if isinstance(labels, list) and all(isinstance(label, str) for label in labels):
                return labels

        return []

    @staticmethod
    def _read_labels(labels_path: Path) -> list[str]:
        return TFLiteImageClassifier._read_labels(labels_path)

    @staticmethod
    def _load_metadata(model_path: Path) -> dict[str, Any]:
        metadata_path = model_path.with_name("metadata.json")
        if metadata_path.exists():
            return json.loads(metadata_path.read_text(encoding="utf-8"))
        return {}


class PoseNetFeatureExtractor:
    def __init__(
        self,
        architecture: str = "MobileNetV1",
        output_stride: int = 16,
        input_resolution: int = 257,
        multiplier: float = 0.75,
    ) -> None:
        self.architecture = architecture
        self.output_stride = output_stride
        self.input_resolution = input_resolution
        self.multiplier = multiplier
        self._process: subprocess.Popen[str] | None = None
        atexit.register(self.close)

    @classmethod
    def from_metadata(cls, metadata: dict[str, Any]) -> "PoseNetFeatureExtractor":
        posenet_settings = metadata.get("modelSettings", {}).get("posenet", {})
        return cls(
            architecture=str(posenet_settings.get("architecture", "MobileNetV1")),
            output_stride=int(posenet_settings.get("outputStride", 16)),
            input_resolution=int(posenet_settings.get("inputResolution", 257)),
            multiplier=float(posenet_settings.get("multiplier", 0.75)),
        )

    def extract(self, frame_bgr: np.ndarray) -> np.ndarray:
        process = self._ensure_process()
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        height, width, channels = frame_rgb.shape
        if channels != 3:
            raise RuntimeError(f"Expected a 3-channel RGB frame, got {frame_rgb.shape}")

        request = {
            "image": base64.b64encode(frame_rgb.tobytes()).decode("ascii"),
            "width": int(width),
            "height": int(height),
            "settings": {
                "architecture": self.architecture,
                "outputStride": self.output_stride,
                "inputResolution": self.input_resolution,
                "multiplier": self.multiplier,
            },
        }
        assert process.stdin is not None
        assert process.stdout is not None
        process.stdin.write(json.dumps(request) + "\n")
        process.stdin.flush()

        response_line = process.stdout.readline()
        if not response_line:
            stderr = process.stderr.read() if process.stderr is not None else ""
            raise RuntimeError(f"PoseNet feature extractor stopped unexpectedly. {stderr}")

        response = json.loads(response_line)
        if "error" in response:
            raise RuntimeError(f"PoseNet feature extraction failed: {response['error']}")

        features = np.asarray(response["features"], dtype=np.float32)
        if features.shape != (14739,):
            raise RuntimeError(f"PoseNet returned {features.shape} features; expected (14739,)")
        return features

    def close(self) -> None:
        if self._process is not None and self._process.poll() is None:
            self._process.terminate()
        self._process = None

    def _ensure_process(self) -> subprocess.Popen[str]:
        if self._process is not None and self._process.poll() is None:
            return self._process

        script_path = Path(__file__).resolve().parents[2] / "scripts" / "posenet_features.js"
        self._process = subprocess.Popen(
            ["node", str(script_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if self._process.poll() is not None:
            stderr = self._process.stderr.read() if self._process.stderr is not None else ""
            raise RuntimeError(f"Could not start PoseNet feature extractor. {stderr}")

        return self._process
