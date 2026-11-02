#!/usr/bin/env python3
"""Local NCS music + uploaded game video renderer; audio is never served alone."""
import json
import math
import re
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import sys
# File-based test imports need the same sibling-module path as direct execution.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import montage
import media
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

MAX_VIDEO_BYTES = 150 * 1024 * 1024
MAX_MUSIC_BYTES = 20 * 1024 * 1024
RENDER_TIMEOUT = 180
MAX_JSON_BYTES = 32 * 1024
MEDIA_FORMATS = "mov,matroska,webm,avi,mpegts,mpeg,flv,ogg,mp3,wav,aac"
MAX_CONNECTIONS = 16
CONNECTION_TIMEOUT = 15


def official_music_source(value):
    source = urlsplit(value)
    return (source.scheme == "https" and source.netloc == "ncsmusic.s3.eu-west-1.amazonaws.com"
            and source.path.startswith("/tracks/") and source.path.endswith(".mp3")
            and not source.query and not source.fragment)


def load_tracks(path):
    rows = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not rows:
        raise ValueError("NCS catalog must contain tracks")
    tracks = {}
    sources = set()
    for row in rows:
        if not isinstance(row, dict) or any(not isinstance(row.get(key), str) or not row[key].strip() for key in ("id", "title", "artist", "page", "url")):
            raise ValueError("Invalid NCS track metadata")
        page, source = urlsplit(row["page"]), urlsplit(row["url"])
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", row["id"]) or row["id"] in tracks or row["url"] in sources:
            raise ValueError("Invalid or duplicate NCS track")
        if page.scheme != "https" or page.netloc != "ncs.io" or page.path in ("", "/") or page.query or page.fragment:
            raise ValueError("Track page must be an official NCS page")
        if not official_music_source(row["url"]):
            raise ValueError("Music source must be the official NCS bucket")
        if "genre" in row and not isinstance(row["genre"], str):
            raise ValueError("Invalid NCS genre")
        tracks[row["id"]] = row
        sources.add(row["url"])
    return tracks


CATALOG_PATH = Path(__file__).with_name("ncs-catalog.json")
# Public alpha clones have no music-supply catalog; local analysis needs no API.
TRACKS = load_tracks(CATALOG_PATH) if CATALOG_PATH.exists() else {}


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class MusicRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        if not official_music_source(newurl):
            raise RequestError(502, "공식 음악 소스 밖으로의 이동을 차단했어요.")
        return super().redirect_request(request, fp, code, message, headers, newurl)


