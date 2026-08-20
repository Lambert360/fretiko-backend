#!/usr/bin/env python3
"""Keep only dark-complexion African human portraits, split by gender."""
import json
import os
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

from PIL import Image

MAX_SKIN_Y = 138
MIN_SKIN_Y = 18
MIN_SKIN_FRACTION = 0.12

REJECT = re.compile(
    r"elephant|lioness|lion|impala|antelope|butterfly|wildlife|calf|rice|food|"
    r"omelette|rugby|festival|family|crowd|group portrait|group of|players|"
    r"musician|umbrella|landscape|statue|drawing|illustration|cartoon|"
    r"baby|infant|toddler|\bchild\b|\bkids?\b",
    re.I,
)
PORTRAIT = re.compile(
    r"portrait|headshot|close-?up|face|smiling|poses|posing|wearing|"
    r"\bman\b|\bwoman\b|\bmale\b|\bfemale\b|person",
    re.I,
)
FEMALE = re.compile(r"\b(woman|women|female|lady|girl)\b", re.I)
MALE = re.compile(r"\b(man|men|male|boy|gentleman)\b", re.I)


def classify_gender(alt: str, search_gender: str):
    text = alt or ""
    female = bool(FEMALE.search(text))
    male = bool(MALE.search(text))
    if female and not male:
        return "female"
    if male and not female:
        return "male"
    if female and male:
        return None
    return search_gender


def is_portrait_candidate(alt: str) -> bool:
    text = alt or ""
    if REJECT.search(text):
        return False
    return bool(PORTRAIT.search(text))


def score_dark_skin(path: str):
    try:
        im = Image.open(path).convert("RGB")
    except Exception:
        return None
    im.thumbnail((96, 96))
    w, h = im.size
    if w < 20 or h < 20:
        return None

    pixels = []
    for y in range(h // 5, (4 * h) // 5):
        for x in range(w // 5, (4 * w) // 5):
            pixels.append(im.getpixel((x, y)))
    if not pixels:
        return None

    skin = []
    for r, g, b in pixels:
        if r < 30 or g < 8:
            continue
        if g > r + 18 or b > r + 25:
            continue
        if not (r >= g - 6 and g >= b - 12):
            continue
        if (r - g) > 90 or (r - b) > 140:
            continue
        skin.append((r, g, b))

    if len(skin) < MIN_SKIN_FRACTION * len(pixels):
        return None

    y_mean = sum(0.299 * r + 0.587 * g + 0.114 * b for r, g, b in skin) / len(skin)
    if y_mean < MIN_SKIN_Y or y_mean > MAX_SKIN_Y:
        return None
    return y_mean


def download(url: str, dest: str) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "FretikoAvatarPool/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp, open(dest, "wb") as out:
            out.write(resp.read())
        return os.path.getsize(dest) > 1000
    except Exception:
        return False


def collect_unique(candidates):
    by_url = {}
    for search_gender, photos in (("male", candidates.get("men", [])), ("female", candidates.get("women", []))):
        for photo in photos:
            url = photo.get("url")
            alt = photo.get("alt") or ""
            if not url or not is_portrait_candidate(alt):
                continue
            gender = classify_gender(alt, search_gender)
            if not gender:
                continue
            existing = by_url.get(url)
            if existing is None:
                by_url[url] = {**photo, "gender": gender}
            elif existing["gender"] != gender:
                existing["gender"] = None
    men = [p for p in by_url.values() if p["gender"] == "male"]
    women = [p for p in by_url.values() if p["gender"] == "female"]
    return men, women


def filter_group(photos, label):
    kept = []
    with tempfile.TemporaryDirectory() as tmpdir:
        for i, photo in enumerate(photos, 1):
            dest = os.path.join(tmpdir, f"{label}-{i}.img")
            if not download(photo["url"], dest):
                print(f"  skip {label} {i}: download failed")
                continue
            score = score_dark_skin(dest)
            if score is None:
                print(f"  skip {label} {i}: not dark-complexion portrait")
                continue
            kept.append(photo["url"])
            print(f"  keep {label} {len(kept)}: Y={score:.0f}")
    return kept


def main():
    candidates_path = sys.argv[1] if len(sys.argv) > 1 else "avatar-candidates.json"
    with open(candidates_path, "r", encoding="utf-8") as fh:
        candidates = json.load(fh)

    men_c, women_c = collect_unique(candidates)
    print(f"Portrait candidates after text filter: {len(men_c)} male, {len(women_c)} female")
    men = filter_group(men_c, "men")
    women = filter_group(women_c, "women")

    out_path = Path.cwd() / "avatar-pool.json"
    out_path.write_text(json.dumps({"men": men, "women": women}, indent=2), encoding="utf-8")
    print(f"Saved {len(men)} male and {len(women)} female dark-complexion portraits to {out_path}")
    if len(men) < 25 or len(women) < 25:
        print("WARNING: pool is thin; consider adding more search queries")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
