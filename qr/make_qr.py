"""Generate static QR codes for the signup page.

Usage (from the repo root):
    pip install segno
    python qr/make_qr.py

Add an event by adding its slug to SOURCES, then rerun. None = no ?src (recorded as "direct").
Codes are static: they encode the URL directly, so they never expire or depend on a QR service.
"""
from pathlib import Path

import segno

SITE = "https://devilinorbit.com/"
SOURCES = ["direct-qr", "tiac-playtest", "ocig-2026"]
OUT = Path(__file__).parent


def url_for(source):
    return SITE if source is None else f"{SITE}?src={source}"


for source in SOURCES:
    name = source or "general"
    # Error correction Q survives glare and damage on printed cards; border=4 is the required quiet zone.
    qr = segno.make(url_for(source), error="q")
    qr.save(OUT / f"{name}.svg", scale=10, border=4)  # vector: use this for printing at any size
    qr.save(OUT / f"{name}.png", scale=20, border=4)  # raster fallback
    print(f"{name}: {url_for(source)}")