def remaining(deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise TimeoutError()
    return seconds


def fetch_music(track, output_path, deadline):
    if not official_music_source(track["url"]):
        raise RequestError(502, "공식 음악 소스가 아니에요.")
    deadline = min(deadline, time.monotonic() + 20)
    with build_opener(MusicRedirectHandler()).open(track["url"], timeout=remaining(deadline)) as response:
        if int(response.headers.get("Content-Length", "0")) > MAX_MUSIC_BYTES:
            raise RequestError(502, "선택한 음악을 가져오지 못했어요. 다른 NCS 곡으로 시도하세요.")
        size = 0
        with output_path.open("wb") as output:
            while True:
                remaining(deadline)
                chunk = response.read1(64 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_MUSIC_BYTES:
                    raise RequestError(502, "선택한 음악이 처리 가능한 크기를 넘었어요. 다른 곡으로 시도하세요.")
                output.write(chunk)
        remaining(deadline)


def probe(path, kind, deadline):
    try:
        result = media.run([
            "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS,
            "-select_streams", f"{kind}:0",
            "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", str(path),
        ], directory=path.parent, capture_output=True, text=True, check=True, timeout=remaining(deadline))
        metadata = json.loads(result.stdout)
        duration = float(metadata["format"]["duration"])
        if not metadata.get("streams") or not math.isfinite(duration) or duration <= 0:
            raise ValueError()
        if kind == "v":
            stream = metadata["streams"][0]
            width, height = stream.get("width", 0), stream.get("height", 0)
            if not 0 < width <= 8192 or not 0 < height <= 8192 or width * height > 8192 * 4320:
                raise RequestError(422, "영상 해상도가 처리 범위를 넘어요. 8K 이하로 줄여주세요.")
        return duration
    except (subprocess.CalledProcessError, ValueError, KeyError, TypeError):
        raise RequestError(422, "음악 또는 영상을 읽지 못했어요. 재생 가능한 MP4 영상이나 다른 NCS 곡으로 시도하세요.") from None


class Handler(BaseHTTPRequestHandler):
    server_version = "CUE"
    sys_version = ""

    def content_length(self, maximum):
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not lengths[0].isdigit():
            raise RequestError(411, "파일 또는 요청 크기를 확인하지 못했어요. 다시 시도하세요.")
        size = int(lengths[0])
        if not 0 < size <= maximum:
            raise RequestError(413, "요청이 너무 커요. 전체 영상 크기를 150MB 이하로 줄여주세요.")
        return size

    def read_exact(self, size, deadline, output=None):
        parts = []
        while size:
            self.connection.settimeout(min(20, remaining(deadline)))
            chunk = self.rfile.read1(min(size, 1024 * 1024))
            if not chunk:
                raise RequestError(400, "업로드가 중단됐어요. 파일을 다시 선택하세요.")
            if output is not None:
                output.write(chunk)
            else:
                parts.append(chunk)
            size -= len(chunk)
        return b"".join(parts)

    def send_video(self, output, filename, deadline):
        self.connection.settimeout(min(20, remaining(deadline)))
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(output.stat().st_size))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.response_started = True
        with output.open("rb") as rendered:
            while chunk := rendered.read(1024 * 1024):
                remaining(deadline)
                self.wfile.write(chunk)

    def read_json(self, size, deadline):
        try:
            return json.loads(self.read_exact(size, deadline).decode("utf-8"))
        except (ValueError, UnicodeError, RecursionError):
            raise RequestError(400, "배치 정보를 읽지 못했어요. 다시 배치하세요.") from None

    def music_analysis(self, track, directory, deadline, automatic):
        known = self.server.analysis_cache.get(track["id"])
        if known and (not automatic or "bpm" in known):
            return known
        music = directory / "music.mp3"
        fetch_music(track, music, deadline)
        record = {"duration": probe(music, "a", deadline)}
        if automatic:
            pcm = directory / "analysis.f32"
            media.run([
                "ffmpeg", "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe",
                "-format_whitelist", MEDIA_FORMATS, "-i", str(music), "-map", "0:a:0", "-vn",
                "-ac", "1", "-ar", "22050", "-f", "f32le", str(pcm),
            ], directory=directory, capture_output=True, check=True, timeout=remaining(deadline))
            result = subprocess.run([
                "/usr/bin/node", str(Path(__file__).parent / "ops/analyze_music.mjs"), str(pcm),
            ], capture_output=True, text=True, check=True, timeout=remaining(deadline))
            analysis = json.loads(result.stdout)
            bpm, offset = analysis.get("bpm"), analysis.get("offset", 0)
            if bpm is not None:
                montage.number(bpm, 30, 300)
            montage.number(offset)
            record.update(bpm=bpm, offset=offset)
        self.server.analysis_cache[track["id"]] = record
        return record

    def handle_montage(self, route):
        maximum = MAX_JSON_BYTES if route == "/api/ncs/plan" else MAX_VIDEO_BYTES + MAX_JSON_BYTES + 4
        size = self.content_length(maximum)
        # A just-delivered response can still be closing its temporary files.
        if not self.server.render_slot.acquire(timeout=.1):
            raise RequestError(429, "다른 쇼츠를 만드는 중이에요. 잠시 후 다시 시도하세요.")
        owns_slot = True
        try:
            deadline = time.monotonic() + RENDER_TIMEOUT
            with tempfile.TemporaryDirectory(prefix="cue-montage-") as temporary:
                directory = Path(temporary)
                if route == "/api/ncs/plan":
                    request = montage.validate_plan(self.read_json(size, deadline))
                    track = TRACKS.get(request["track"])
                    if track is None:
                        raise RequestError(400, "목록에서 NCS 음악을 골라주세요.")
                    analysis = self.music_analysis(track, directory, deadline, request["mode"] != "continuity" and request["bpm"] is None)
                    plan = montage.plan_segments(request, analysis)
                    self.server.render_slot.release()
                    owns_slot = False
                    self.send_json(200, plan)
                    return
                if size < 4:
                    raise RequestError(400, "영상 업로드 형식이 올바르지 않아요.")
                json_length = int.from_bytes(self.read_exact(4, deadline), "big")
                if not 0 < json_length <= MAX_JSON_BYTES or json_length + 4 >= size:
                    raise RequestError(400, "영상 배치 정보가 올바르지 않아요.")
                manifest = montage.validate_manifest(self.read_json(json_length, deadline))
                track = TRACKS.get(manifest["track"])
                if track is None:
                    raise RequestError(400, "목록에서 NCS 음악을 골라주세요.")
                if sum(manifest["files"]) > MAX_VIDEO_BYTES or sum(manifest["files"]) + json_length + 4 != size:
                    raise RequestError(400, "배치 정보와 실제 업로드 크기가 달라요. 파일을 다시 선택하세요.")
                paths = []
                for i, file_size in enumerate(manifest["files"]):
                    path = directory / f"input-{i}"
                    with path.open("wb") as upload:
                        self.read_exact(file_size, deadline, upload)
                    paths.append(path)
                music = directory / "music.mp3"
                fetch_music(track, music, deadline)
                output = montage.render_segments(directory, paths, music, manifest, deadline, probe, remaining, MEDIA_FORMATS)
                self.send_video(output, f'CUE-{track["id"]}-montage.mp4', deadline)
        except ValueError as error:
            raise RequestError(400, str(error) if not isinstance(error, json.JSONDecodeError) else "배치 정보를 읽지 못했어요. 다시 배치하세요.") from None
        except montage.RenderError as error:
            raise RequestError(422, str(error)) from None
        except subprocess.CalledProcessError:
            raise RequestError(422, "분석 또는 영상 변환을 완료하지 못했어요. 더 짧은 구간이나 다른 파일로 시도하세요.") from None
        finally:
            if owns_slot:
                self.server.render_slot.release()

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def check_origin(self):
        origin = self.headers.get("Origin")
        if origin is None:
            return
        try:
            parsed = urlsplit(origin)
        except ValueError:
            raise RequestError(403, "현재 사이트에서 다시 시도하세요.") from None
        host = self.headers.get("Host", "").lower()
        if parsed.scheme not in ("http", "https") or origin.lower() != f"{parsed.scheme}://{host}":
            raise RequestError(403, "현재 사이트에서 다시 시도하세요.")

    def do_GET(self):
        try:
            self.check_origin()
            if urlsplit(self.path).path != "/api/ncs/catalog":
                raise RequestError(404, "요청한 기능을 찾지 못했어요.")
            tracks = []
            for track in TRACKS.values():
                public = {key: track[key] for key in ("id", "title", "artist", "page")}
                public["genre"] = track.get("genre", "")
                public["credit"] = f"{track['artist']} - {track['title']} [NCS Release]\nMusic provided by NoCopyrightSounds.\nFree Download / Stream: {track['page']}"
                tracks.append(public)
            self.send_json(200, {"tracks": tracks})
        except RequestError as error:
            self.send_json(error.status, {"error": str(error)})

    def do_POST(self):
        self.close_connection = True
        acquired = False
        self.response_started = False
        try:
            self.check_origin()
            parsed = urlsplit(self.path)
            if parsed.path in ("/api/ncs/plan", "/api/ncs/montage"):
                self.handle_montage(parsed.path)
                return
            if parsed.path != "/api/ncs/render":
                raise RequestError(404, "요청한 기능을 찾지 못했어요.")
            query = parse_qs(parsed.query, keep_blank_values=True)
            if any(len(values) != 1 for values in query.values()):
                raise RequestError(400, "음악과 시작 시간, 길이를 다시 확인하세요.")
            track = TRACKS.get(query.get("track", [""])[0])
            if track is None:
                raise RequestError(400, "목록에 있는 NCS 곡을 골라주세요.")
            try:
                music_start = float(query.get("musicStart", ["0"])[0])
                video_start = float(query.get("videoStart", ["0"])[0])
                length = float(query.get("length", ["15"])[0])
            except ValueError:
                raise RequestError(400, "시작 시간과 길이를 숫자로 입력하세요.") from None
            if not all(math.isfinite(value) for value in (music_start, video_start, length)) or min(music_start, video_start) < 0 or not .1 <= length <= 60:
                raise RequestError(400, "시작 시간은 0 이상, 길이는 0.1~60초로 지정하세요.")
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not lengths[0].isdigit():
                raise RequestError(411, "영상 파일 크기를 확인하지 못했어요. 파일을 다시 선택하세요.")
            size = int(lengths[0])
            if size <= 0 or size > MAX_VIDEO_BYTES:
                raise RequestError(413, "0바이트보다 크고 150MB 이하인 영상 파일을 골라주세요.")
            acquired = self.server.render_slot.acquire(timeout=.1)
            if not acquired:
                raise RequestError(429, "다른 쇼츠를 만드는 중이에요. 잠시 후 다시 시도하세요.")
            deadline = time.monotonic() + RENDER_TIMEOUT
            with tempfile.TemporaryDirectory(prefix="cue-ncs-") as directory:
                directory = Path(directory)
                game, music, output = directory / "game", directory / "music.mp3", directory / "shorts.mp4"
                with game.open("wb") as upload:
                    left = size
                    while left:
                        self.connection.settimeout(min(20, remaining(deadline)))
                        chunk = self.rfile.read1(min(left, 1024 * 1024))
                        if not chunk:
                            raise RequestError(400, "영상 업로드가 중단됐어요. 다시 시도하세요.")
                        upload.write(chunk)
                        left -= len(chunk)
                video_duration = probe(game, "v", deadline)
                if video_start >= video_duration:
                    raise RequestError(400, "영상 시작 시간을 영상 길이 안으로 지정하세요.")
                fetch_music(track, music, deadline)
                music_duration = probe(music, "a", deadline)
                if music_start >= music_duration:
                    raise RequestError(400, "음악 시작 시간을 곡 길이 안으로 지정하세요.")
                duration = min(length, video_duration - video_start, music_duration - music_start)
                try:
                    media.run([
                        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-filter_threads", "2",
                        "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS,
                        "-threads", "2", "-ss", str(video_start), "-i", str(game),
                        "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS,
                        "-ss", str(music_start), "-i", str(music),
                        "-map", "0:v:0", "-map", "1:a:0", "-t", str(duration), "-shortest",
                        "-vf", "scale=w='max(2,trunc(min(720,1280*dar)/2)*2)':h='max(2,trunc(min(1280,720/dar)/2)*2)',setsar=1,pad=720:1280:(ow-iw)/2:(oh-ih)/2",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-threads", "2", "-r", "30", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", str(output),
                    ], directory=directory, capture_output=True, check=True, timeout=remaining(deadline))
                except subprocess.CalledProcessError:
                    raise RequestError(422, "쇼츠를 만들지 못했어요. 다른 영상이나 더 짧은 구간으로 시도하세요.") from None
                self.send_video(output, f'CUE-{track["id"]}-shorts.mp4', deadline)
        except RequestError as error:
            self.send_json(error.status, {"error": str(error)})
        except (subprocess.TimeoutExpired, TimeoutError, socket.timeout):
            if not self.response_started:
                self.send_json(504, {"error": "처리 시간이 초과됐어요. 더 짧거나 작은 영상으로 다시 시도하세요."})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except URLError:
            self.send_json(502, {"error": "NCS 음악을 가져오지 못했어요. 잠시 후 다른 곡으로 다시 시도하세요."})
        except (OSError, ValueError):
            if not self.response_started:
                self.send_json(500, {"error": "영상을 처리하지 못했어요. 파일을 확인하고 다시 시도하세요."})
        finally:
            if acquired:
                self.server.render_slot.release()


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self.connection_slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self.connection_timeout = CONNECTION_TIMEOUT
        super().__init__(*args, **kwargs)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(self.connection_timeout)
        return connection, address

    def process_request(self, request, client_address):
        if not self.connection_slots.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.connection_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connection_slots.release()


def make_server(host="127.0.0.1", port=5174):
    server = BoundedHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.render_slot = threading.BoundedSemaphore(1)
    server.analysis_cache = {}
    return server


if __name__ == "__main__":
    with make_server() as server:
        server.serve_forever()
