"""Apply brief transitions at manually selected cuts without moving the timeline."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

PRESETS = json.loads(Path(__file__).with_name("transition-presets.json").read_text())


def transition_filter(events, frames):
    if not isinstance(events, list) or not events:
        raise ValueError("At least one transition is required")
    windows, shifts, filters, blends = [], [], [], []
    for event in events:
        if not isinstance(event, dict) or set(event) - {"frame", "preset", "direction"}:
            raise ValueError("Invalid transition fields")
        frame, kind = event.get("frame"), event.get("preset")
        if isinstance(frame, bool) or not isinstance(frame, int) or not isinstance(kind, str) or kind not in PRESETS:
            raise ValueError("A transition requires an integer cut frame and a known preset")
        preset = PRESETS[kind]
        half = preset["halfFrames"]
        start, end = frame - half, frame + half - 1
        if kind == "match_cut":
            start, end = frame, frame + preset["blendFrames"] - 1
        if frame < 1 or start < 0 or end >= frames or (windows and start <= windows[-1][1]):
            raise ValueError("Transitions must be ordered, non-overlapping and inside the video")
        direction = event.get("direction", "left")
        if direction not in ("left", "right") or ("direction" in event and kind != "whip"):
            raise ValueError("Only whip transitions accept left/right screen-motion direction")
        windows.append((start, end))
        if kind == "match_cut":
            blends.append(f"between(N,{start+1},{end+1})")
            continue
        # Three short blur levels soften the onset and release without adding a flash.
        for radius, weight in [(half, .25), (max(1, half//2), .5), (1, .7)]:
            filters.append(f"gblur=sigma={preset['blurX']*weight}:sigmaV={preset['blurY']*weight}:"
                           f"enable='between(n,{frame-radius},{frame+radius-1})'")
        if preset["panPixels"]:
            sign = 1 if direction == "left" else -1
            amount = preset["panPixels"] * sign
            shifts.append(f"if(between(n,{start},{frame-1}),{amount}*pow((n-{start})/{half-1},2),"
                          f"if(between(n,{frame},{end}),-{amount}*pow(({end}-n)/{half-1},2),0))")
    if shifts:
        pan = "+".join(shifts)
        filters[:0] = ["pad=iw+64:ih:32:0:color=black", "fillborders=left=32:right=32:mode=smear",
                       f"crop=iw-64:ih:x='32+({pan})':y=0:exact=1"]
    graph = ",".join(filters)
    if blends:
        # Select original pixels outside cuts: tmix's timeline bypass can still blend other frames.
        graph += ("," if graph else "") + "split=2[clean][mix];[mix]tmix=frames=2:weights='1 1'[temporal];"
        graph += f"[clean][temporal]blend=all_expr='if({'+'.join(blends)},B,A)'"
    return graph


def run(args):
    result = subprocess.run([str(v) for v in args], capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])
    return result.stdout


def render(source, output, events):
    source, output = Path(source).resolve(), Path(output).resolve()
    if not source.is_file() or source == output or output.exists():
        raise ValueError("Input must exist and output must be a new separate file")
    metadata = json.loads(run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "stream=width,height,r_frame_rate,nb_frames", "-of", "json", source]))["streams"][0]
    frames = int(metadata["nb_frames"])
    filters = transition_filter(events, frames)
    with tempfile.TemporaryDirectory(prefix="cue-transitions-", dir=output.parent) as directory:
        temporary = Path(directory) / "rendered.mp4"
        run(["ffmpeg", "-nostdin", "-v", "error", "-filter_threads", "1", "-i", source,
             "-vf", filters, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-threads", "2",
             "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy",
             "-movflags", "+faststart", temporary])
        checked = json.loads(run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                 "stream=width,height,r_frame_rate,nb_frames", "-of", "json", temporary]))["streams"][0]
        if checked != metadata:
            raise RuntimeError(f"Transition changed video dimensions/timing: {checked}")
        temporary.replace(output)
    report = {"source": str(source), "output": str(output), "transitions": events, "presets": PRESETS,
              "checks": checked, "timingChanged": False, "audio": "stream copy", "automaticDetection": False}
    output.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("plan", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    render(args.video, args.output, json.loads(args.plan.read_text())["transitions"])
    print(args.output.resolve())
