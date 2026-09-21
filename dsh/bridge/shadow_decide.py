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
import argparse, json, os, subprocess, sys, time

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


# ── Parallel decision plane ──────────────────────────────────────────────────
# One canonical packet, fanned out concurrently. systemone_direct is the
# production/reference lane and is passed IN (already bought by the adapter) so
# the fanout never re-purchases it. Vercel Jev and NanoJev are shadows: they are
# recorded, never awaited on the turn's critical path, and never consulted.
LANE_TIMEOUT_S = float(os.environ.get("JEV_DSH_LANE_TIMEOUT_S", "30"))
MIN_CONFIDENCE = 0.6
JEV_EVAL_DIR = os.environ.get("JEV_DSH_EVAL_DIR", os.path.join(JEV_ROOT, "dsh", "bridge", "jev-evaluate"))
JEV_EVAL_HELPER = os.path.join(JEV_EVAL_DIR, "evaluate.mjs")

# ONE backend family, TWO transports. `jev_direct` and `jev_vercel` are the same
# family answering the same semantic questions over different transports, so
# they are NOT two independent votes: their comparison is transport parity.
# Independent shadow backends answer the same questions from a different model.
FAMILY_OF = {
    "jev_direct": "jev",
    "jev_vercel": "jev",
    "nanojev": "nanojev",
    "decider_2b": "decider",
}
TRANSPORT_OF = {
    "jev_direct": "typesafe_direct",
    "jev_vercel": "vercel_ai_gateway",
    "nanojev": "in_process",
    "decider_2b": "in_process",
}
# Independent shadows only. jev_vercel is a transport of the reference family
# and is NOT enabled for ordinary turns: the Vercel account returns an
# account-wide 403, so calling it every turn would burn latency for nothing.
DEFAULT_SHADOW_LANES = ["nanojev"]

# Cached availability. Probed at most once per process, never per turn, and
# overridable from a small state file so a restart does not re-probe either.
VERCEL_STATE_FILE = os.environ.get("JEV_DSH_VERCEL_STATE", os.path.expanduser("~/.dsh/jev/vercel_transport.json"))
VERCEL_ACCOUNT_403 = "account-wide 403: AI Gateway requires a valid credit card on file"
_vercel_state_cache: dict | None = None


