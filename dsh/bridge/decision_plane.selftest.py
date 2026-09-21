#!/usr/bin/env python3
"""Three-fixture proof for the parallel decision plane.

  ./dsh/bridge/decision_plane.selftest.py

Buys ONE real canonical SystemOne decision per fixture (the production path) and
fans the same packet out to the shadow lanes concurrently. This spends a small
amount of money on the reference lane only; shadows are local/free.

Fixtures are frozen semantic decisions, not coding tasks.
"""
from __future__ import annotations
import json, os, subprocess, statistics, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "dsh", "bridge"))
import importlib.util

spec = importlib.util.spec_from_file_location("plane", os.path.join(ROOT, "dsh", "bridge", "shadow_decide.py"))
plane = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plane)

FIXTURES = [
    ("A", "simple", "What does the git command `git status --short` print?"),
    ("B", "routine", "Add a --dry-run flag to the existing export script and update its tests."),
    ("C", "substantial", "Design a migration that moves our 4 TB message archive from a single SQLite file into a sharded store without downtime, including rollback."),
]


def _typesafe_key() -> str:
    """The adapter's own source (JEV_DSH_KEY_FILE), then the environment."""
    if os.environ.get("TYPESAFE_API_KEY"):
        return os.environ["TYPESAFE_API_KEY"]
    path = os.environ.get("JEV_DSH_KEY_FILE", os.path.expanduser("~/.omp/.env"))
    try:
        for line in open(path, encoding="utf-8"):
            if line.startswith("TYPESAFE_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def reference_lane(prompt: str) -> dict:
    """The production decision, via the canonical CLI (`bin/jev route`)."""
    key = _typesafe_key()
    env = {**os.environ, "TYPESAFE_API_KEY": key,
           "JEV_ROUTING_CONFIG": os.environ.get("JEV_ROUTING_CONFIG", "/workspace/hermes-home/profiles/chiefstaff/jev/routing.json")}
    t0 = time.monotonic()
    try:
        p = subprocess.run(["/bin/sh", os.path.join(ROOT, "bin", "jev"), "route", "--prompt", prompt, "--timeout", "3"],
                           capture_output=True, text=True, env=env, timeout=45)
        d = json.loads(p.stdout)
    except Exception as exc:  # noqa: BLE001
        return {"backend": "systemone_direct", "transport": "canonical-jev-cli", "success": False, "error": str(exc)[:200]}
    says = {
        "difficulty": {"type": "score", "value": d.get("difficulty"), "confidence": d.get("confidence"), "probabilities": None},
        "kind": {"type": "choice", "value": d.get("specialty"), "confidence": d.get("confidence"), "probabilities": None},
        "costly_mistake": {"type": "boolean", "value": d.get("costly_mistake"),
                           "confidence": None,
                           "probabilities": None if d.get("costly_mistake") is None else
                           {"true": d["costly_mistake"], "false": round(1 - d["costly_mistake"], 6)}},
    }
    return {"backend": "systemone_direct", "transport": "canonical-jev-cli", "success": bool(d.get("routed")),
            "model": d.get("model") or d.get("policy"), "revision": d.get("policy"), "tier": d.get("tier"),
            "reason": d.get("reason"), "latency_ms": round((time.monotonic() - t0) * 1000, 2), "answers": says}


def main() -> int:
    import asyncio
    lanes_wanted = [x for x in os.environ.get("JEV_DSH_SHADOW_BACKENDS", "vercel_jev,nanojev").split(",") if x]
    lat = {"systemone_direct": [], "vercel_jev": [], "nanojev": []}
    rows = []
    for fid, band, prompt in FIXTURES:
        ref = reference_lane(prompt)
        out = asyncio.run(plane.fanout_async(prompt, f"fixture-{fid}", ref, lanes_wanted))
        lat.setdefault("systemone_direct", []).append(ref.get("latency_ms"))
        for lane in out["lanes"]:
            lat.setdefault(lane["backend"], []).append(lane.get("latency_ms"))
        rows.append((fid, band, out))

    for fid, band, out in rows:
        print(f"\n=== FIXTURE {fid} ({band})")
        for lane in out["lanes"]:
            a = lane.get("answers") or {}
            print(f"  {lane['backend']:18} role={'production' if lane['backend']=='systemone_direct' else 'shadow':10}"
                  f" ok={str(lane.get('success')):5} ms={lane.get('latency_ms')}")
            if a:
                print(f"      difficulty={a.get('difficulty',{}).get('value')} conf={a.get('difficulty',{}).get('confidence')}")
                print(f"      specialty={a.get('kind',{}).get('value')} conf={a.get('kind',{}).get('confidence')}")
                print(f"      costly_mistake={a.get('costly_mistake',{}).get('value')} conf={a.get('costly_mistake',{}).get('confidence')}")
                for k in ("difficulty", "kind"):
                    pr = a.get(k, {}).get("probabilities")
                    if pr:
                        print(f"      {k}_probs={json.dumps(pr)}")
            elif lane.get("error"):
                print(f"      error={str(lane['error'])[:120]}")
        for c in out["comparisons"]:
            print(f"  -- {c['reference']} vs {c['shadow']} comparable={c['comparable']}")
            for q, v in (c.get("questions") or {}).items():
                print(f"     {q:14} agree={v['categorical_agreement']} dConf={v['confidence_delta']} "
                      f"dDist={v['distribution_delta']} refSide={v['reference_threshold_side']} shadowSide={v['shadow_threshold_side']}")

    print("\n=== LATENCY (ms)")
    for k, v in lat.items():
        vals = sorted(x for x in v if x is not None)
        if vals:
            print(f"  {k:18} n={len(vals)} p50={statistics.median(vals):.1f} min={vals[0]:.1f} max={vals[-1]:.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
