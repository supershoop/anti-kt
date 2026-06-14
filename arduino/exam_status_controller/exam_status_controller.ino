#include <LiquidCrystal.h>
#include <IRremote.hpp>

const int RS = 13;
const int EN = 12;
const int D4 = 11;
const int D5 = 10;
const int D6 = 9;
const int D7 = 8;
const int BUZZER_PIN = 7; 
const int RED = 6;
const int GREEN = 5;
const int IR_RECEIVE_PIN = 2;
const unsigned long IR_DEBOUNCE_MS = 250;
const unsigned long ACTIVE_BUZZER_PERIOD_MS = 700;
const unsigned long ACTIVE_BUZZER_ON_MS = 180;
const int FAIL_BEEP_LIMIT = 6;

LiquidCrystal lcd(RS, EN, D4, D5, D6, D7);

String inputLine = "";
enum StatusMode {
  MODE_CLEAR,
  MODE_WARN,
  MODE_FAIL
};
StatusMode statusMode = MODE_CLEAR;
unsigned long lastIrPressMs = 0;
uint8_t lastIrCommand = 0;
uint32_t lastIrRaw = 0;
int failBeepsRemaining = 0;
bool buzzerWasOn = false;

void showClear() {
  statusMode = MODE_CLEAR;
  failBeepsRemaining = 0;
  buzzerWasOn = false;
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("NORMAL");
  digitalWrite(BUZZER_PIN, LOW);
}

void showAlert(String type, String reason) {
  reason.trim();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(type);
  lcd.setCursor(0, 1);
  lcd.print(reason.substring(0, 16));
}

void setup() {
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(GREEN, OUTPUT);
  pinMode(RED, OUTPUT);
  Serial.begin(9600);
  IrReceiver.begin(IR_RECEIVE_PIN, DISABLE_LED_FEEDBACK);
  lcd.begin(16, 2);
  showClear();
}

void loop() {
  while (Serial.available() > 0) {
    char incoming = (char)Serial.read();
    if (incoming == '\n') {
      inputLine.trim();
      if (inputLine.startsWith("FAIL")) {
        if (statusMode == MODE_CLEAR) {
          failBeepsRemaining = FAIL_BEEP_LIMIT;
          buzzerWasOn = false;
        }
        statusMode = MODE_FAIL;
        showAlert("FLAGGED", inputLine.substring(5));
      } else if (inputLine.startsWith("WARN")) {
        if (statusMode != MODE_FAIL) {
          statusMode = MODE_WARN;
          failBeepsRemaining = 0;
          buzzerWasOn = false;
          digitalWrite(BUZZER_PIN, LOW);
          showAlert("CAUTION", inputLine.substring(4));
        }
      } else if (inputLine == "CLEAR") {
        if (statusMode != MODE_FAIL) {
          showClear();
        }
      }
      inputLine = "";
    } else {
      inputLine += incoming;
    }
  }

  if (IrReceiver.decode()) {
    uint8_t command = IrReceiver.decodedIRData.command;
    uint32_t raw = IrReceiver.decodedIRData.decodedRawData;
    unsigned long now = millis();
    bool isRepeat = (IrReceiver.decodedIRData.flags & IRDATA_FLAGS_IS_REPEAT) != 0;
    bool isBounce = command == lastIrCommand && raw == lastIrRaw && now - lastIrPressMs < IR_DEBOUNCE_MS;

    if (!isRepeat && !isBounce) {
      lastIrPressMs = now;
      lastIrCommand = command;
      lastIrRaw = raw;

      Serial.print("Command: 0x");
      Serial.println(command, HEX);
      Serial.print("Raw: 0x");
      Serial.println(raw, HEX);

      if (command == 0x40) {
        statusMode = MODE_CLEAR;
        showClear();
      }
    }

    IrReceiver.resume();
  }
  
  bool buzzerOn =
      statusMode == MODE_FAIL &&
      failBeepsRemaining > 0 &&
      millis() % ACTIVE_BUZZER_PERIOD_MS < ACTIVE_BUZZER_ON_MS;
  if (buzzerOn && !buzzerWasOn) {
    failBeepsRemaining -= 1;
  }
  buzzerWasOn = buzzerOn;
  digitalWrite(BUZZER_PIN, buzzerOn ? HIGH : LOW);

  digitalWrite(GREEN, LOW);
  analogWrite(RED, 0);
  if (statusMode == MODE_FAIL) {
    analogWrite(RED, ((millis() / 350) % 2 == 1) ? 0 : 255);
  } else if (statusMode == MODE_WARN) {
    analogWrite(RED, 185);
    digitalWrite(GREEN, HIGH);
  } else {
    digitalWrite(GREEN, HIGH);
  }
}
