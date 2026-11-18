#!/usr/bin/env bash
# ============================================================================
#  motus-mode.sh — the seat's gear lever.
#
#  A mode is a temporary override of HOW a seat answers: which model, how deep,
#  how many turns, and whether it works in deep-build discipline. It lives in
#  ~/.cortexinsight/modes.json, is read fresh by cortex-run.sh on every turn,
#  and cools down on its own: the operator says "motus max" once and, two hours
#  later, the seat is back on cruise without anyone remembering to flip it.
#
#    motus-mode.sh <seat> max|motivus|seekdepth|cruise [--ttl MIN] [--by WHO] [--note TEXT]
#    motus-mode.sh <seat> status          → one JSON line, the mode in force now
#    motus-mode.sh <seat> clear           → back to cruise
#
#  Modes:
#    cruise   claude-opus-5-5  effort max   the default; nothing in the file
#    motivus  claude-opus-5-5  effort max   deep-build discipline, 200 turns
#    max      claude-opus-5-5  effort max   deep-build discipline, 300 turns
#
#  Every Claude gear is on Opus 5.5 since 2026-09-23 (August: all agents on Opus
#  5.5 by default). Max was Fable 5.1 before that; a profile override puts it back.
#
#  Profiles can be tuned without touching this file: put overrides in
#  ~/.cortexinsight/modes.profiles.json  ({"max": {"turns": 400}, ...}).
#  Precedence in the runner: an active mode > fleet.json > seat defaults.
#  A hard pause in fleet.json still wins over everything.
# ============================================================================
set -uo pipefail
exec python3 - "$@" <<'PY'
import json, os, re, sys, time, datetime, tempfile

HOME = os.path.expanduser("~")
CI = os.path.join(HOME, ".cortexinsight")
FILE = os.path.join(CI, "modes.json")
PROFILES_FILE = os.path.join(CI, "modes.profiles.json")
TTL_MIN = int(os.environ.get("MOTUS_MODE_TTL_MIN", "120") or 120)

PROFILES = {
    "cruise":  {"label": "CRUISE",        "model": "claude-opus-5-5", "effort": "max", "turns": 96,  "deep": False},
    "motivus": {"label": "MOTUS MOTIVUS", "model": "claude-opus-5-5", "effort": "max", "turns": 200, "deep": True},
    "max":     {"label": "MOTUS MAX",     "model": "claude-opus-5-5", "effort": "max", "turns": 300, "deep": True},
    # SEEKDEPTH leaves the subscription entirely: an OpenRouter model served
    # over the Anthropic Messages API. `effort` is empty on purpose — --effort
    # is an Anthropic flag and a third-party endpoint rejects it. It does not
    # cool down on a timer; the operator asked for it to hold until he says
    # otherwise, so its default TTL is 0 (no expiry).
    "seekdepth": {"label": "SEEKDEPTH", "model": "deepseek/deepseek-v4-pro", "effort": "", "turns": 200, "deep": True},
}
ALIAS = {"normal": "cruise", "cool": "cruise", "cooldown": "cruise", "default": "cruise",
         "ultra": "motivus", "ultracode": "motivus", "fable": "max",
         "seek": "seekdepth", "deepseek": "seekdepth", "seekdepth-mode": "seekdepth",
         "main": "cruise", "seekdepth-off": "cruise"}

def profiles():
    p = json.loads(json.dumps(PROFILES))
    try:
        for k, v in (json.load(open(PROFILES_FILE)) or {}).items():
            if k in p and isinstance(v, dict):
                p[k].update({kk: vv for kk, vv in v.items() if kk in ("model", "effort", "turns", "label", "deep")})
    except Exception:
        pass
    return p

def now_iso(ts=None):
    return datetime.datetime.fromtimestamp(ts or time.time(), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def parse_iso(s):
    try:
        return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()
    except Exception:
        return None

def load():
    try:
        d = json.load(open(FILE))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}

def save(d):
    os.makedirs(CI, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=CI, prefix=".modes-", suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, indent=2)
    os.replace(tmp, FILE)

def active(seat, d=None):
    """The mode in force for a seat right now, expiry honoured. None = cruise."""
    d = d if d is not None else load()
    e = d.get(seat)
    if not isinstance(e, dict) or e.get("mode") in (None, "", "cruise"):
        return None
    until = e.get("until")
    if until:
        t = parse_iso(until)
        if t is None or t <= time.time():
            return None
    return e

def describe(seat, e):
    p = profiles()
    if not e:
        base = p["cruise"]
        return {"seat": seat, "mode": "cruise", "label": base["label"], "model": base["model"],
                "effort": base["effort"], "turns": base["turns"], "deep": False, "until": None,
                "since": None, "set_by": None, "active": False}
    return {"seat": seat, "mode": e["mode"], "label": e.get("label"), "model": e.get("model"),
            "effort": e.get("effort"), "turns": e.get("turns"), "deep": bool(e.get("deep")),
            "until": e.get("until"), "since": e.get("since"), "set_by": e.get("set_by"), "active": True,
            "note": e.get("note", "")}

def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: motus-mode.sh <seat> <max|motivus|seekdepth|cruise|status|clear> [--ttl MIN] [--by WHO] [--note TEXT]\n")
        return 2
    seat = re.sub(r"[^A-Za-z0-9._-]", "", argv[0])[:40]
    verb = argv[1].strip().lower()
    verb = ALIAS.get(verb, verb)
    opts = {"ttl": TTL_MIN, "by": "cli", "note": ""}
    # SEEKDEPTH holds until he says otherwise. Every other gear cools down.
    if ALIAS.get(verb, verb) == "seekdepth" and "--ttl" not in argv:
        opts["ttl"] = 0
    i = 2
    while i < len(argv):
        a = argv[i]
        if a == "--ttl" and i + 1 < len(argv):
            try: opts["ttl"] = int(argv[i + 1])
            except ValueError: pass
            i += 2; continue
        if a == "--sticky":
            opts["ttl"] = 0; i += 1; continue
        if a == "--by" and i + 1 < len(argv):
            opts["by"] = re.sub(r"[^A-Za-z0-9._-]", "", argv[i + 1])[:24]; i += 2; continue
        if a == "--note" and i + 1 < len(argv):
            opts["note"] = argv[i + 1][:200]; i += 2; continue
        i += 1

    d = load()
    if verb == "status":
        print(json.dumps(describe(seat, active(seat, d))))
        return 0
    if verb in ("clear", "cruise"):
        prev = active(seat, d)
        if seat in d:
            del d[seat]
            save(d)
        out = describe(seat, None)
        out["was"] = prev.get("mode") if prev else "cruise"
        out["set_by"] = opts["by"]
        print(json.dumps(out))
        return 0
    p = profiles()
    if verb not in p:
        sys.stderr.write("unknown mode: %s (want max, motivus, seekdepth or cruise)\n" % verb)
        return 2
    prof = p[verb]
    t0 = time.time()
    e = {"mode": verb, "label": prof["label"], "model": prof["model"], "effort": prof["effort"],
         "turns": int(prof["turns"]), "deep": bool(prof["deep"]), "since": now_iso(t0),
         "until": now_iso(t0 + opts["ttl"] * 60) if opts["ttl"] > 0 else None,
         "set_by": opts["by"], "note": opts["note"]}
    d[seat] = e
    save(d)
    print(json.dumps(describe(seat, e)))
    return 0

sys.exit(main(sys.argv[1:]))
PY
