import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import media


class MediaRunnerTests(unittest.TestCase):
    def test_sandbox_requires_pinned_runtime_and_never_falls_back(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict(os.environ, {'CUE_BWRAP':'/missing/bwrap'}, clear=True):
                with self.assertRaises(ValueError):
                    media.run(['ffprobe','-version'], directory=folder)
            with patch.dict(os.environ, {'CUE_MEDIA_BIN':folder}, clear=True):
                with self.assertRaises(ValueError):
                    media.run(['ffprobe','-version'], directory=folder)

    def test_only_media_programs_are_allowed(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                media.run(['sh','-c','true'], directory=folder)

    @unittest.skipUnless(os.environ.get('CUE_BWRAP') and os.environ.get('CUE_MEDIA_BIN'), 'Set CUE_BWRAP and CUE_MEDIA_BIN for real isolation tests')
    def test_real_namespace_blocks_host_files_network_and_environment(self):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as outside:
            sentinel=Path(outside)/'synthetic-secret';sentinel.write_text('synthetic secret, not credentials')
            with socket.socket() as listener:
                listener.bind(('127.0.0.1',0));listener.listen(1)
                port=listener.getsockname()[1]
                code=("import json,os,pathlib,socket; s=socket.socket(); s.settimeout(.2); "
                      f"print(json.dumps({{'hostFileVisible':pathlib.Path({str(sentinel)!r}).exists(),"
                      f"'hostParentVisible':pathlib.Path('/proc/{os.getpid()}').exists(),"
                      f"'networkResult':s.connect_ex(('127.0.0.1',{port})),"
                      "'secretVisible':'CUE_FAKE_SECRET' in os.environ,'usrLocalVisible':pathlib.Path('/usr/local').exists(),"
                      "'writeableJob':os.access('/work',os.W_OK)}))")
                args=media.sandbox_command('/usr/bin/python3',['-c',code],Path(folder),
                     Path(os.environ['CUE_MEDIA_BIN']).resolve(),os.environ['CUE_BWRAP'])
                with patch.dict(os.environ, {'CUE_FAKE_SECRET':'synthetic-value'}):
                    result=subprocess.run(args,capture_output=True,text=True,check=True,timeout=10)
                report=json.loads(result.stdout)
                self.assertFalse(report['hostFileVisible'],report)
                self.assertFalse(report['hostParentVisible'],report)
                self.assertFalse(report['secretVisible'],report)
                self.assertFalse(report['usrLocalVisible'],report)
                self.assertTrue(report['writeableJob'],report)
                self.assertNotEqual(report['networkResult'],0,report)

    @unittest.skipUnless(os.environ.get('CUE_BWRAP') and os.environ.get('CUE_MEDIA_BIN'), 'Set sandbox environment for real rendering')
    def test_real_render_and_probe_work_only_inside_job(self):
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'video.mp4'
            media.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=30',
                       '-t','0.3','-c:v','libx264','-threads','1',str(output)],
                      directory=folder,capture_output=True,check=True,timeout=20)
            result=media.run(['ffprobe','-v','error','-show_entries','stream=nb_frames','-of','json',str(output)],
                            directory=folder,capture_output=True,text=True,check=True,timeout=10)
            self.assertEqual(json.loads(result.stdout)['streams'][0]['nb_frames'],'9')
            with self.assertRaises(ValueError):
                media.run(['ffprobe','-i',str(Path(folder).parent/'outside.mp4')],directory=folder)
            result=media.run(['ffprobe','-v','error','-i','file:/etc/passwd'],directory=folder,capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('No such file',result.stderr)

    @unittest.skipUnless(os.environ.get('CUE_BWRAP') and os.environ.get('CUE_MEDIA_BIN'), 'Set sandbox environment for real timeout test')
    def test_timeout_terminates_isolated_media_process(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(subprocess.TimeoutExpired):
                media.run(['ffmpeg','-v','error','-re','-f','lavfi','-i','color=size=16x16:rate=30','-f','null','-'],
                          directory=folder,capture_output=True,timeout=.3)


if __name__=='__main__':unittest.main()
