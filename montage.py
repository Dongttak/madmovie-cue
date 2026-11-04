"""Validate and arrange selected highlights; never repeat or discover game scenes."""
import math
import json
import wave
import array
import sys
import media

FPS = 30
MIN_FRAMES = 3
SCALE_FILTER = "scale=w='max(2,trunc(min(720,1280*dar)/2)*2)':h='max(2,trunc(min(1280,720/dar)/2)*2)',setsar=1,pad=720:1280:(ow-iw)/2:(oh-ih)/2"
LANDSCAPE_FILTER = "scale=w='max(2,trunc(min(1280,720*dar)/2)*2)':h='max(2,trunc(min(720,1280/dar)/2)*2)',setsar=1,pad=1280:720:(ow-iw)/2:(oh-ih)/2"


class RenderError(Exception):
    pass


def number(value, minimum=0, maximum=None):
    # Bound source-time arithmetic before multiplying by FPS or rounding frames.
    if maximum is None:
        maximum = 24 * 60 * 60
    try:
        valid = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
    except OverflowError:
        valid = False
    if not valid or value < minimum or (maximum is not None and value > maximum):
        raise ValueError("시작 시간과 길이를 유효한 숫자로 입력하세요.")
    return value


def profile(data):
    mode = data.get("mode", "beats")
    layout = data.get("layout", "wide" if mode == "continuity" else "portrait")
    fps = data.get("fps", 60 if mode == "continuity" else 30)
    game = data.get("gameAudio", mode == "continuity")
    if mode not in ("beats", "continuity") or layout not in ("portrait", "landscape", "wide") or type(fps) is not int or fps not in (30, 60) or type(game) is not bool:
        raise ValueError("편집 방식·화면 비율·프레임·게임 소리 설정을 확인하세요.")
    return {"mode": mode, "layout": layout, "fps": fps, "gameAudio": game}


def validate_accent(value, start, duration):
    if not isinstance(value, dict) or value.get("kind") not in ("focus", "slow"):
        raise ValueError("강조는 짧은 줌 또는 슬로모션으로 선택하세요.")
    at = number(value.get("time"), start + .3, start + duration - .3)
    return {"time": at, "kind": value["kind"]}


def source_clock(t, hit, slow):
    """Continuous source -> output clock; 1x at both edges, 0.5x at the hit."""
    x = max(0, min(.6, t - hit + .3))
    return t + (.3 * (x / .6 - math.sin(math.pi*x/.3)/(2*math.pi)) if slow else 0)


def inverse_clock(t, hit, slow, duration):
    lo, hi = 0, duration
    for _ in range(35):
        mid = (lo + hi) / 2
        if source_clock(mid, hit, slow) < t:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def retime_sound(path, segment, fps, deadline, remaining):
    """Use the same monotone clock for game audio; music keeps its native tempo."""
    accent = segment.get("accent")
    if not accent or accent["kind"] != "slow":
        return
    with wave.open(str(path), "rb") as source:
        pcm = array.array('h', source.readframes(source.getnframes()))
    if sys.byteorder != 'little':
        pcm.byteswap()
    hit = accent["time"] - segment["sourceStart"]
    count = round(segment["duration"] * fps)
    positions = [inverse_clock(i/fps, hit, True, segment["sourceDuration"]) * 48000 for i in range(count+1)]
    output = array.array('h')
    for j in range(round(segment["duration"]*48000)):
        if j % 48000 == 0:
            remaining(deadline)
        frame, fraction = divmod(j*fps, 48000)
        source = positions[frame] + (positions[frame+1]-positions[frame])*fraction/48000
        k, part = int(source), source-int(source)
        for channel in (0, 1):
            a = pcm[min(2*k+channel, len(pcm)-2+channel)]
            b = pcm[min(2*(k+1)+channel, len(pcm)-2+channel)]
            output.append(round(a+(b-a)*part))
    if sys.byteorder != 'little':
        output.byteswap()
    with wave.open(str(path), "wb") as target:
        target.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
        target.writeframes(output.tobytes())


