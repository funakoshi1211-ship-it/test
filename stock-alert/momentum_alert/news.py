"""Googleニュース（RSS）で、テーマに関する記事数の急増を検知する。

新聞社・テレビ局のWeb記事、ネットメディアの記事が Googleニュースに載るので、
それを「世の中の話題になり始めたか」の目安として使う。
"""
from __future__ import annotations

import email.utils
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import requests

RSS = "https://news.google.com/rss/search"


def _locale(query: str) -> dict:
    if any(ord(c) > 127 for c in query):
        return {"hl": "ja", "gl": "JP", "ceid": "JP:ja"}
    return {"hl": "en-US", "gl": "US", "ceid": "US:en"}


def fetch(query: str, window: str = "7d", timeout: int = 20) -> list[dict]:
    """[{title, link, source, published}] を新しい順で返す（最大100件）。"""
    params = {"q": f"{query} when:{window}", **_locale(query)}
    r = requests.get(f"{RSS}?{urllib.parse.urlencode(params)}", timeout=timeout,
                     headers={"User-Agent": "Mozilla/5.0 momentum-alert"})
    r.raise_for_status()
    return parse(r.content)


def parse(xml_bytes: bytes) -> list[dict]:
    items = []
    for it in ET.fromstring(xml_bytes).iter("item"):
        pub = it.findtext("pubDate")
        try:
            published = email.utils.parsedate_to_datetime(pub) if pub else None
        except (TypeError, ValueError):
            published = None
        items.append({
            "title": it.findtext("title") or "",
            "link": it.findtext("link") or "",
            "source": it.findtext("source") or "",
            "published": published,
        })
    items.sort(key=lambda x: x["published"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return items


def theme_buzz(queries: list[str], history: list[int], th: dict, now: datetime | None = None,
               fetcher=fetch) -> dict:
    """直近24時間の記事数と普段の水準を比べる。

    history はこれまでの実行で記録した「24時間の記事数」。3回分以上あればそれを普段の水準にし、
    足りないうちは7日分の記事から1日平均を見積もる（RSSは最大100件なので、多い話題では過小になる）。
    """
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)
    seen: set[str] = set()
    recent, older, headlines = 0, 0, []
    for q in queries:
        try:
            items = fetcher(q)
        except Exception as e:  # ニュースが取れなくても株価のアラートは止めない
            print(f"[news] {q}: {e}")
            continue
        for it in items:
            key = it["title"].strip()
            if not key or key in seen:
                continue
            seen.add(key)
            if it["published"] and it["published"] >= cutoff:
                recent += 1
                if len(headlines) < 3:
                    headlines.append(it)
            else:
                older += 1

    past = [h for h in history if h is not None][-14:]
    baseline = sum(past) / len(past) if len(past) >= 3 else older / 6
    ratio = recent / baseline if baseline > 0 else (float("inf") if recent else 0.0)
    surge = recent >= th["news_min_count"] and ratio >= th["news_surge"]
    return {"count24h": recent, "baseline": round(baseline, 1), "ratio": ratio,
            "surge": surge, "headlines": headlines}
