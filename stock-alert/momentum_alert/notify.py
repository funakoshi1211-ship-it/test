"""通知（メール・Discord）。設定されているものだけ送る。"""
from __future__ import annotations

import os
import smtplib
from email.mime.text import MIMEText

import requests


def send_email(subject: str, body: str) -> bool:
    user, pw, to = os.getenv("SMTP_USER"), os.getenv("SMTP_PASS"), os.getenv("ALERT_TO")
    if not (user and pw and to):
        return False
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"], msg["From"], msg["To"] = subject, user, to
    with smtplib.SMTP_SSL(os.getenv("SMTP_HOST", "smtp.gmail.com"), 465, timeout=30) as s:
        s.login(user, pw)
        s.sendmail(user, [a.strip() for a in to.split(",")], msg.as_string())
    return True


def send_discord(body: str) -> bool:
    url = os.getenv("DISCORD_WEBHOOK_URL")
    if not url:
        return False
    # Discord は1メッセージ2000文字まで
    chunk = ""
    for line in body.splitlines(keepends=True):
        if len(chunk) + len(line) > 1900:
            requests.post(url, json={"content": chunk}, timeout=20).raise_for_status()
            chunk = ""
        chunk += line
    if chunk.strip():
        requests.post(url, json={"content": chunk}, timeout=20).raise_for_status()
    return True


def send_all(subject: str, body: str) -> list[str]:
    sent = []
    for name, fn in (("email", lambda: send_email(subject, body)), ("discord", lambda: send_discord(body))):
        try:
            if fn():
                sent.append(name)
        except Exception as e:
            print(f"[notify] {name} 失敗: {e}")
    return sent
