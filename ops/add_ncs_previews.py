"""Add official Watch video IDs to the existing private catalog; no media download."""
from concurrent.futures import ThreadPoolExecutor
import json
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener

from build_ncs_catalog import ROOT, TrackPage, CatalogRedirectHandler, HEADERS, preview_video_id


def preview(row):
    page = urlsplit(row["page"])
    if page.scheme != "https" or page.netloc != "ncs.io" or page.query or page.fragment:
        raise ValueError("Preview metadata requires an official NCS page")
    try:
        time.sleep(.2)
        with build_opener(CatalogRedirectHandler()).open(Request(row["page"], headers=HEADERS), timeout=20) as response:
            final = urlsplit(response.url)
            if final.path.rstrip('/').casefold() != page.path.rstrip('/').casefold():
                raise ValueError("Track page redirected to another track")
            source = response.read(2*1024*1024+1)
        if len(source) > 2*1024*1024:
            raise ValueError("Track page exceeds metadata limit")
        parser = TrackPage(); parser.feed(source.decode('utf-8'))
        if len(parser.canonical) != 1 or urlsplit(parser.canonical[0]).path.rstrip('/').casefold() != page.path.rstrip('/').casefold():
            raise ValueError("Canonical track does not match")
        video = preview_video_id(source.decode('utf-8'), parser)
        if not video:
            return {key: value for key, value in row.items() if key != 'youtubeId'}
        return {**row, 'youtubeId': video}
    except (OSError, ValueError):
        return {key: value for key, value in row.items() if key != 'youtubeId'}


if __name__ == '__main__':
    path = ROOT/'ncs-catalog.json'
    rows = json.loads(path.read_text())
    with ThreadPoolExecutor(max_workers=4) as pool:
        enriched = list(pool.map(preview, rows))
    candidate = path.with_suffix('.json.next')
    candidate.write_text(json.dumps(enriched, ensure_ascii=False, indent=2)+'\n')
    candidate.replace(path)
    print(f"Official preview IDs: {sum('youtubeId' in row for row in enriched)}/{len(enriched)}; no media downloaded")