def _credential(name: str) -> str:
    """Read one reference from the DSH credential store. Never logged or echoed."""
    val = os.environ.get(name)
    if val:
        return val
    path = os.path.join(os.path.expanduser("~"), ".dsh", ".credentials.yaml")
    try:
        import re as _re
        for line in open(path, encoding="utf-8"):
            m = _re.match(rf"^\s{{2}}{_re.escape(name)}:\s*(.+?)\s*$", line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def _answer_rows(res):
    out = {}
    for a in res.answers:
        out[a.question_id] = {
            "type": a.type,
            "value": a.value,
            "confidence": a.confidence,
            "probabilities": dict(a.probabilities or {}),
        }
    return out


def _lane_nanojev(req, _packet):
    _base, registry = _z0()
    t0 = time.monotonic()
    try:
        res = registry.create_backend("nanojev").evaluate(req)
        return {
            "backend": "nanojev", "backend_family": "nanojev", "transport": "in_process", "success": True,
            "model": getattr(res, "model", None), "revision": getattr(res, "revision", None),
            "backend_latency_ms": getattr(res, "latency_ms", None),
            "latency_ms": round((time.monotonic() - t0) * 1000, 2),
            "answers": _answer_rows(res),
        }
    except Exception as exc:  # noqa: BLE001
        return {"backend": "nanojev", "backend_family": "nanojev", "transport": "in_process", "success": False,
                "latency_ms": round((time.monotonic() - t0) * 1000, 2),
                "error": f"{type(exc).__name__}: {exc}"}


def jev_vercel_state() -> dict:
    """Cached transport health. Never probes per turn."""
    global _vercel_state_cache
    if _vercel_state_cache is not None:
        return _vercel_state_cache
    state = {"transport": "vercel_ai_gateway", "family": "jev", "state": "unknown", "reason": None}
    try:
        with open(VERCEL_STATE_FILE, encoding="utf-8") as fh:
            disk = json.load(fh)
        state.update({k: disk[k] for k in ("state", "reason", "checked_at") if k in disk})
    except (OSError, ValueError):
        # No record yet: probe ONCE, not per turn.
        state["checked_at"] = int(time.time())
        if os.environ.get("JEV_DSH_VERCEL_PROBE", "") == "1":
            used = _credential("AI_GATEWAY_API_KEY")
            if not used:
                state.update({"state": "unavailable", "reason": "no AI_GATEWAY_API_KEY reference"})
            else:
                r = _call_jev_transport("vercel_ai_gateway", {"state": {"probe": True},
                                                              "questions": {"q": {"type": "boolean", "instructions": "probe"}}}, used)
                if r.get("ok"):
                    state.update({"state": "available", "reason": None})
                elif r.get("http_status") == 403:
                    state.update({"state": "unavailable", "reason": VERCEL_ACCOUNT_403})
                else:
                    state.update({"state": "unavailable", "reason": r.get("error")})
        else:
            state.update({"state": "unavailable", "reason": VERCEL_ACCOUNT_403})
        try:
            os.makedirs(os.path.dirname(VERCEL_STATE_FILE), exist_ok=True)
            with open(VERCEL_STATE_FILE, "w", encoding="utf-8") as fh:
                json.dump(state, fh)
        except OSError:
            pass
    _vercel_state_cache = state
    return state


def _call_jev_transport(transport: str, payload: dict, api_key: str) -> dict:
    """Native typed evaluation through the AI SDK helper. No chat, no JSON prompt.

    Both transports share the canonical DecisionRequest {state, questions} and
    differ only in the SDK provider that carries it.
    """
    req = {"transport": transport, "apiKey": api_key, "state": payload.get("state"),
           "questions": payload.get("questions"), "timeoutMs": int(LANE_TIMEOUT_S * 1000)}
    try:
        proc = subprocess.run(["node", JEV_EVAL_HELPER], input=json.dumps(req), capture_output=True,
                              text=True, timeout=LANE_TIMEOUT_S + 5, cwd=JEV_EVAL_DIR)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "family": "jev", "transport": transport, "error": f"{type(exc).__name__}: {exc}"}
    if proc.returncode != 0:
        return {"ok": False, "family": "jev", "transport": transport,
                "error": f"helper exit {proc.returncode}: {proc.stderr.strip()[:200]}"}
    try:
        return json.loads(proc.stdout)
    except ValueError:
        return {"ok": False, "family": "jev", "transport": transport, "error": "helper produced no JSON"}


def _lane_jev_transport(transport: str, packet: dict):
    """A Jev transport lane. Same family, same frozen packet, different carrier."""
    t0 = time.monotonic()
    out = {"backend": "jev_vercel" if transport == "vercel_ai_gateway" else "jev_direct",
           "backend_family": "jev", "transport": transport}
    if transport == "vercel_ai_gateway":
        state = jev_vercel_state()
        if state.get("state") != "available":
            out.update({"success": False, "skipped": True, "unavailable": True,
                        "error": state.get("reason") or "transport unavailable"})
            out["latency_ms"] = None
            return out
    key = _credential("AI_GATEWAY_API_KEY" if transport == "vercel_ai_gateway" else "TYPESAFE_AI_API_KEY")
    if not key:
        out.update({"success": False, "error": f"no credential for transport {transport}"})
        out["latency_ms"] = round((time.monotonic() - t0) * 1000, 2)
        return out
    r = _call_jev_transport(transport, packet, key)
    out.update({
        "success": bool(r.get("ok")),
        "model": r.get("model"),
        "error": r.get("error"),
        "http_status": r.get("http_status"),
        "usage": r.get("usage"),
        "rounding": r.get("rounding"),
        "confidence_by_question": r.get("confidence"),
        "latency_ms": round((time.monotonic() - t0) * 1000, 2),
    })
    if r.get("ok"):
        out["answers"] = r.get("answers")
    return out


