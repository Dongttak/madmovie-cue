import hashlib
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ops.transitions import transition_filter


class TransitionTests(unittest.TestCase):
    def frames(self, filter):
        result = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-filter_threads", "1",
                                 "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=60:duration=2",
                                 "-vf", "format=gray," + filter, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                                capture_output=True, check=True)
        return [hashlib.sha256(result.stdout[n:n+6144]).digest() for n in range(0,len(result.stdout),6144)]

    def test_effects_change_boundary_only_and_keep_frame_count(self):
        baseline = self.frames("null")
        for kind, margin, direction in [("blink",4,None),("whip",6,"left"),
                                        ("whip",6,"right"),("match_cut",2,None)]:
            with self.subTest(kind=kind,direction=direction):
                event={"frame":60,"preset":kind}
                if direction:
                    event["direction"]=direction
                got = self.frames(transition_filter([event],120))
                self.assertEqual(len(got),120)
                self.assertEqual(got[:60-margin],baseline[:60-margin])
                self.assertEqual(got[60+margin:],baseline[60+margin:])
                self.assertTrue(any(got[n]!=baseline[n] for n in range(60-margin,60+margin)))

    def test_bad_plans(self):
        for events in [[],[{}],[{"frame":True,"preset":"blink"}],[{"frame":0,"preset":"blink"}],
                       [{"frame":60,"preset":"unknown"}],[{"frame":60,"preset":"blink","direction":"up"}],
                       [{"frame":60,"preset":"blink"},{"frame":62,"preset":"whip"}],
                       [{"frame":60,"preset":"blink","unexpected":1}]]:
            with self.subTest(events=events), self.assertRaises(ValueError):
                transition_filter(events,120)


if __name__ == "__main__":
    unittest.main()
