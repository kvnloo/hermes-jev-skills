#!/usr/bin/env python3
"""Checkpoint A regression test: one root turn buys SystemOne exactly once.

  ./dsh/bridge/decision_plane.purchase.selftest.py

Proves the observer plane REUSES the production result instead of purchasing a
second direct SystemOne decision, and that asking for jev_direct as a lane is a
structural no-op rather than a duplicate call.

No model calls: the TypeSafe transport is stubbed with a counter. The nanojev
lane is stubbed too, so this test is deterministic and offline.
"""
from __future__ import annotations
import asyncio, importlib.util, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location("plane", os.path.join(ROOT, "dsh", "bridge", "shadow_decide.py"))
plane = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plane)

failures = 0


def check(name, cond, detail=""):
    global failures
    if not cond:
        failures += 1
    print(f"{'PASS' if cond else 'FAIL'}  {name}{'  ' + detail if detail else ''}")


# ── Stub the transports so nothing is purchased ─────────────────────────────
calls = {"typesafe_direct": 0, "vercel_ai_gateway": 0, "nanojev": 0}
real_call = plane._call_jev_transport


def counting_call(transport, payload, api_key):
    calls[transport] = calls.get(transport, 0) + 1
    return {"ok": True, "family": "jev", "transport": transport, "model": "stub",
            "answers": {"difficulty": {"type": "score", "value": 2.0, "confidence": 0.9, "probabilities": None}}}


plane._call_jev_transport = counting_call
plane._lane_nanojev = lambda req, packet: (calls.__setitem__("nanojev", calls["nanojev"] + 1)
                                           or {"backend": "nanojev", "backend_family": "nanojev",
                                               "transport": "in_process", "success": True,
                                               "answers": {}})

# ── The production decision, as the adapter passes it in ────────────────────
PRODUCTION = {
    "backend": "jev_direct", "backend_family": "jev", "transport": "typesafe_direct", "authority": "production",
    "success": True, "model": "route-2", "latency_ms": 480,
    "answers": {
        "difficulty": {"type": "score", "value": 3.0, "confidence": 1.0, "probabilities": None},
        "kind": {"type": "choice", "value": "general", "confidence": 1.0, "probabilities": None},
        "costly_mistake": {"type": "boolean", "value": True, "confidence": None, "probabilities": {"true": 0.92, "false": 0.08}},
    },
}


def run(ids):
    calls.update({"typesafe_direct": 0, "vercel_ai_gateway": 0, "nanojev": 0})
    return asyncio.run(plane.fanout_async("Design a zero-downtime migration.", "session-a:1", dict(PRODUCTION), ids))


# 1. Observing jev_direct must not buy a second SystemOne decision.
out = run(["jev_direct", "nanojev"])
check("asking to observe jev_direct buys nothing", calls["typesafe_direct"] == 0, f"typesafe_direct calls={calls['typesafe_direct']}")
check("the request is recorded as refused, not silently dropped",
      any(r["backend"] == "jev_direct" and r["reason"] == "reference_already_purchased" for r in out["refused_lanes"]),
      str(out["refused_lanes"]))
check("exactly one SystemOne purchase is declared", out["systemone_purchases"] == 1)
check("independent shadows still ran", calls["nanojev"] == 1, f"nanojev calls={calls['nanojev']}")

# 2. The jev_direct receipt IS the production result, not a re-derivation.
ref = [l for l in out["lanes"] if l["backend"] == "jev_direct"]
check("exactly one jev_direct lane exists", len(ref) == 1, f"count={len(ref)}")
check("the jev_direct receipt carries production authority", ref and ref[0]["authority"] == "production")
check("the receipt is the SAME object production executed",
      ref and ref[0]["answers"] == PRODUCTION["answers"])
check("production latency is preserved, not re-measured", ref and ref[0]["latency_ms"] == 480)

# 3. No summary can claim more than one purchase.
check("no lane reports a second direct purchase",
      sum(1 for l in out["lanes"] if l.get("transport") == "typesafe_direct") == 1)

# 4. A turn that does not ask for jev_direct behaves identically.
out2 = run(["nanojev"])
check("a normal shadow turn buys nothing extra", calls["typesafe_direct"] == 0 and calls["nanojev"] == 1)
check("the reference lane is always present", len([l for l in out2["lanes"] if l["backend"] == "jev_direct"]) == 1)

# 5. Vercel parity would be a second transport, never a second direct purchase.
out3 = run(["jev_vercel", "nanojev"])
check("requesting the Vercel transport never touches typesafe_direct",
      calls["typesafe_direct"] == 0, f"typesafe_direct calls={calls['typesafe_direct']}")

plane._call_jev_transport = real_call
print(f"\n{'ALL PASS' if failures == 0 else str(failures) + ' FAILURE(S)'}")
sys.exit(0 if failures == 0 else 1)
