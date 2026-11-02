import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ops.effectcraft_preview import windows


class ImpactWindowsTest(unittest.TestCase):
    def test_frame_boundaries(self):
        self.assertEqual(windows([1.8, 6.6], 60, 1020, PRESET),
                         [(102, 123, 108), (390, 411, 396)])

    def test_invalid_markers(self):
        for markers in [[], [float("nan")], [-1], [20], [1, 1.1], [6, 2], [True]]:
            with self.subTest(markers=markers), self.assertRaises(ValueError):
                windows(markers, 60, 1020, PRESET)


PRESET = {"attackSeconds": .1, "releaseSeconds": .25}
if __name__ == "__main__":
    unittest.main()
