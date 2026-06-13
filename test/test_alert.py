import unittest

from anti_kt.alert import ConsecutiveFrameAlert


class ConsecutiveFrameAlertTest(unittest.TestCase):
    def test_alert_requires_consecutive_risky_frames(self) -> None:
        alerts = ConsecutiveFrameAlert({"cheating"}, threshold=3)

        self.assertFalse(alerts.update("cheating").should_alert)
        self.assertFalse(alerts.update("cheating").should_alert)
        decision = alerts.update("cheating")

        self.assertTrue(decision.should_alert)
        self.assertEqual(decision.status, "Cheating suspected")
        self.assertEqual(decision.consecutive_risky_frames, 3)

    def test_clear_frame_resets_streak(self) -> None:
        alerts = ConsecutiveFrameAlert({"cheating"}, threshold=2)

        alerts.update("cheating")
        clear_decision = alerts.update("all clear")

        self.assertFalse(clear_decision.should_alert)
        self.assertEqual(clear_decision.status, "All clear")
        self.assertEqual(clear_decision.consecutive_risky_frames, 0)


if __name__ == "__main__":
    unittest.main()
