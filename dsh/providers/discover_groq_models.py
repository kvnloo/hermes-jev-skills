#!/usr/bin/env python3
"""Emit a `llm-pi-ai` providers block from Groq's LIVE model catalog.

  ./discover_groq_models.py            # print the YAML fragment
  ./discover_groq_models.py --check    # report drift against the live catalog

Never prints the credential. Reads it from the DSH credential store by reference
name only. The live catalog is authoritative: the pi-ai bundled catalog for Groq
is stale (it still lists llama-3.x models Groq no longer serves).
"""
from __future__ import annotations
import argparse, json, os, re, sys, urllib.request

BASE = "https://api.groq.com/openai/v1/models"
# Groq's edge rejects requests with NO User-Agent at all. Node's default
# (undici) and curl pass, so no header override is needed in DSH.
UA = "dsh-hermes-jev-provider-probe/0.1"
# Text-in/text-out is not sufficient: guard/moderation classifiers are also
# text->text but are not chat models.
NON_CHAT = ("guard", "safeguard", "whisper", "orpheus", "tts", "embed")


def credential(name: str) -> str:
    val = os.environ.get(name)
    if val:
        return val
    path = os.path.expanduser("~/.dsh/.credentials.yaml")
    try:
        for line in open(path, encoding="utf-8"):
            m = re.match(rf"^\s{{2}}{re.escape(name)}:\s*(.+?)\s*$", line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def live_models() -> list[dict]:
    key = credential("GROQ_API_KEY")
    if not key:
        sys.exit("no GROQ_API_KEY reference resolvable")
    req = urllib.request.Request(BASE, headers={"Authorization": f"Bearer {key}", "User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read().decode()).get("data", [])
    out = []
    for m in data:
        if not m.get("active", True):
            continue
        if "text" not in (m.get("input_modalities") or []) or "text" not in (m.get("output_modalities") or []):
            continue
        if any(p in m["id"].lower() for p in NON_CHAT):
            continue
        out.append(m)
    return sorted(out, key=lambda x: x["id"])


def render(models: list[dict]) -> str:
    lines = ["    groq:", "      displayName: Groq", "      apiKeyEnv: GROQ_API_KEY",
             "      api: openai-completions", "      baseURL: https://api.groq.com/openai/v1", "      models:"]
    for m in models:
        ctx = int(m.get("context_window") or 131072)
        mt = int(m.get("max_completion_tokens") or 32768)
        lines += [f"        - id: {m['id']}", f"          name: {m.get('name') or m['id']}",
                  f"          contextWindow: {ctx}", f"          maxTokens: {mt}", "          input: [text]"]
        if m.get("reasoning") is False:
            lines.append("          reasoningEfforts: false")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="compare live catalog against the configured settings")
    a = ap.parse_args()
    models = live_models()
    if not a.check:
        print(render(models))
        return 0
    settings = os.path.expanduser("~/.dsh/settings.yaml")
    configured = set(re.findall(r"^\s+- id: (\S+)$", open(settings, encoding="utf-8").read(), re.M)) if os.path.exists(settings) else set()
    live = {m["id"] for m in models}
    print(f"live={len(live)} configured_in_settings={len(configured & live)}")
    for mid in sorted(live - configured):
        print(f"  MISSING from settings: {mid}")
    for mid in sorted(configured - live):
        print(f"  STALE in settings:     {mid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
