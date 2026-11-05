import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('preview_catalog',ROOT/'ops/build_ncs_catalog.py')
catalog=importlib.util.module_from_spec(spec);spec.loader.exec_module(catalog)

class PreviewMetadataTests(unittest.TestCase):
    def test_only_unique_official_watch_metadata_is_accepted(self):
        parser=catalog.TrackPage();parser.feed('<p>Watch: https://youtu.be/AbCdEf012_-</p>')
        with patch.object(catalog,'build_opener') as opener:
            self.assertEqual(catalog.preview_video_id('',parser),'AbCdEf012_-')
            opener.assert_not_called()
        parser.feed('<p>Watch: https://youtu.be/Other1234_-</p>')
        self.assertIsNone(catalog.preview_video_id('',parser))
        for text in ['Watch: https://attacker.invalid/AbCdEf012_-', 'Watch: https://youtu.be/AbCdEf012_-extra']:
            parser=catalog.TrackPage();parser.feed(text);self.assertFalse(parser.youtube_ids)

    def test_shortlink_reads_only_fixed_official_host_and_extracts_unique_id(self):
        with patch.object(catalog,'build_opener') as opener:
            response=opener.return_value.open.return_value.__enter__.return_value
            response.read.return_value=b'<a href="https://www.youtube.com/watch?v=AbCdEf012_-&src=Linkfire">YouTube</a>'
            self.assertEqual(catalog.preview_video_id('Watch: http://ncs.lnk.to/TrackAT/youtube',catalog.TrackPage()),'AbCdEf012_-')
            request=opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url,'https://ncs.lnk.to/TrackAT/youtube')
            self.assertEqual(opener.return_value.open.call_count,1)
            response.read.return_value=b'https://www.youtube.com/watch?v=AbCdEf012_- https://www.youtube.com/watch?v=Other1234_-'
            self.assertIsNone(catalog.preview_video_id('https://ncs.lnk.to/TrackAT/youtube',catalog.TrackPage()))

    def test_redirects_are_not_followed_and_unknown_targets_do_not_embed(self):
        self.assertIsNone(catalog.PreviewNoRedirect().redirect_request(None,None,302,'Found',{},'https://attacker.invalid'))
        with patch.object(catalog,'build_opener') as opener:
            for location in ['https://attacker.invalid/private','file:///etc/passwd']:
                opener.return_value.open.side_effect=HTTPError('https://ncs.lnk.to/TrackAT/youtube',302,'Found',{'Location':location},None)
                self.assertIsNone(catalog.preview_video_id('https://ncs.lnk.to/TrackAT/youtube',catalog.TrackPage()))

if __name__=='__main__':unittest.main()
