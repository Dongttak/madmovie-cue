import http.client
import importlib.util
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cue_montage_server', ROOT / 'server.py')
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)
if not server_module.TRACKS:
    server_module.TRACKS = server_module.load_tracks(ROOT / 'tests/fixtures/ncs-catalog.json')


class MontageServerTests(unittest.TestCase):
    def test_selective_accent_validation_clock_waveform_and_real_render(self):
        montage = server_module.montage
        request = {'track':'invincible','musicStart':0,'length':60,'mode':'continuity','fps':60,
                   'layout':'wide','gameAudio':True,'clips':[{'duration':3,'start':0,'end':3,
                   'accent':{'time':1.5,'kind':'slow'}}]}
        with patch.object(server_module,'fetch_music',side_effect=self.music_fixture):
            status,_,body=self.request('/api/ncs/plan',json.dumps(request).encode())
            self.assertEqual(status,200,body)
            plan=json.loads(body)
            self.assertEqual(plan['duration'],3.3)
            self.assertEqual(plan['segments'][0]['sourceDuration'],3)
            self.assertEqual(len(plan['waveform']['peaks']),1200)
            self.assertTrue(all(0 <= peak <= 1 for peak in plan['waveform']['peaks']))
            source=Path(self.files.name)/'accent-source.mp4'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=60',
                            '-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','3',
                            '-c:v','libx264','-threads','1','-preset','ultrafast','-c:a','aac','-y',str(source)],check=True)
            raw=source.read_bytes()
            manifest={**request,'files':[{'size':len(raw)}],'segments':plan['segments']}
            for kind,frames in [('slow',198),('focus',180)]:
                segment=manifest['segments'][0]
                segment['accent']['kind']=kind;segment['duration']=frames/60
                status,_,body=self.request('/api/ncs/montage',self.envelope(manifest,[raw]),'application/octet-stream')
                self.assertEqual(status,200,body[:500])
                output=Path(self.files.name)/f'accent-{kind}.mp4';output.write_bytes(body)
                probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(output)]))
                video=next(stream for stream in probe['streams'] if stream['codec_type']=='video')
                audio=next(stream for stream in probe['streams'] if stream['codec_type']=='audio')
                self.assertEqual(int(video['nb_frames']),frames)
                self.assertAlmostEqual(float(audio['duration']),frames/60,delta=.03)
                subprocess.run(['ffmpeg','-v','error','-i',str(output),'-f','null','-'],check=True)
        for time in [-1,.1,2.9,float('nan')]:
            with self.subTest(time=time),self.assertRaises(ValueError):
                montage.validate_plan({**request,'clips':[{'duration':3,'accent':{'time':time,'kind':'slow'}}]})
        bad={**manifest,'segments':[{**manifest['segments'][0],'duration':3.2}]}
        with self.assertRaises(ValueError):montage.validate_manifest(bad)
        for i in range(100):
            t=3*i/100
            out=montage.source_clock(t,1.5,True)
            self.assertAlmostEqual(montage.inverse_clock(out,1.5,True,3),t,places=7)

    @classmethod
    def setUpClass(cls):
        cls.files = tempfile.TemporaryDirectory(prefix='cue-montage-test-')
        cls.directory = Path(cls.files.name)
        cls.videos = []
        for color in ('red', 'green', 'blue'):
            video = cls.directory / f'{color}.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'color=c={color}:size=320x180:rate=24', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-y', str(video)], check=True)
            cls.videos.append(video.read_bytes())
        cls.music = cls.directory / 'original-120bpm.wav'
        rate = 16000
        with wave.open(str(cls.music), 'wb') as output:
            output.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
            frames = bytearray()
            for index in range(rate * 12):
                time = index / rate
                since_beat = (time - .25) % .5
                amplitude = .8 * math.sin(2 * math.pi * 95 * since_beat) * math.exp(-since_beat / .035) if time >= .25 else 0
                frames.extend(struct.pack('<h', round(amplitude * 32767)))
            output.writeframes(frames)
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

    def request(self, path, body, content_type='application/json'):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        try:
            connection.request('POST', path, body, {'Content-Type': content_type})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def music_fixture(self, track, output_path, deadline):
        shutil.copyfile(self.music, output_path)

    def manifest(self):
        return {
            'track': 'invincible', 'musicStart': 0,
            'files': [{'size': len(self.videos[index])} for index in (2, 0, 1)],
            'segments': [{'fileIndex': index, 'sourceStart': .5, 'duration': 1, 'timelineStart': timeline} for timeline, index in enumerate((0, 1, 2))],
        }

    def envelope(self, manifest, videos=None):
        encoded = json.dumps(manifest).encode()
        return struct.pack('>I', len(encoded)) + encoded + b''.join([self.videos[index] for index in (2, 0, 1)] if videos is None else videos)

    def test_automatic_tempo_is_cached_and_silent_music_reports_uniform_fallback(self):
        payload = {'track': 'blank', 'musicStart': 0, 'length': 6, 'clips': [{'duration': 3, 'start': 0}] * 3}
        with patch.object(server_module, 'fetch_music', side_effect=self.music_fixture) as fetch:
            for _ in range(2):
                status, _, body = self.request('/api/ncs/plan', json.dumps(payload).encode())
                self.assertEqual(status, 200, body[:500])
                plan = json.loads(body)
                self.assertEqual(plan['mode'], 'beats')
                self.assertLess(abs(plan['bpm'] - 120), 1)
            self.assertEqual(fetch.call_count, 1)
        silence = self.directory / 'original-silence.wav'
        with wave.open(str(silence), 'wb') as output:
            output.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            output.writeframes(bytes(16000 * 12 * 2))

        def silent_music(track, output_path, deadline):
            shutil.copyfile(silence, output_path)

        with patch.object(server_module, 'fetch_music', side_effect=silent_music):
            status, _, body = self.request('/api/ncs/plan', json.dumps({**payload, 'track': 'symbolism'}).encode())
        self.assertEqual(status, 200, body[:500])
        plan = json.loads(body)
        self.assertEqual(plan['mode'], 'uniform')
        self.assertIsNone(plan['bpm'])
        self.assertTrue(plan['warning'])
        self.assertEqual([segment['duration'] for segment in plan['segments']], [2, 2, 2])

    def test_manual_tempo_places_internal_cuts_on_beats_and_respects_clip_capacity(self):
        payload = {'track': 'invincible', 'musicStart': 0, 'length': 6, 'clips': [{'duration': 3, 'start': .25}] * 3, 'bpm': 120, 'offset': .25}
        with patch.object(server_module, 'fetch_music', side_effect=self.music_fixture):
            status, _, body = self.request('/api/ncs/plan', json.dumps(payload).encode())
        self.assertEqual(status, 200, body[:500])
        plan = json.loads(body)
        self.assertEqual(plan['mode'], 'beats')
        self.assertAlmostEqual(plan['bpm'], 120, places=1)
        self.assertAlmostEqual(plan['duration'], 6, places=2)
        segments = plan['segments']
        self.assertEqual([segment['fileIndex'] for segment in segments], [0, 1, 2])
        cursor = 0
        for segment in segments:
            self.assertAlmostEqual(segment['timelineStart'], cursor, places=3)
            self.assertGreater(segment['duration'], 0)
            self.assertGreaterEqual(segment['sourceStart'], .25)
            self.assertLessEqual(segment['sourceStart'] + segment['duration'], 3.001)
            if cursor:
                self.assertLessEqual(abs((cursor - .25) / .5 - round((cursor - .25) / .5)) * .5, 1 / 30 + .001)
            cursor += segment['duration']
        self.assertAlmostEqual(cursor, 6, places=3)
        with patch.object(server_module, 'fetch_music', side_effect=self.music_fixture):
            status, _, body = self.request('/api/ncs/plan', json.dumps({**payload, 'offset': 20.2}).encode())
        self.assertEqual(status, 200, body[:500])
        late_first_beat = json.loads(body)
        self.assertTrue(late_first_beat['warning'])
        self.assertEqual([segment['timelineStart'] for segment in late_first_beat['segments']], [0, 2, 4])

    def test_plan_rejects_invalid_inputs_and_arbitrary_music_sources(self):
        valid = {'track': 'invincible', 'musicStart': 0, 'length': 4, 'clips': [{'duration': 3, 'start': 0}] * 2}
        invalid = [
            {**valid, 'track': 'https://attacker.invalid/music.mp3'},
            {**valid, 'clips': []}, {**valid, 'clips': valid['clips'][:1]},
            {**valid, 'clips': valid['clips'] * 5},
            {**valid, 'musicStart': -1}, {**valid, 'length': 0},
            {**valid, 'bpm': 301}, {**valid, 'bpm': float('nan')},
            {**valid, 'clips': [{'duration': 3, 'start': -1}] * 2},
        ]
        with patch.object(server_module, 'fetch_music') as fetch:
            for payload in invalid:
                with self.subTest(payload=payload):
                    status, _, _ = self.request('/api/ncs/plan', json.dumps(payload).encode())
                    self.assertEqual(status, 400)
            self.assertIn(self.request('/api/ncs/plan', b'x' * (32 * 1024 + 1))[0], (400, 413))
            fetch.assert_not_called()

    def test_continuity_keeps_one_or_more_complete_ranges_without_truncation(self):
        valid = {'track':'invincible','mode':'continuity','fps':60,'layout':'wide','gameAudio':True,
                 'musicStart':0,'length':60,'clips':[{'duration':3,'start':.25,'end':2.75}]}
        with patch.object(server_module,'fetch_music',side_effect=self.music_fixture):
            status,_,body = self.request('/api/ncs/plan',json.dumps(valid).encode())
            self.assertEqual(status,200,body)
            plan=json.loads(body)
            self.assertEqual((plan['mode'],plan['fps'],plan['layout'],plan['gameAudio']),('continuity',60,'wide',True))
            self.assertEqual(plan['segments'],[{'fileIndex':0,'sourceStart':.25,'duration':2.5,'timelineStart':0}])
            self.assertIsNone(plan['bpm'])
            status,_,body=self.request('/api/ncs/plan',json.dumps({**valid,'clips':valid['clips']*2}).encode())
            self.assertEqual(status,200,body)
            self.assertEqual([s['duration'] for s in json.loads(body)['segments']],[2.5,2.5])
            for change in [{'musicStart':11},{'clips':[{'duration':70,'start':0,'end':61}]},
                           {'clips':[{'duration':3,'start':0,'end':4}]},{'layout':'bogus'},
                           {'fps':True},{'gameAudio':'true'},{'mode':'bogus'}]:
                with self.subTest(change=change):
                    status,_,body=self.request('/api/ncs/plan',json.dumps({**valid,**change}).encode())
                    self.assertEqual(status,400,body)

    def test_continuity_render_preserves_motion_and_mixes_game_audio_or_silence(self):
        path=Path(self.files.name)/'game-tone.mp4'
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=60',
                        '-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','3',
                        '-c:v','libx264','-threads','2','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-y',str(path)],check=True)
        tone=path.read_bytes()
        def make(raw,game=True,layout='wide',length=2):
            manifest={'track':'invincible','musicStart':0,'mode':'continuity','fps':60,'layout':layout,'gameAudio':game,
                      'files':[{'size':len(raw)}],'segments':[{'fileIndex':0,'sourceStart':.5,'duration':length,'timelineStart':0}]}
            status,_,body=self.request('/api/ncs/montage',self.envelope(manifest,[raw]),'application/octet-stream')
            self.assertEqual(status,200,body[:500]);return body
        with patch.object(server_module,'fetch_music',side_effect=self.music_fixture):
            mixed=make(tone)
            music_only=make(tone,False)
            silent=make(self.videos[0],True,'landscape',1)
        output=Path(self.files.name)/'continuity.mp4';output.write_bytes(mixed)
        meta=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries',
                                                'stream=width,height,nb_frames,r_frame_rate','-of','json',str(output)]))['streams'][0]
        self.assertEqual((meta['width'],meta['height'],meta['nb_frames'],meta['r_frame_rate']),(1280,600,'120','60/1'))
        comparison=subprocess.run(['ffmpeg','-v','info','-filter_complex_threads','1','-i',str(path),'-i',str(output),
                                  '-filter_complex','[0:v]trim=start=0.5:end=2.5,setpts=PTS-STARTPTS,scale=1280:720,crop=1280:600:0:60[ref];[ref][1:v]ssim',
                                  '-an','-f','null','-'],capture_output=True,text=True,check=True)
        import re
        self.assertGreater(float(re.findall(r'All:([0-9.]+)',comparison.stderr)[-1]),.95)
        amplitudes=[]
        for raw in [mixed,music_only]:
            output.write_bytes(raw)
            pcm=subprocess.check_output(['ffmpeg','-v','error','-ss','0.3','-i',str(output),'-t','0.6','-map','0:a:0','-ac','1','-ar','48000','-f','f32le','-'])
            samples=struct.unpack('<'+'f'*(len(pcm)//4),pcm)
            projection=2*abs(sum(value*complex(math.cos(2*math.pi*880*i/48000),math.sin(2*math.pi*880*i/48000)) for i,value in enumerate(samples)))/len(samples)
            self.assertLess(max(abs(v) for v in samples),1)
            amplitudes.append(projection)
        self.assertGreater(amplitudes[0],.025)
        self.assertGreater(amplitudes[0],amplitudes[1]*5)
        output.write_bytes(silent)
        meta=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height,nb_frames','-of','json',str(output)]))['streams'][0]
        self.assertEqual((meta['width'],meta['height'],meta['nb_frames']),(1280,720,'60'))

    def test_render_rejects_bad_manifests_truncated_files_and_source_overruns(self):
        valid = self.manifest()
        invalid = [
            b'\x00\x00',
            struct.pack('>I', 32 * 1024 + 1) + b'{}',
            self.envelope({**valid, 'track': 'https://attacker.invalid/music.mp3'}),
            self.envelope({**valid, 'files': valid['files'][:1]}),
            self.envelope({**valid, 'segments': [valid['segments'][0]] * 3}),
            self.envelope(valid)[:-100],
        ]
        with patch.object(server_module, 'fetch_music') as fetch:
            for payload in invalid:
                with self.subTest(length=len(payload)):
                    status, _, _ = self.request('/api/ncs/montage', payload, 'application/octet-stream')
                    self.assertIn(status, (400, 413, 422))
            fetch.assert_not_called()
        overrun = self.manifest()
        overrun['segments'][0]['sourceStart'] = 2.9
        with patch.object(server_module, 'fetch_music', side_effect=self.music_fixture):
            status, _, _ = self.request('/api/ncs/montage', self.envelope(overrun), 'application/octet-stream')
        self.assertIn(status, (400, 422))

    def test_playlist_upload_cannot_make_the_media_probe_request_an_external_url(self):
        playlist = f'#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nhttp://127.0.0.1:{self.port}/ssrf-target.ts\n#EXT-X-ENDLIST\n'.encode()
        manifest = {
            'track': 'invincible', 'musicStart': 0,
            'files': [{'size': len(playlist)}, {'size': len(self.videos[0])}],
            'segments': [{'fileIndex': index, 'sourceStart': 0, 'duration': 1, 'timelineStart': index} for index in (0, 1)],
        }
        requests = []
        original_get = server_module.Handler.do_GET

        def observe_get(handler):
            requests.append(handler.path)
            return original_get(handler)

        with patch.object(server_module.Handler, 'do_GET', observe_get), patch.object(server_module, 'fetch_music', side_effect=self.music_fixture) as fetch:
            status, _, _ = self.request('/api/ncs/montage', self.envelope(manifest, [playlist, self.videos[0]]), 'application/octet-stream')
        self.assertIn(status, (400, 422))
        self.assertEqual(requests, [])
        for call in fetch.call_args_list:
            self.assertEqual(call.args[0]['id'], 'invincible')

    def test_render_preserves_requested_clip_order_and_combines_audible_music(self):
        with patch.object(server_module, 'fetch_music', side_effect=self.music_fixture):
            status, headers, body = self.request('/api/ncs/montage', self.envelope(self.manifest()), 'application/octet-stream')
        self.assertEqual(status, 200, body[:500])
        self.assertEqual(headers.get('Content-Type'), 'video/mp4')
        output = self.directory / 'montage.mp4'
        output.write_bytes(body)
        metadata = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', str(output)]))
        self.assertEqual({stream['codec_name'] for stream in metadata['streams']}, {'h264', 'aac'})
        self.assertEqual(len(metadata['streams']), 2)
        video = next(stream for stream in metadata['streams'] if stream['codec_type'] == 'video')
        self.assertEqual((video['width'], video['height']), (720, 1280))
        self.assertLess(abs(float(metadata['format']['duration']) - 3), .2)
        for time, dominant in ((.5, 2), (1.5, 0), (2.5, 1)):
            pixel = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(time), '-i', str(output), '-frames:v', '1', '-vf', 'crop=100:100:(iw-100)/2:(ih-100)/2,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
            self.assertEqual(len(pixel), 3)
            self.assertGreater(pixel[dominant], 80)
            self.assertTrue(all(pixel[dominant] > pixel[index] + 50 for index in range(3) if index != dominant), (time, list(pixel)))
        boundary_pixels = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(output), '-vf', "select='eq(n,29)+eq(n,30)+eq(n,59)+eq(n,60)',crop=100:100:(iw-100)/2:(ih-100)/2,scale=1:1", '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
        self.assertEqual(len(boundary_pixels), 12)
        for index, dominant in enumerate((2, 0, 0, 1)):
            pixel = boundary_pixels[index * 3:index * 3 + 3]
            self.assertGreater(pixel[dominant], 80)
            self.assertTrue(all(pixel[dominant] > pixel[channel] + 50 for channel in range(3) if channel != dominant), list(pixel))
        pcm = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(output), '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '8000', 'pipe:1'])
        values = struct.unpack('<' + 'f' * (len(pcm) // 4), pcm)
        self.assertGreater(math.sqrt(sum(value * value for value in values) / len(values)), .001)


if __name__ == '__main__':
    unittest.main()