def _dist_delta(ref_ans, shad_ans):
    """Max absolute difference over the UNION of outcome keys; None if incomparable."""
    rp = (ref_ans or {}).get("probabilities") or {}
    sp = (shad_ans or {}).get("probabilities") or {}
    if not rp or not sp:
        return None
    keys = set(rp) | set(sp)
    try:
        return round(max(abs(float(rp.get(k, 0)) - float(sp.get(k, 0))) for k in keys), 6)
    except (TypeError, ValueError):
        return None


def compare(reference, shadow):
    """Continuous-first comparison. Agreement is recorded, never used as authority.

    `kind` distinguishes the two things a comparison can mean:
      parity      - same backend family, two transports. Tests transport
                    equivalence, NOT independent agreement.
      independent - a different model answering the same questions. This is the
                    only kind that carries any notion of corroboration.
    """
    ref_family = reference.get("backend_family") or FAMILY_OF.get(reference.get("backend", ""), "unknown")
    shad_family = shadow.get("backend_family") or FAMILY_OF.get(shadow.get("backend", ""), "unknown")
    kind = "parity" if ref_family == shad_family and ref_family != "unknown" else "independent"
    ra = reference.get("answers") or {}
    sa = shadow.get("answers") or {}
    per_q = {}
    for qid in sorted(set(ra) | set(sa)):
        r, s = ra.get(qid), sa.get(qid)
        # A missing answer on either side is NOT agreement: a failed lane must
        # never be scored as concurring with the reference (None == None).
        both = bool(r) and bool(s) and r.get("value") is not None and s.get("value") is not None
        per_q[qid] = {
            "categorical_agreement": (r["value"] == s["value"]) if both else None,
            "reference_value": (r or {}).get("value"),
            "shadow_value": (s or {}).get("value"),
            "reference_confidence": (r or {}).get("confidence"),
            "shadow_confidence": (s or {}).get("confidence"),
            "confidence_delta": (
                round(float(s["confidence"]) - float(r["confidence"]), 6)
                if both and r.get("confidence") is not None and s.get("confidence") is not None else None
            ),
            "distribution_delta": _dist_delta(r, s),
            "reference_threshold_side": (float(r["confidence"]) >= MIN_CONFIDENCE) if both and r.get("confidence") is not None else None,
            "shadow_threshold_side": (float(s["confidence"]) >= MIN_CONFIDENCE) if both and s.get("confidence") is not None else None,
        }
    return {
        "reference": reference.get("backend"),
        "shadow": shadow.get("backend"),
        "reference_family": ref_family,
        "shadow_family": shad_family,
        "reference_transport": reference.get("transport"),
        "shadow_transport": shadow.get("transport"),
        "kind": kind,
        "counts_as_independent_vote": kind == "independent",
        "comparable": bool(ra) and bool(sa),
        "questions": per_q,
    }


