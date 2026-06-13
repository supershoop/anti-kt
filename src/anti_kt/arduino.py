from __future__ import annotations

import time
from dataclasses import dataclass

import serial


@dataclass(frozen=True)
class ArduinoConfig:
    port: str
    baudrate: int = 9600
    connect_delay_seconds: float = 2.0


class ArduinoStatusDisplay:
    def __init__(self, config: ArduinoConfig) -> None:
        self.config = config
        self._serial: serial.Serial | None = None
        self._last_command: str | None = None

    def connect(self) -> None:
        self._serial = serial.Serial(
            self.config.port,
            self.config.baudrate,
            timeout=1,
            write_timeout=1,
        )
        time.sleep(self.config.connect_delay_seconds)

    def send_status(self, cheating_suspected: bool) -> None:
        command = "CHEAT" if cheating_suspected else "CLEAR"
        if command == self._last_command:
            return
        if self._serial is None:
            raise RuntimeError("Arduino serial connection has not been opened")
        self._serial.write(f"{command}\n".encode("ascii"))
        self._serial.flush()
        self._last_command = command

    def close(self) -> None:
        if self._serial is not None and self._serial.is_open:
            self._serial.close()

    def __enter__(self) -> "ArduinoStatusDisplay":
        self.connect()
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