def validate_plan(data):
    if not isinstance(data, dict) or not isinstance(data.get("track"), str):
        raise ValueError("목록에서 NCS 음악을 골라주세요.")
    music_start = number(data.get("musicStart", 0))
    settings = profile(data)
    length = number(data.get("length", 15), .1, 60)
    clips = data.get("clips")
    if not isinstance(clips, list) or not (1 if settings["mode"] == "continuity" else 2) <= len(clips) <= 8:
        raise ValueError("교전 유지 모드는 1~8개, 박자 배치는 2~8개 영상을 골라주세요.")
    normalized = []
    for clip in clips:
        if not isinstance(clip, dict):
            raise ValueError("영상의 시작 시간과 길이를 확인하세요.")
        duration, start = number(clip.get("duration")), number(clip.get("start", 0))
        end = number(clip.get("end", duration), 0, duration)
        if end - start < .1 - 1e-8:
            raise ValueError("각 영상에는 시작 시간 이후 최소 0.1초가 남아야 해요.")
        item = {"duration": end, "start": start}
        if clip.get("accent") is not None:
            if settings["mode"] != "continuity":
                raise ValueError("선택적 강조는 교전 유지 모드에서 사용하세요.")
            item["accent"] = validate_accent(clip["accent"], start, end-start)
        normalized.append(item)
    bpm = data.get("bpm")
    if bpm is not None:
        bpm = number(bpm, 30, 300)
    offset = number(data.get("offset", 0))
    return {"track": data["track"], "musicStart": music_start, "length": length, "clips": normalized, "bpm": bpm, "offset": offset, **settings}


def plan_segments(request, analysis):
    clips, music_start = request["clips"], request["musicStart"]
    available_music = analysis["duration"] - music_start
    if available_music <= 0:
        raise ValueError("음악 시작 시간을 곡 길이 안으로 지정하세요.")
    fps = request.get("fps", FPS)
    if request.get("mode") == "continuity":
        segments, position = [], 0
        for i, clip in enumerate(clips):
            start = math.ceil(clip["start"] * fps - 1e-7)
            end = math.floor(clip["duration"] * fps + 1e-7)
            if end - start < math.ceil(.1 * fps):
                raise ValueError("각 선택 구간에는 최소 0.1초의 완전한 프레임이 필요해요.")
            segment = {"fileIndex": i, "sourceStart": start / fps, "duration": (end-start)/fps, "timelineStart": position/fps}
            if clip.get("accent"):
                segment["accent"] = validate_accent(clip["accent"], start/fps, (end-start)/fps)
                segment["sourceDuration"] = segment["duration"]
                segment["duration"] += .3 if segment["accent"]["kind"] == "slow" else 0
            segments.append(segment)
            position += round(segment["duration"]*fps)
        if position > 60*fps:
            raise ValueError("선택한 교전이 60초를 넘어요. 각 구간의 끝을 직접 줄여주세요. 자동으로 잘라내지 않아요.")
        if position > math.floor(available_music*fps+1e-7):
            raise ValueError("선택 구간보다 남은 음악이 짧아요. 음악 시작 또는 교전 끝을 조절하세요.")
        return {**profile(request), "bpm": None, "offset": 0, "duration": position/fps, "segments": segments}
    capacities = [math.floor(min(60, clip["duration"] - clip["start"]) * fps + 1e-7) for clip in clips]
    total = min(math.floor(min(request["length"], available_music) * fps + 1e-7), sum(capacities))
    minimum_frames = math.ceil(.1 * fps)
    if total < minimum_frames * len(clips):
        raise ValueError("모든 영상을 넣기에는 구간이 짧아요. 음악 길이를 늘리거나 영상 수를 줄이세요.")
    allocations = [0] * len(clips)
    active, left = list(range(len(clips))), total
    while active:
        share = left / len(active)
        short = [i for i in active if capacities[i] < share]
        if not short:
            for i in active:
                allocations[i] = share
            break
        for i in short:
            allocations[i] = capacities[i]
            left -= capacities[i]
            active.remove(i)
    bpm = request["bpm"] if request["bpm"] is not None else analysis.get("bpm")
    offset = request["offset"] if request["bpm"] is not None else analysis.get("offset", 0)
    period = 60 / bpm if bpm is not None else None
    phase = offset
    segments, position, ideal, missed = [], 0, 0, False
    for i, clip in enumerate(clips):
        if i == len(clips) - 1:
            boundary = total
        else:
            ideal += allocations[i]
            lower = max(position + minimum_frames, total - sum(capacities[i + 1:]))
            upper = min(position + capacities[i], total - minimum_frames * (len(clips) - i - 1))
            boundary = max(lower, min(upper, math.floor(ideal + .5)))
            if period:
                missed_cut = True
                if phase <= music_start + (upper + .5) / fps:
                    first = max(0, math.ceil((music_start + (lower - .5) / fps - phase) / period))
                    last = math.floor((music_start + (upper + .5) / fps - phase) / period)
                    if first <= last:
                        beat = max(first, min(last, math.floor((music_start + ideal / fps - phase) / period + .5)))
                        snapped = math.floor((phase + beat * period - music_start) * fps + .5)
                        if lower <= snapped <= upper:
                            boundary, missed_cut = snapped, False
                missed = missed or missed_cut
        segments.append({"fileIndex": i, "sourceStart": clip["start"], "duration": (boundary - position) / fps, "timelineStart": position / fps})
        position = boundary
    result = {**profile(request), "bpm": bpm, "offset": offset, "mode": "beats" if bpm is not None else "uniform", "duration": total / fps, "segments": segments}
    if bpm is None:
        result["warning"] = "박자를 확신하지 못해 길이를 나눠 배치했어요. BPM을 직접 입력하면 박자에 맞춰 다시 배치할 수 있어요."
    elif missed:
        result["warning"] = "클립 길이가 짧아 일부 전환점을 박자에 맞추지 못했어요. 전환점은 출력 프레임 단위로 반올림해요."
    return result


