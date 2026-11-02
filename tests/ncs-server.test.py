import http.client
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cue_ncs_server', ROOT / 'server.py')
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)
CATALOG = ROOT / 'ncs-catalog.json'
if not CATALOG.exists():
    CATALOG = ROOT / 'tests/fixtures/ncs-catalog.json'
    server_module.TRACKS = server_module.load_tracks(CATALOG)


class NcsServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = tempfile.TemporaryDirectory(prefix='cue-ncs-test-')
        cls.directory = Path(cls.files.name)
        cls.video = cls.directory / 'original-game.mp4'
        cls.music = cls.directory / 'original-tone.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-y', str(cls.video)], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '8', '-c:a', 'pcm_s16le', '-y', str(cls.music)], check=True)
        cls.server = server_module.make_server(host='127.0.0.1', port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.files.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_catalog_matches_verified_private_metadata_without_audio_download_routes(self):
        private = json.loads(CATALOG.read_text())
        self.assertGreater(len(private), 0)
        for field in ('id', 'page', 'url'):
            self.assertEqual(len({track[field] for track in private}), len(private))
        for track in private:
            self.assertTrue(track['title'])
            self.assertTrue(track['artist'])
            self.assertIsInstance(track['genre'], str)
            page = urlsplit(track['page'])
            audio = urlsplit(track['url'])
            self.assertEqual((page.scheme, page.netloc), ('https', 'ncs.io'))
            self.assertEqual((audio.scheme, audio.netloc), ('https', 'ncsmusic.s3.eu-west-1.amazonaws.com'))
            self.assertTrue(audio.path.startswith('/tracks/'))
            self.assertTrue(audio.path.endswith('.mp3'))
        status, headers, body = self.request('GET', '/api/ncs/catalog')
        self.assertEqual(status, 200)
        tracks = json.loads(body)['tracks']
        by_id = {track['id']: track for track in private}
        self.assertEqual(len(tracks), len(private))
        self.assertEqual({track['id'] for track in tracks}, set(by_id))
        for track in tracks:
            self.assertTrue(set(track) <= {'id', 'title', 'artist', 'page', 'genre', 'credit'})
            for field in ('title', 'artist', 'page', 'genre'):
                self.assertEqual(track[field], by_id[track['id']][field])
            for credit_text in (track['title'], track['artist'], track['page']):
                self.assertIn(credit_text, track['credit'])
            self.assertNotIn('url', track)
            self.assertNotIn('audioUrl', track)
        for path in ['/samples/cipher.mp3', '/api/ncs/audio?track=invincible', '/ncs-catalog.json']:
            self.assertEqual(self.request('GET', path)[0], 404)

    def test_catalog_loader_rejects_external_sources_duplicates_and_empty_lists(self):
        original = dict(next(iter(server_module.TRACKS.values())))
        path = self.directory / 'catalog-validation.json'
        path.write_text(json.dumps([original]))
        self.assertEqual(set(server_module.load_tracks(path)), {original['id']})
        invalid = [
            [],
            [{**original, 'url': 'https://attacker.invalid/music.mp3'}],
            [{**original, 'page': 'https://attacker.invalid/track'}],
            [original, original],
            [original, {**original, 'id': 'another-id'}],
        ]
        for rows in invalid:
            with self.subTest(rows=rows):
                path.write_text(json.dumps(rows))
                with self.assertRaises(ValueError):
                    server_module.load_tracks(path)

    def test_invalid_queries_origins_and_content_lengths_are_rejected_before_fetch(self):
        base = '/api/ncs/render?track=invincible&musicStart=0&length=2&videoStart=0'
        bad_queries = [base.replace('track=invincible', 'track=unknown'), base.replace('musicStart=0', 'musicStart=-1'), base.replace('musicStart=0', 'musicStart=nan'), base.replace('length=2', 'length=inf'), base.replace('length=2', 'length=0'), base.replace('length=2', 'length=61'), base.replace('videoStart=0', 'videoStart=-1')]
        with patch.object(server_module, 'fetch_music') as fetch:
            for path in bad_queries:
                with self.subTest(path=path):
                    self.assertEqual(self.request('POST', path, b'x')[0], 400)
            self.assertEqual(self.request('POST', base, b'x', {'Origin': 'https://attacker.invalid'})[0], 403)
            for value in [None, '-1', 'invalid', str(server_module.MAX_VIDEO_BYTES + 1)]:
                with self.subTest(content_length=value):
                    connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
                    try:
                        connection.putrequest('POST', base)
                        if value is not None:
                            connection.putheader('Content-Length', value)
                        connection.endheaders()
                        response = connection.getresponse()
                        self.assertIn(response.status, (400, 411, 413))
                        response.read()
                    finally:
                        connection.close()
            fetch.assert_not_called()

    def test_only_one_render_is_admitted_at_a_time(self):
        self.server.render_slot.acquire()
        try:
            with patch.object(server_module, 'fetch_music') as fetch:
                status = self.request('POST', '/api/ncs/render?track=invincible&musicStart=0&length=2&videoStart=0', b'x')[0]
                self.assertIn(status, (429, 503))
                fetch.assert_not_called()
        finally:
            self.server.render_slot.release()

    def test_render_returns_h264_aac_video_with_audible_music(self):
        def original_music(track, output_path, deadline):
            shutil.copyfile(self.music, output_path)

        with patch.object(server_module, 'fetch_music', side_effect=original_music):
            status, headers, body = self.request('POST', '/api/ncs/render?track=invincible&musicStart=1&length=2.25&videoStart=0.5', self.video.read_bytes(), {'Content-Type': 'video/mp4'})
        self.assertEqual(status, 200, body[:500])
        self.assertEqual(headers.get('Content-Type'), 'video/mp4')
        output = self.directory / 'combined.mp4'
        output.write_bytes(body)
        result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', str(output)], check=True, capture_output=True)
        metadata = json.loads(result.stdout)
        video = [stream for stream in metadata['streams'] if stream['codec_type'] == 'video']
        audio = [stream for stream in metadata['streams'] if stream['codec_type'] == 'audio']
        self.assertEqual(len(video), 1)
        self.assertEqual(len(audio), 1)
        self.assertEqual((video[0]['codec_name'], video[0]['width'], video[0]['height']), ('h264', 720, 1280))
        self.assertEqual(audio[0]['codec_name'], 'aac')
        self.assertLess(abs(float(metadata['format']['duration']) - 2.25), .4)
        pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1'], check=True, capture_output=True).stdout
        self.assertGreater(sum(abs(int.from_bytes(pcm[index:index + 2], 'little', signed=True)) for index in range(0, len(pcm), 2)) / (len(pcm) / 2), 10)


if __name__ == '__main__':
    unittest.main()
