#!/usr/bin/env python3
"""Verify a bounded NCS gaming selection using official pages and MP3 HEAD only."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
SOURCE_HOST = "ncsmusic.s3.eu-west-1.amazonaws.com"
HEADERS = {"User-Agent": "CUE-NCS-catalog-verification/1.0"}


class CatalogRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        target = urlsplit(newurl)
        if (target.scheme != "https" or target.netloc != urlsplit(request.full_url).netloc
                or target.netloc not in ("ncs.io", SOURCE_HOST) or target.query or target.fragment):
            raise ValueError("catalog redirect escaped the official source")
        return super().redirect_request(request, fp, code, message, headers, newurl)


DISCOVERY_SOURCES = [
    "https://ncs.lnk.to/gaming",
    *[f"https://ncs.io/music-search?genre={genre}" for genre in (3, 4, 5, 6, 47, 48)],
    "https://ncs.io/music-search?mood=6",
    "https://ncs.io/music-search?q=Heroes+Tonight",
    "https://ncs.io/music-search?q=Fearless",
    "https://ncs.io/music-search?q=Light+It+Up",
]
# Fixed candidates, not an unbounded crawl. Every entry is rechecked on each run.
CLASSIC_SEEDS = """
Invincible Blank Symbolism Royalty Mortals Cradles OnandOn Fearless FearlessptII
HeroesTonight ht HTD Fearless2 LightItUp FearlessFunk yv-fearless WhyWeLose LightUp Superhero AdventureTime Crest Unexpected MyHeart
SkyHigh Dreams DreamsptII Shine Energy Candyland Spectre Force Fade
Hope FeelGood FlyAway Nekozilla Hellcat Invisible Savannah Firefly
WhereWeStarted Fortress Origin Stronger RiseUp Ark Destiny LostControl
Lost LostWithin Infinite Limitless Skyline Cloud9 CloudNine Sunburst
Euphoria Eclipse MakeMeMove Circles Alive FeelAlive Together Unity Alone
Nova Jumbo TheGhost TheGuardian TheReturn TheFloorIsLava Flares
FightBack Careless BestOfMe Unstoppable NeverGiveUp Dreamer Reborn
FeelIt FeelSoGood Fear OneShot Infectious GetOverHere Villain Immortal
Disco InTheEnd SafeandSound Harpuia Getaway Freakshow Bounce LostInSound
Jnana Lullaby Ignite OverAgain Paralyzed Entropy Rage Low FindYou
FallToLight RedMoon Rebellion InvincibleVIP
""".split()
DISCOVERED_SEEDS = ['paranormal', 'NobodyAround', 'down2wait', 'S_setmefree', 'cerberus', 'AllInMyHead', 'walkonwater',
 'mortalsramesesbremix', 'RB_setmefree', 'N_Uncharted', 'RB_doitall', 'allweveeverknown',
 'AnotherLife', 'onlyhuman', 'Overheat', 'DoItAll', 'Whiplash', 'Dependant', 'C_euphoria',
 'TheSound', 'Comet', 'Kadak', 'Samurai', 'BOUNCE', 'Signs', 'DeadOfNightVIP', 'OnAndOnRMX',
 'EPromise', 'Stay', 'PixieDust', 'Mistakes', 'HalfAlive', 'Primitive', 'NoPressure', 'Waterfall',
 'OverMyHead', 'BeMyself', 'LWR', 'RWShadows', 'IWish', 'slipthru', 'highgrade', 'akina', 'Spicy',
 'Dunes', 'Mortals_TMBK', 'Duckstep', 'cheatcodes', 'YourPoison', 'TM_Desperate', 'Models', 'PUTB',
 'PushingOn', 'rk_closer', 'NB_Paradise', 'Bonfire', 'SWM', 'BlindHeart', 'OldSchool',
 'TBWhenImGone', 'Desperate', 'jbhain-feel', 'MomentsAcoustic', 'LIxRRMoments', 'TheGarden',
 'SLASH', 'ASongAboutYou', 'TakeMeAway', 'SETalkToMe', 'Choices', 'DisHonest', 'Donuts',
 'crashnburn', 'PaperCrownsRemix', 'WickedWays', 'Home', 'TGOA', 'Incomplete', 'TheReturn',
 'SayTheWord', 'S_Higher', 'Recall', 'Wanderlust', 'g_oneday', 'hittheground', 'canthealyou',
 'icanhearyou', 'fallingremix', 'ineedanangel', 'allbefore', 'gotmyheartonsale', 'g_desire',
 'z_feelit', 'o_halcyon', 'fightinme', 'backtoback', 'dontwannaknow', 'PJ_Halcyon', 'PJ_Dreaming',
 'Toujours', 'Defect', 'RR_Free', 's_waiting']


def clean(value):
    return " ".join(unescape(re.sub(r"<[^>]*>", "", value)).split())


class TrackPage(HTMLParser):
    def __init__(self):
        super().__init__()
        self.canonical = []
        self.players = []
        self.downloads = []
        self.title = ""
        self.in_title = False
        self.youtube_ids = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonical.append(attrs.get("href", ""))
        if attrs.get("id") == "player":
            self.players.append(attrs)
        if tag == "a" and attrs.get("href", "").startswith("/track/download/"):
            self.downloads.append(attrs)

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, text):
        if self.in_title:
            self.title += text
        self.youtube_ids.update(re.findall(
            r"Watch:\s*https?://(?:youtu\.be/|(?:www\.)?youtube\.com/watch\?v=)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])", text))


class PreviewNoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def preview_video_id(source, parser):
    if parser.youtube_ids:
        return next(iter(parser.youtube_ids)) if len(parser.youtube_ids) == 1 else None
    # Newer official credits use Linkfire. Read that fixed host's HTML only.
    links = set(re.findall(r"https?://ncs\.lnk\.to/([A-Za-z0-9_-]+)/youtube", source))
    if len(links) != 1:
        return None
    try:
        url = f"https://ncs.lnk.to/{next(iter(links))}/youtube"
        with build_opener(PreviewNoRedirect()).open(Request(url, headers=HEADERS), timeout=15) as response:
            text = response.read(2*1024*1024+1)
        if len(text) > 2*1024*1024:
            return None
        text = text.decode('utf-8').replace('\\/', '/')
    except HTTPError as error:
        if error.code not in (301, 302, 303, 307, 308):
            return None
        text = error.headers.get('Location', '')
    except (OSError, ValueError):
        return None
    ids = set(re.findall(r"https://(?:www\.youtube\.com/watch\?v=|youtu\.be/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])", text))
    return next(iter(ids)) if len(ids) == 1 else None


def verify(seed):
    page = f"https://ncs.io/{seed.lstrip('/')}"
    try:
        time.sleep(.2)
        with build_opener(CatalogRedirectHandler()).open(Request(page, headers=HEADERS), timeout=20) as response:
            final = urlsplit(response.url)
            if final.scheme != "https" or final.netloc != "ncs.io" or final.path.rstrip("/").casefold() != urlsplit(page).path.casefold():
                raise ValueError("official page redirected to a different path (possibly removed track/homepage)")
            if response.headers.get_content_type() != "text/html":
                raise ValueError("official page did not return HTML")
            source = response.read(2 * 1024 * 1024 + 1)
        if len(source) > 2 * 1024 * 1024:
            raise ValueError("official page exceeded 2 MiB")
        parser = TrackPage()
        parser.feed(source.decode("utf-8"))
        if len(parser.canonical) != 1 or len(parser.players) != 1:
            raise ValueError("missing unique canonical page or main #player")
        canonical = urlsplit(parser.canonical[0])
        if canonical.scheme != "https" or canonical.netloc != "ncs.io" or canonical.query or canonical.path.rstrip("/").casefold() != final.path.rstrip("/").casefold():
            raise ValueError("canonical page does not match requested track")
        player = parser.players[0]
        downloads = [attrs for attrs in parser.downloads if attrs.get("href") == f"/track/download/{player.get('data-tid')}"]
        if len(downloads) != 1:
            raise ValueError("main player and download metadata do not match")
        metadata = downloads[0]
        title, artist = clean(metadata.get("data-track", "")), clean(metadata.get("data-artist", ""))
        expected_titles = {f"{title} by {artist} on NCS", f"{title} by {artist.replace(', ', ' + ')} on NCS"}
        if not title or not artist or clean(parser.title) not in expected_titles:
            raise ValueError("track title/artist metadata do not match page title")
        genre = clean(metadata.get("data-genre", ""))
        if re.search(r"\b(acoustic|chill|ambient|lo[- ]?fi|downtempo|sleep|piano|slowed)\b", f"{genre} {title}", re.I):
            raise ValueError("explicit acoustic/chill/ambient/lo-fi or other low-energy label excluded")
        url = player.get("data-url", "")
        audio = urlsplit(url)
        if audio.scheme != "https" or audio.netloc != SOURCE_HOST or not re.fullmatch(r"/tracks/[A-Za-z0-9_./%-]+\.mp3", audio.path) or audio.query:
            raise ValueError("missing supported official NCS MP3 source")
        time.sleep(.2)
        with build_opener(CatalogRedirectHandler()).open(Request(url, headers=HEADERS, method="HEAD"), timeout=20) as response:
            size = int(response.headers.get("Content-Length", "0"))
            content_type = response.headers.get_content_type()
            if response.status != 200 or response.url != url or not content_type.startswith("audio/") or not 0 < size <= 20 * 1024 * 1024:
                raise ValueError(f"MP3 HEAD rejected: status={response.status}, type={content_type}, bytes={size}")
        identifier = re.sub(r"[^a-z0-9]+", "-", unquote(canonical.path).lower()).strip("-")
        if not identifier:
            raise ValueError("canonical path has no stable ASCII identifier")
        track = {"id": identifier, "title": title, "artist": artist, "page": parser.canonical[0], "url": url,
                 "genre": genre}
        video = preview_video_id(source.decode('utf-8'), parser)
        if video:
            track["youtubeId"] = video
        return track, {"page": page, "status": "verified", "bytes": size, "contentType": content_type}
    except Exception as error:
        return None, {"page": page, "status": "excluded", "reason": f"{type(error).__name__}: {error}"}


def main():
    seeds = list(dict.fromkeys(seed for seed in CLASSIC_SEEDS + DISCOVERED_SEEDS))
    tracks, report, ids, urls = [], [], set(), set()
    with ThreadPoolExecutor(max_workers=4) as pool:
        for track, evidence in pool.map(verify, seeds):
            if track and (track["id"] in ids or track["url"] in urls):
                evidence.update(status="excluded", reason="duplicate canonical track or MP3 source")
                track = None
            if track:
                tracks.append(track)
                ids.add(track["id"])
                urls.add(track["url"])
            report.append(evidence)
            print(f"{evidence['status']}: {evidence['page']}", flush=True)
    summary = {"verifiedAt": datetime.now(timezone.utc).isoformat(), "method": "Official canonical track page + matching main-player/download metadata + MP3 HEAD; no audio downloaded",
               "selection": "Fixed classic gaming candidates and the first page of official Drum & Bass, Drumstep, Dubstep, EDM, Electro, Electro House and energetic-mood lists; explicit low-energy labels excluded, no audio-energy measurement",
               "discoverySources": DISCOVERY_SOURCES, "candidates": len(seeds), "included": len(tracks), "results": report}
    (ROOT / "ops/ncs-catalog-report.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    if not {"invincible", "blank", "symbolism"}.issubset(ids) or len(tracks) < 50:
        raise SystemExit(f"Only {len(tracks)} verified tracks, or a required original track is missing; existing catalog preserved. See report.")
    (ROOT / "ncs-catalog.json").write_text(json.dumps(tracks, ensure_ascii=False, indent=2) + "\n")
    print(f"Verified {len(tracks)} / {len(seeds)} tracks; saved private ncs-catalog.json")


if __name__ == "__main__":
    main()