def validate_manifest(data):
    if not isinstance(data, dict) or not isinstance(data.get("track"), str):
        raise ValueError("목록에서 NCS 음악을 골라주세요.")
    music_start = number(data.get("musicStart", 0))
    settings = profile(data)
    fps = settings["fps"]
    files, segments = data.get("files"), data.get("segments")
    if not isinstance(files, list) or not isinstance(segments, list) or not (1 if settings["mode"] == "continuity" else 2) <= len(files) <= 8 or len(segments) != len(files):
        raise ValueError("배치와 2~8개 영상 파일을 다시 확인하세요.")
    sizes = []
    for item in files:
        if not isinstance(item, dict) or isinstance(item.get("size"), bool) or not isinstance(item.get("size"), int) or item["size"] <= 0:
            raise ValueError("영상 파일 크기를 확인하지 못했어요.")
        sizes.append(item["size"])
    position, normalized = 0, []
    for i, segment in enumerate(segments):
        if not isinstance(segment, dict) or type(segment.get("fileIndex")) is not int or segment["fileIndex"] != i:
            raise ValueError("각 영상을 입력한 순서대로 한 번씩 배치하세요.")
        start = number(segment.get("sourceStart"))
        duration = number(segment.get("duration"), .1, 60)
        timeline = number(segment.get("timelineStart"))
        frames = round(duration * fps)
        if abs(timeline - position / fps) > 1e-5 or abs(duration - frames / fps) > 1e-5:
            raise ValueError("배치가 출력 프레임과 맞지 않아요. 배치를 다시 생성하세요.")
        item = {"fileIndex": i, "sourceStart": start, "duration": frames / fps, "timelineStart": position / fps}
        if segment.get("accent") is not None:
            if settings["mode"] != "continuity":
                raise ValueError("선택적 강조는 교전 유지 모드에서 사용하세요.")
            source_duration = number(segment.get("sourceDuration"), .6, 60)
            accent = validate_accent(segment["accent"], start, source_duration)
            expected = source_duration + (.3 if accent["kind"] == "slow" else 0)
            if abs(expected-duration) > 1e-5 or abs(source_duration*fps-round(source_duration*fps)) > 1e-5:
                raise ValueError("강조 구간의 원본·출력 길이가 맞지 않아요. 배치를 다시 확인하세요.")
            item.update(sourceDuration=source_duration, accent=accent)
        normalized.append(item)
        position += frames
    if position > 60 * fps:
        raise ValueError("완성 영상은 60초 이내로 배치하세요.")
    return {"track": data["track"], "musicStart": music_start, "files": sizes, "segments": normalized, "duration": position / fps, **settings}


