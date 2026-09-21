#!/usr/bin/env python3
"""Backend-neutral shadow decision bridge for the DSH JEV adapter.

Reuses the SAME canonical semantic questions as hermes-jev-skills and the
EXISTING z0int DecisionBackend implementations. Observers only -- these
backends can never change provider/model/effort/RLM/tools.

Usage:
  shadow_decide.py health [--backend ID]
  shadow_decide.py evaluate --prompt TEXT [--backends a,b] [--turn-key K]
"""
from __future__ import annotations
import argparse, json, os, sys, time

JEV_ROOT = os.environ.get("JEV_DSH_ROOT", "/home/kvn/zer0/oss/hermes-jev-skills")
Z0INT_SRC = os.environ.get("Z0INT_SRC", "/home/kvn/tmp/openjev/src")
for _p in (JEV_ROOT, Z0INT_SRC):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)

DEFAULT_BACKENDS = ["decider_2b", "nanojev"]
# Known-unready backends are cheap to skip (do not attempt to load weights).
KNOWN_UNREADY = {"laya_421m": "weights absent"}


def _z0():
    from z0int.backends import base, registry  # noqa
    return base, registry


def health(ids):
    _base, registry = _z0()
    out = []
    for i in ids:
        if i in KNOWN_UNREADY:
            out.append({"id": i, "ready": False, "loaded": False, "error": KNOWN_UNREADY[i], "skipped": True})
            continue
        try:
            rows = registry.backend_status(i, load=False)
            for r in rows:
                out.append({
                    "id": getattr(r.get("spec"), "id", i) if not isinstance(r.get("id"), str) else r["id"],
                    "ready": bool(r.get("health", {}).get("ready")) if isinstance(r.get("health"), dict) else bool(r.get("ready")),
                    "loaded": bool(r.get("health", {}).get("loaded")) if isinstance(r.get("health"), dict) else bool(r.get("loaded")),
                    "configured": bool(r.get("health", {}).get("configured")) if isinstance(r.get("health"), dict) else None,
                    "model": (r.get("health") or {}).get("model") if isinstance(r.get("health"), dict) else r.get("model"),
                    "detail": (r.get("health") or {}).get("detail") if isinstance(r.get("health"), dict) else None,
                })
        except Exception as exc:  # noqa: BLE001
            out.append({"id": i, "ready": False, "loaded": False, "error": f"{type(exc).__name__}: {exc}"})
    return {"backends": out}


def canonical_request(prompt: str, request_id: str):
    """Build the SAME bounded semantic packet canonical JEV is asked."""
    base, _ = _z0()
    from jevkit import client, privacy, route

    limit = int((route.load_config() or {}).get("ask_chars", 2500))
    ask = prompt if len(prompt) <= limit else prompt[: limit // 4] + "\n[...]\n" + prompt[-(limit - limit // 4):]
    features = route._features(ask, 0)
    state = {"user_turn": privacy.redact(ask, limit + 50), "context": features["context"]}
    wire = {
        "difficulty": client.score("How demanding is it to complete this turn well?", route.DIFFICULTY),
        "kind": client.choice("What kind of work is this turn mainly?", route.KIND),
        "costly_mistake": client.noul("A wrong or sloppy answer here would be costly or hard to undo"),
    }
    questions = []
    for qid, q in wire.items():
        if q["type"] == "score":
            questions.append(base.DecisionQuestion(id=qid, type="score", instructions=q["instructions"], levels=tuple(q["criteria"])))
        elif q["type"] == "choice":
            opts = tuple(base.DecisionOption(id=str(k), description=str(v)) for k, v in q["criteria"].items())
            questions.append(base.DecisionQuestion(id=qid, type="choice", instructions=q["instructions"], options=opts))
        else:
            questions.append(base.DecisionQuestion(id=qid, type="boolean", instructions=q["instructions"],
                                                   false_criterion="not costly", true_criterion="costly or hard to undo"))
    return base.DecisionRequest(state=state, questions=tuple(questions), request_id=request_id)


def evaluate(prompt, ids, turn_key):
    base, registry = _z0()
    req = canonical_request(prompt, turn_key)
    results = []
    for i in ids:
        if i in KNOWN_UNREADY:
            results.append({"backend": i, "success": False, "skipped": True, "error": KNOWN_UNREADY[i]})
            continue
        t0 = time.monotonic()
        try:
            backend = registry.create_backend(i)
            res = backend.evaluate(req)
            answers = {}
            for a in res.answers:
                answers[a.question_id] = {
                    "type": a.type,
                    "value": a.value,
                    "confidence": a.confidence,
                    "probabilities": dict(a.probabilities or {}),
                }
            results.append({
                "backend": i,
                "success": True,
                "model": getattr(res, "model", None),
                "revision": getattr(res, "revision", None),
                "backend_latency_ms": getattr(res, "latency_ms", None),
                "total_latency_ms": round((time.monotonic() - t0) * 1000, 2),
                "answers": answers,
            })
        except Exception as exc:  # noqa: BLE001
            results.append({"backend": i, "success": False, "total_latency_ms": round((time.monotonic() - t0) * 1000, 2),
                            "error": f"{type(exc).__name__}: {exc}"})
    return {"turn_key": turn_key, "request_id": req.request_id, "backends": results}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("op", choices=["health", "evaluate"])
    ap.add_argument("--prompt", default="")
    ap.add_argument("--turn-key", default="")
    ap.add_argument("--backends", default=",".join(DEFAULT_BACKENDS))
    ap.add_argument("--backend", default=None)
    a = ap.parse_args()
    ids = [x for x in (a.backends or "").split(",") if x] if not a.backend else [a.backend]
    out = health(ids) if a.op == "health" else evaluate(a.prompt, ids, a.turn_key)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
