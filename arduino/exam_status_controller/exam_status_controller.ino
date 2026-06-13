#include <LiquidCrystal.h>

const int RS = 13;
const int EN = 12;
const int D4 = 11;
const int D5 = 10;
const int D6 = 9;
const int D7 = 8;
const int BUZZER_PIN = 7;
const int RED = 6;
const int GREEN = 5;

LiquidCrystal lcd(RS, EN, D4, D5, D6, D7);

String inputLine = "";
bool cheatingSuspected = false;
unsigned long lastBeepMs = 0;

void showClear() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("All Clear");
  noTone(BUZZER_PIN);
}

void showCheating(String reason) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Violation");
  lcd.setCursor(0, 1);
  lcd.print(reason);
}

void setup() {
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(GREEN, OUTPUT);
  pinMode(RED, OUTPUT);
  Serial.begin(9600);
  lcd.begin(16, 2);
  showClear();
}

void loop() {
  while (Serial.available() > 0) {
    char incoming = (char)Serial.read();
    if (incoming == '\n') {
      inputLine.trim();
      if (inputLine.startsWith("CHEAT") && !cheatingSuspected) {
        cheatingSuspected = true;
        showCheating(inputLine.substring(6));
      } else if (inputLine == "CLEAR" && cheatingSuspected) {
        cheatingSuspected = false;
        showClear();
      }
      inputLine = "";
    } else {
      inputLine += incoming;
    }
  }

  if (cheatingSuspected && millis() - lastBeepMs > 700) {
    tone(BUZZER_PIN, 2000, 180);
    lastBeepMs = millis();
  }
  digitalWrite(GREEN, cheatingSuspected ? LOW : HIGH);
  digitalWrite(RED, cheatingSuspected ? ((((millis()-lastBeepMs) / 350) % 2 == 1) ? LOW : HIGH) : LOW);
  Serial.write("Ping");
}