async def fanout_async(prompt: str, turn_key: str, systemone, ids) -> dict:
    """Concurrent entry point: one packet, bounded per-lane timeouts, no barrier."""
    import asyncio

    base, _ = _z0()
    req = canonical_request(prompt, turn_key)
    packet = {
        "request_id": req.request_id,
        "state": req.state,
        "questions": [
            {"id": q.id, "type": q.type, "instructions": q.instructions,
             "options": [{"id": o.id, "description": o.description} for o in q.options],
             "levels": list(q.levels),
             "false_criterion": q.false_criterion, "true_criterion": q.true_criterion}
            for q in req.questions
        ],
    }

    async def guarded(fn, *args):
        try:
            return await asyncio.wait_for(asyncio.to_thread(fn, *args), timeout=LANE_TIMEOUT_S)
        except asyncio.TimeoutError:
            return {"backend": "unknown", "success": False, "error": f"timeout>{LANE_TIMEOUT_S}s"}
        except Exception as exc:  # noqa: BLE001
            return {"backend": "unknown", "success": False, "error": f"{type(exc).__name__}: {exc}"}

    jobs, names = [], []
    refused = []
    for i in ids:
        if i == "jev_vercel":
            jobs.append(guarded(_lane_jev_transport, "vercel_ai_gateway", packet)); names.append(i)
        elif i == "jev_direct":
            # The production SystemOne call has ALREADY been purchased for this
            # root turn and is passed in as the reference lane. Dispatching it
            # here would buy the same decision twice and could apply a different
            # result to the receipt than the one production executed. Observing
            # jev_direct is therefore a structural no-op, not a lane.
            refused.append({"backend": "jev_direct", "reason": "reference_already_purchased"})
        elif i == "nanojev":
            jobs.append(guarded(_lane_nanojev, req, packet)); names.append(i)
        elif i in KNOWN_UNREADY:
            jobs.append(guarded(lambda _i=i: {"backend": _i, "success": False, "skipped": True, "error": KNOWN_UNREADY[_i]}))
            names.append(i)
    settled = await asyncio.gather(*jobs, return_exceptions=True) if jobs else []

    reference = dict(systemone or {})
    reference.setdefault("backend", "jev_direct")
    reference.setdefault("backend_family", "jev")
    reference.setdefault("transport", "typesafe_direct")
    reference.setdefault("authority", "production")
    reference.setdefault("success", bool(reference.get("answers")))

    shadows = []
    for name, res in zip(names, settled):
        if isinstance(res, BaseException):
            res = {"backend": name, "success": False, "error": f"{type(res).__name__}: {res}"}
        elif res.get("backend") == "unknown":
            res["backend"] = name
        res.setdefault("authority", "shadow")
        res.setdefault("backend_family", FAMILY_OF.get(res.get("backend", ""), "unknown"))
        res.setdefault("transport", TRANSPORT_OF.get(res.get("backend", ""), "unknown"))
        shadows.append(res)

    comparisons = [compare(reference, s) for s in shadows]
    parity = [c for c in comparisons if c["kind"] == "parity"]
    independent = [c for c in comparisons if c["kind"] == "independent"]

    return {
        "turn_key": turn_key, "decision_id": turn_key, "trace_id": turn_key,
        "request_id": req.request_id,
        "packet_chars": len(json.dumps(packet, ensure_ascii=False)),
        "packet": packet,
        "lanes": [reference] + shadows,
        "comparisons": comparisons,
        "transport_parity": parity,
        "independent_comparisons": independent,
        # Turns that asked to observe jev_direct and were refused, so the
        # one-purchase-per-root-turn invariant is visible in the record.
        "refused_lanes": refused,
        "systemone_purchases": 1,
        "independent_vote_count": len([c for c in independent if c["comparable"]]),
        "raw": {"lanes": [reference] + shadows, "comparisons": comparisons},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("op", choices=["health", "evaluate", "fanout"])
    ap.add_argument("--prompt", default="")
    ap.add_argument("--turn-key", default="")
    ap.add_argument("--backends", default=",".join(DEFAULT_SHADOW_LANES))
    ap.add_argument("--backend", default=None)
    ap.add_argument("--systemone-json", default="")
    ap.add_argument("--no-packet", action="store_true")
    a = ap.parse_args()
    ids = [x for x in (a.backends or "").split(",") if x] if not a.backend else [a.backend]
    if a.op == "health":
        out = health(ids)
    elif a.op == "evaluate":
        out = evaluate(a.prompt, ids, a.turn_key)
    else:
        import asyncio
        sysone = json.loads(a.systemone_json) if a.systemone_json else None
        out = asyncio.run(fanout_async(a.prompt, a.turn_key, sysone, ids))
        if a.no_packet:
            out.pop("packet", None)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