def render_segments(directory, paths, music, manifest, deadline, probe, remaining, formats):
    fps = manifest.get("fps", FPS)
    layout = manifest.get("layout", "portrait")
    keep_game = manifest.get("gameAudio", False)
    scale = SCALE_FILTER if layout == "portrait" else LANDSCAPE_FILTER
    if layout == "wide":
        scale += ",crop=1280:600:0:60"
    for path, segment in zip(paths, manifest["segments"]):
        duration = probe(path, "v", deadline)
        if segment["sourceStart"] + segment.get("sourceDuration", segment["duration"]) > duration + 1e-5:
            raise ValueError("배치 구간이 실제 영상 길이를 넘어요. 영상을 다시 읽고 배치를 생성하세요.")
    music_duration = probe(music, "a", deadline)
    if manifest["musicStart"] + manifest["duration"] > music_duration + 1e-5:
        raise ValueError("배치 구간이 실제 음악 길이를 넘어요. 음악 길이를 줄여 다시 배치하세요.")
    pieces, sounds = [], []
    for i, (path, segment) in enumerate(zip(paths, manifest["segments"])):
        output = directory / f"part-{i}.mp4"
        frames = round(segment["duration"] * fps)
        source_duration = segment.get("sourceDuration", segment["duration"])
        filters = f"fps={fps},{scale}"
        accent = segment.get("accent")
        if accent:
            hit = accent["time"]-segment["sourceStart"]
            filters = "setpts=PTS-STARTPTS"
            if accent["kind"] == "slow":
                x = f"clip((PTS*TB-{hit:.9f}+.3),0,.6)"
                filters += f",setpts='(PTS*TB+.3*({x}/.6-sin(PI*{x}/.3)/(2*PI)))/TB'"
            out_hit = source_clock(hit, hit, accent["kind"] == "slow")
            t = f"(on/{fps}-{out_hit:.9f})"
            pulse = f"if(between({t},-.18,.45),.5*(1+cos(PI*{t}/if(lt({t},0),.18,.45))),0)"
            size = "1280x600" if layout == "wide" else "1280x720" if layout == "landscape" else "720x1280"
            filters += f",fps={fps},tpad=stop_mode=clone:stop_duration=0.1,{scale},zoompan=z='1+.08*{pulse}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={size}:fps={fps}"
        media.run([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-filter_threads", "2",
            "-protocol_whitelist", "file,pipe", "-format_whitelist", formats, "-threads", "2",
            "-ss", str(segment["sourceStart"]), "-t", str(source_duration), "-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn",
            "-vf", filters, "-frames:v", str(frames),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-threads", "2", "-pix_fmt", "yuv420p",
            "-video_track_timescale", "90000", str(output),
        ], directory=directory, capture_output=True, check=True, timeout=remaining(deadline))
        metadata = media.run([
            "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames,duration",
            "-of", "json", str(output),
        ], directory=directory, capture_output=True, text=True, check=True, timeout=remaining(deadline))
        try:
            stream = json.loads(metadata.stdout)["streams"][0]
            complete = int(stream["nb_frames"]) == frames and abs(float(stream["duration"]) - frames / fps) < .001
        except (ValueError, KeyError, IndexError, TypeError):
            complete = False
        if not complete:
            raise RenderError("영상 프레임이 부족해 배치 길이를 맞추지 못했어요. 해당 영상의 구간을 줄여 다시 배치하세요.")
        pieces.append(output)
        if keep_game:
            sound = directory / f"sound-{i}.wav"
            audio_probe = media.run([
                "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", formats,
                "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "json", str(path),
            ], directory=directory, capture_output=True, text=True, check=True, timeout=remaining(deadline))
            if json.loads(audio_probe.stdout).get("streams"):
                media.run([
                    "ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", formats,
                    "-ss", str(segment["sourceStart"]), "-i", str(path), "-map", "0:a:0", "-vn",
                    "-af", f"asetpts=PTS-STARTPTS,apad,atrim=duration={source_duration}",
                    "-ar", "48000", "-ac", "2", str(sound),
                ], directory=directory, capture_output=True, check=True, timeout=remaining(deadline))
                retime_sound(sound, segment, fps, deadline, remaining)
            else:
                with wave.open(str(sound), "wb") as silence:
                    silence.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
                    left = round(segment["duration"] * 48000)
                    while left:
                        remaining(deadline)
                        count = min(left, 48000)
                        silence.writeframesraw(bytes(count * 4))
                        left -= count
            sounds.append(sound)
    # Only our fixed local filenames enter the concat list; user filenames never do.
    playlist = directory / "parts.txt"
    playlist.write_text("".join(f"file '{path.name}'\n" for path in pieces))
    output = directory / "montage.mp4"
    args = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-protocol_whitelist", "file,pipe", "-f", "concat", "-safe", "1", "-i", str(playlist),
        "-protocol_whitelist", "file,pipe", "-format_whitelist", formats,
        "-ss", str(manifest["musicStart"]), "-i", str(music),
    ]
    if keep_game:
        sound_list = directory / "sounds.txt"
        sound_list.write_text("".join(f"file '{path.name}'\n" for path in sounds))
        length = manifest["duration"]
        args += ["-protocol_whitelist", "file,pipe", "-f", "concat", "-safe", "1", "-i", str(sound_list),
                 "-filter_complex_threads", "1", "-filter_complex",
                 f"[1:a]atrim=duration={length},asetpts=PTS-STARTPTS,volume=0.5[m];"
                 f"[2:a]apad,atrim=duration={length},asetpts=PTS-STARTPTS,volume=0.45[g];"
                 f"[m][g]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.8:level=0,"
                 f"afade=t=in:d=0.02,afade=t=out:st={max(0,length-.1)}:d=0.1[a]",
                 "-map", "0:v:0", "-map", "[a]"]
    else:
        length = manifest["duration"]
        args += ["-map", "0:v:0", "-map", "1:a:0", "-af",
                 f"volume=0.8,alimiter=limit=0.8:level=0,afade=t=in:d=0.02,"
                 f"afade=t=out:st={max(0,length-.1)}:d=0.1"]
    args += ["-t", str(manifest["duration"]), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
             "-movflags", "+faststart", str(output)]
    media.run(args, directory=directory, capture_output=True, check=True, timeout=remaining(deadline))
    return output
