"""Apply a reusable EffectCraft preset to an already timed video, without AI calls."""
import argparse
import json
import math
from pathlib import Path
import subprocess
import tempfile
import time

DEFAULT_CLI = Path.home() / ".local/opt/effectcraft/effectcraft-0.17.0-linux-aarch64/bin/effectcraft-cli"


def run(args, timeout=180):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:] or result.stdout[-3000:])
    return result.stdout


def windows(markers, fps, frames, preset):
    result = []
    for value in markers:
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise ValueError("Impact times must be finite numbers")
        frame = round(value * fps)
        start = frame - math.ceil(preset["attackSeconds"] * fps)
        end = frame + math.ceil(preset["releaseSeconds"] * fps)
        if start < 0 or end > frames or (result and start < result[-1][1]):
            raise ValueError("Impacts must be ordered, spaced apart, and inside the video")
        result.append((start, end, frame))
    if not result:
        raise ValueError("At least one impact is required")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("plan", type=Path, help="JSON with segments[].timelineImpact")
    parser.add_argument("output", type=Path)
    parser.add_argument("--cli", type=Path, default=DEFAULT_CLI)
    parser.add_argument("--preset", type=Path, default=Path(__file__).with_name("impact-preset.json"))
    args = parser.parse_args()
    source, output = args.video.resolve(), args.output.resolve()
    if not source.is_file() or source == output or output.exists():
        raise ValueError("Input must exist and output must be a new, separate file")
    preset = json.loads(args.preset.read_text())
    metadata = json.loads(run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                               "stream=width,height,r_frame_rate,nb_frames", "-of", "json", source]))["streams"][0]
    numerator, denominator = map(int, metadata["r_frame_rate"].split("/"))
    fps, frames = numerator / denominator, int(metadata["nb_frames"])
    width, height = metadata["width"], metadata["height"]
    duration = frames / fps
    plan = json.loads(args.plan.read_text())
    hits = windows([segment["timelineImpact"] for segment in plan["segments"]], fps, frames, preset)
    project = output.with_suffix(".ecproj")
    if project.exists():
        raise ValueError("Project already exists")
    commands = []

    def command(name, params):
        commands.extend([name, json.dumps(params)])

    def prop(layer, path, value, at=None):
        params = {"layer": layer, "path": path, "value": value}
        if at is not None:
            params["time"] = at
        command("prop.addKey" if at is not None else "prop.set", params)

    command("comp.new", {"name": "CUE Impact", "width": width, "height": height,
                         "frameRate": fps, "duration": duration})
    command("file.import", {"paths": [str(source)], "addToComp": True})
    layer = source.name
    command("effect.apply", {"effect": "ec.stylize.glow"})
    for name in ("threshold", "radius", "intensity"):
        prop(layer, f"effects/#1/{name}", {"threshold": preset["glowThreshold"],
             "radius": preset["glowRadius"], "intensity": 0}[name])
    command("layer.newSolid", {"name": "Impact flash", "color": "#ffffff", "width": width, "height": height})
    prop("Impact flash", "transform/opacity", 0)
    for start, end, hit in hits:
        t, a, b = hit / fps, start / fps, end / fps
        for at, scale, intensity in [(a, 100, 0), (t, preset["zoomPercent"], preset["glowIntensity"]),
                                      (t + .1, 102, .1), (b, 100, 0)]:
            prop(layer, "transform/scale", [scale, scale, 100], at)
            prop(layer, "effects/#1/intensity", intensity, at)
        for at, opacity in [(a, 0), (t - 1 / fps, 0), (t, preset["flashOpacity"]),
                             (t + preset["flashSeconds"], 0), (b, 0)]:
            prop("Impact flash", "transform/opacity", opacity, at)
    run([args.cli, "run", "--empty", *commands, "--save-as", project, "--json"])
    for path, expected in [("transform/scale", [preset["zoomPercent"], preset["zoomPercent"], 100]),
                           ("effects/#1/intensity", preset["glowIntensity"])]:
        sample = json.loads(run([args.cli, "get", "-", layer, path, "--time", hits[0][2] / fps,
                                 project, "--json"]))
        assert sample["animated"] and len(sample["keys"]) == len(hits) * 4, sample
        assert sample["value"] == expected, sample
    started = time.monotonic()
    # shortcut: export only short effect bursts on CPU; use full GPU rendering for layered edits.
    with tempfile.TemporaryDirectory(prefix="cue-effectcraft-", dir=output.parent) as directory:
        temporary = Path(directory)
        clips = []
        for index, (start, end, _) in enumerate(hits):
            clip = temporary / f"impact-{index}.mp4"
            run([args.cli, "render", project, "--start", start / fps, "--end", end / fps,
                 "--out", clip, "--format", "h264", "--audio", "off", "--json"])
            clips.append(clip)
            print(f"EffectCraft burst {index + 1}/{len(hits)} rendered", flush=True)
        inputs = ["ffmpeg", "-nostdin", "-v", "error", "-filter_complex_threads", "1", "-i", source]
        for clip in clips:
            inputs += ["-i", clip]
        filters, labels, cursor = [], [], 0
        for index, (start, end, _) in enumerate(hits):
            filters.append(f"[0:v]trim=start_frame={cursor}:end_frame={start},setpts=PTS-STARTPTS[b{index}]")
            filters.append(f"[{index+1}:v]fps={fps},trim=end_frame={end-start},setpts=PTS-STARTPTS[e{index}]")
            labels.extend([f"[b{index}]", f"[e{index}]"])
            cursor = end
        filters.append(f"[0:v]trim=start_frame={cursor}:end_frame={frames},setpts=PTS-STARTPTS[tail]")
        labels.append("[tail]")
        filters.append("".join(labels) + f"concat=n={len(labels)}:v=1:a=0[v]")
        assembled = temporary / "assembled.mp4"
        run([*inputs, "-filter_complex", ";".join(filters), "-map", "[v]", "-map", "0:a:0?",
             "-af", "volume=0.85", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-t", duration, "-movflags", "+faststart", assembled])
        assembled.replace(output)
    result = json.loads(run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                             "stream=nb_frames,width,height", "-of", "json", output]))["streams"][0]
    assert int(result["nb_frames"]) == frames, result
    assert (result["width"], result["height"]) == (width, height), result
    report = {"engine": run([args.cli, "--version"]).strip(), "preset": preset, "aiCalls": 0,
              "source": str(source), "output": str(output), "project": str(project),
              "duration": duration, "frames": frames, "fps": fps, "effectWindowsFrames": hits,
              "renderSeconds": round(time.monotonic() - started, 2), "checks": result}
    output.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
    print(output)


if __name__ == "__main__":
    main()
