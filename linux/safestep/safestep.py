#!/usr/bin/env python3
"""safestep.py — the watcher. The seat's steps, spoken only when something moved.

WHAT IT IS: a small daemon that reads what a seat leaves on disk while it works —
the runner's checkpoint (which session, in flight or done) and Claude Code's own
live transcript of that session — and turns real events into a few short signals
for the operator. It never talks to the seat, never slows it, cannot break it.

THE ONE LAW: speak only when something moved. Five marks, no sixth:
    ◆ Ground    a milestone is real (a file exists, a test passed, a deploy answered)
    ◇ Keystone  a question only the operator can answer
    → Next      a move worth naming
    ⧗ Friction  a wall met, and how it is being handled
    ● Arrival   the work is done, or has stopped

TWO SOURCES, ONE VOICE: derived signals come from the transcript (this file
decides Ground, Friction, Arrival, and a bounded "still moving"); explicit signals
come from the seat itself through safestep.sh and are forwarded at once. The
watcher makes SafeStep reliable; the seat makes it meaningful.

CONFIG: ~/.cortexinsight/safestep.json (read fresh whenever it changes).
STATE:  logs/safestep/.offsets.json (so a restart does not replay old signals).
LOG:    logs/safestep/<seat>-<date>.jsonl — one line per signal, for the console.

Env: CORTEX_ROOT (fleet tree), HERMES_HOME (for the hermes transport),
     SAFESTEP_DRY=1 (print signals instead of sending them).
"""
import calendar
import glob
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

ROOT = os.environ.get("CORTEX_ROOT", "/root/cortex").rstrip("/")
HOME = os.path.expanduser("~")
CONFIG = os.path.join(HOME, ".cortexinsight", "safestep.json")
MODES = os.path.join(HOME, ".cortexinsight", "modes.json")
LOGDIR = os.path.join(ROOT, "logs", "safestep")
OFFSETS = os.path.join(LOGDIR, ".offsets.json")
DRY = os.environ.get("SAFESTEP_DRY") == "1"
POLL = float(os.environ.get("SAFESTEP_POLL", "2"))
HERMES_PY = "/usr/local/lib/hermes-agent/venv/bin/python"

MARK = {"step": "◆", "ground": "◆", "ask": "◇", "keystone": "◇", "next": "→",
        "friction": "⧗", "done": "●", "arrival": "●", "moving": "◆"}

DEFAULTS = {
    "seats": ["august"], "transport": "hermes", "hermes_profile": "augusttt",
    "chat": "telegram", "bot_token_env": "", "bot_token_file": "", "voice": "SafeStep",
    "wake": {"deep_modes_immediately": True, "any_turn_after_s": 90},
    "cadence": {"ground_floor_s": 90, "urgent_floor_s": 20, "silence_ceiling_s": 360, "max_per_turn": 12},
    "scribe": {"enabled": True, "model": "cortex-scribe",
               "relay": "http://127.0.0.1:8788/v1/chat/completions", "timeout_s": 60},
}


# ── small things ───────────────────────────────────────────────────────────────
def log(line):
    try:
        os.makedirs(LOGDIR, exist_ok=True)
        with open(os.path.join(LOGDIR, "watcher.log"), "a") as f:
            f.write(f"{time.strftime('%F %T')} {line}\n")
    except Exception:
        pass


def deep_merge(base, over):
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = deep_merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


_cfg = {"mtime": -1, "data": DEFAULTS}


def config():
    try:
        st = os.stat(CONFIG)
        if st.st_mtime != _cfg["mtime"]:
            _cfg["data"] = deep_merge(DEFAULTS, json.load(open(CONFIG)))
            _cfg["mtime"] = st.st_mtime
    except Exception:
        pass
    return _cfg["data"]


def elapsed(s):
    s = int(max(0, s))
    if s < 90:
        return f"{s}s"
    m = s // 60
    return f"{m} min" if m < 60 else f"{m // 60} h {m % 60:02d} min"


def short(s, n=90):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def deep_mode(seat):
    """Is this seat in a deep gear right now? Same expiry rule as the relay."""
    try:
        e = (json.load(open(MODES)) or {}).get(seat) or {}
        if e.get("mode") not in ("motivus", "max"):
            return False
        u = e.get("until")
        return not u or calendar.timegm(time.strptime(u, "%Y-%m-%dT%H:%M:%SZ")) > time.time()
    except Exception:
        return False


def checkpoint(seat):
    d = {}
    try:
        for line in open(os.path.join(ROOT, "agents", seat, "checkpoint.state")):
            if "=" in line:
                k, v = line.strip().split("=", 1)
                d[k] = v
    except Exception:
        pass
    return d.get("SID", ""), d.get("STATUS", ""), float(d.get("EPOCH") or 0)


def find_transcript(sid):
    hits = glob.glob(os.path.join(HOME, ".claude", "projects", "*", f"{sid}.jsonl"))
    return hits[0] if hits else ""


# ── the transcript, read as events ─────────────────────────────────────────────
TEST_RX = re.compile(r"\b(pytest|npm (run )?test|node --check|bash -n|py_compile|jest|vitest|cargo test|go test)\b")
DEPLOY_RX = re.compile(r"\bvercel\b.*\b(deploy|--prod)\b|\bvercel --prod\b")
URL_RX = re.compile(r"https?://[\w.-]+\.vercel\.app[\w/.-]*")
FILE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
READ_TOOLS = {"Read", "Grep", "Glob"}


def parse_line(raw, pending):
    """One transcript line → a list of events. `pending` maps tool_use ids to
    (name, summary) so a result can be tied back to the tool that produced it."""
    try:
        d = json.loads(raw)
    except Exception:
        return []
    if d.get("type") not in ("assistant", "user"):
        return []
    blocks = (d.get("message") or {}).get("content")
    if not isinstance(blocks, list):
        return []
    ts = d.get("timestamp", "")
    out = []
    # How the model's message ended: "end_turn" is a chosen finish; "tool_use" on
    # the last line of a completed turn means the turn budget cut it off mid-step.
    stop = (d.get("message") or {}).get("stop_reason")
    if d["type"] == "assistant" and stop:
        out.append({"ts": ts, "kind": "stop", "stop": stop})
    for b in blocks:
        t = b.get("type")
        if t == "text" and d["type"] == "assistant" and b.get("text", "").strip():
            out.append({"ts": ts, "kind": "text", "text": b["text"].strip()})
        elif t == "tool_use":
            name, inp = b.get("name", ""), b.get("input") or {}
            if name in FILE_TOOLS:
                ev = {"kind": "file", "what": inp.get("file_path", "")}
            elif name == "Bash":
                cmd = inp.get("command", "")
                kind = "test" if TEST_RX.search(cmd) else "deploy" if DEPLOY_RX.search(cmd) else "command"
                ev = {"kind": kind, "what": inp.get("description") or short(cmd, 70)}
            elif name in ("Agent", "Task"):
                ev = {"kind": "subagent", "what": inp.get("description") or short(inp.get("prompt", ""), 70)}
            elif name.startswith("mcp__"):
                ev = {"kind": "hermes", "what": name.split("__")[-1]}
            elif name in READ_TOOLS:
                ev = {"kind": "read", "what": inp.get("file_path") or inp.get("pattern", "")}
            else:
                ev = {"kind": "tool", "what": name}
            ev.update({"ts": ts, "id": b.get("id", ""), "tool": name})
            pending[ev["id"]] = ev
            out.append(ev)
        elif t == "tool_result":
            src = pending.get(b.get("tool_use_id", ""), {})
            content = b.get("content")
            text = content if isinstance(content, str) else json.dumps(content)[:2000] if content else ""
            # A Write that CREATED a file is ground; a Write or Edit to a file that
            # already existed is work. Claude Code says which: the result of a
            # creating Write carries toolUseResult.type == "create".
            tur = d.get("toolUseResult")
            created = isinstance(tur, dict) and tur.get("type") == "create"
            ev = {"ts": ts, "kind": "result", "of": src.get("kind", "tool"), "what": src.get("what", ""),
                  "tool": src.get("tool", ""), "error": bool(b.get("is_error")), "text": text[:2000],
                  "created": created}
            # A URL in a result is NOT a deploy answering. It counts only when the
            # same text shows the deploy succeeded — a 2xx, READY, a production
            # line — and never when it shows a 404, an error or a login wall. The
            # first version said "the preview is live" off a curl that returned 404.
            m = URL_RX.search(text or "")
            if m:
                body = text or ""
                failed = re.search(r"\b(404|40[13]|50\d|not found|login_required|error|denied)\b", body, re.I)
                proven = re.search(r"\b(HTTP/[12](?:\.\d)? 20\d|200 OK|READY|readyState\W{0,4}READY|Production: https)", body)
                if proven and not failed:
                    ev["url"] = m.group(0)
            out.append(ev)
    return out


# ── turning events into meaning ────────────────────────────────────────────────
def milestones(events, announced=()):
    """The events that count as ground gained since the last signal. A file is
    ground the FIRST time it exists; editing a file the operator already heard
    about is work, not news — it feeds "still moving", never a Ground line."""
    ms = []
    seen = set(announced)
    for e in events:
        if e["kind"] == "result" and not e["error"]:
            if e["of"] == "file" and e.get("created"):
                if e["what"] in seen:
                    continue
                seen.add(e["what"])
                ms.append(("file", e["what"]))
            elif e["of"] == "test":
                ms.append(("test", e["what"]))
            elif e.get("url"):
                ms.append(("deploy", e["url"]))          # only a URL the result itself proved answered
            elif e["of"] == "subagent":
                ms.append(("subagent", e["what"]))
            elif e["of"] == "hermes":
                ms.append(("hermes", e["what"]))
    return ms


def frictions(events):
    return [e for e in events if e["kind"] == "result" and e["error"]]


def template(seat, mark, ms=None, errs=None, moving=None, arrival=None):
    """The line when the scribe cannot be reached. Plain, true, short."""
    if arrival:
        return f"● {seat} · done in {arrival['elapsed']} · {arrival['files']} files · {arrival['tools']} tools" + (
            f" · {short(arrival['last'], 120)}" if arrival.get("last") else "")
    if moving:
        return f"◆ {seat} · still moving · {moving['tools']} tools · {moving['elapsed']} in" + (
            f" · last: {short(moving['last'], 60)}" if moving.get("last") else "")
    if errs is not None:
        e = errs[-1]
        return f"⧗ {seat} · {len(errs)} errors · last: {e['tool']} {short(e['what'], 50)} — {short(e['text'], 90)}"
    files = [w for k, w in ms if k == "file"]
    tests = [w for k, w in ms if k == "test"]
    deploys = [w for k, w in ms if k == "deploy"]
    parts = []
    if files:
        parts.append(f"{len(files)} file{'s' if len(files) > 1 else ''} written")
    if tests:
        parts.append(f"{len(tests)} check{'s' if len(tests) > 1 else ''} run")
    if deploys:
        parts.append(f"deployed: {deploys[-1]}")
    subs = [w for k, w in ms if k == "subagent"]
    if subs:
        parts.append(f"{len(subs)} subagent{'s' if len(subs) > 1 else ''} returned")
    last = (files or tests or deploys or subs or [""])[-1]
    return f"◆ {seat} · " + ", ".join(parts) + (f" · {short(os.path.basename(str(last)) or last, 60)}" if last else "")


VOICE = ("You are SafeStep, the voice that tells an operator what a working agent just achieved. "
         "Write ONE line, at most 200 characters, beginning with the mark and the seat name exactly as given, then a middle dot (·). "
         "Say the SHAPE of what moved — what now exists that did not before — not a list of tool calls. "
         "Warm, direct, movement verbs, no preamble, no 'I', no exclamation marks, no quotes around the whole line.")


def scribe(cfg, prompt, fallback):
    s = cfg["scribe"]
    if not s.get("enabled") or DRY:
        return fallback
    body = json.dumps({"model": s["model"], "messages": [{"role": "system", "content": VOICE},
                                                         {"role": "user", "content": prompt}]}).encode()
    try:
        req = urllib.request.Request(s["relay"], data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=s.get("timeout_s", 60)) as r:
            out = json.load(r)["choices"][0]["message"]["content"].strip().splitlines()[0].strip()
        if 8 < len(out) <= 240 and out[0] in "◆◇→⧗●":
            return out
        log(f"scribe gave an odd line, using template: {out[:80]!r}")
    except Exception as e:
        log(f"scribe unavailable ({type(e).__name__}: {e}); using template")
    return fallback


# ── delivery ───────────────────────────────────────────────────────────────────
def send(cfg, text):
    text = text.strip()[:3500]
    if DRY:
        print(text, flush=True)
        return True
    tr = cfg.get("transport", "hermes")
    try:
        if tr == "telegram-api":
            token = os.environ.get(cfg.get("bot_token_env") or "", "")
            if not token and cfg.get("bot_token_file"):
                token = open(os.path.expanduser(cfg["bot_token_file"])).read().strip()
            chat = cfg["chat"].split(":", 1)[-1]
            body = json.dumps({"chat_id": chat, "text": text, "disable_web_page_preview": True}).encode()
            req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=body,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r).get("ok", False)
        env = dict(os.environ)
        env["HERMES_HOME"] = os.path.join(HOME, ".hermes", "profiles", cfg.get("hermes_profile", "augusttt"))
        # Hermes renders plain text as MarkdownV2, so a path with an underscore
        # would italicise. An HTML tag forces HTML mode: the mark and seat go
        # bold, the rest is escaped and shown exactly as written.
        esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        m = re.match(r"^([◆◇→⧗●]\s*\S+)\s*(?:[·—–-]\s*)?(.*)$", text, re.S)
        text = (f"<b>{esc(m.group(1))}</b> · {esc(m.group(2))}" if m and m.group(2) else
                f"<b>{esc(m.group(1))}</b>" if m else esc(text))
        p = subprocess.run([HERMES_PY, "-m", "hermes_cli.main", "send", "--to", cfg["chat"], "-q", text],
                           env=env, capture_output=True, text=True, timeout=40)
        if p.returncode != 0:
            log(f"send failed rc={p.returncode}: {short(p.stderr or p.stdout, 200)}")
        return p.returncode == 0
    except Exception as e:
        log(f"send error {type(e).__name__}: {e}")
        return False


def record(seat, sid, kind, text, source):
    try:
        os.makedirs(LOGDIR, exist_ok=True)
        with open(os.path.join(LOGDIR, f"{seat}-{time.strftime('%Y-%m-%d')}.jsonl"), "a") as f:
            f.write(json.dumps({"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "seat": seat, "sid": sid,
                                "kind": kind, "text": text, "source": source}, ensure_ascii=False) + "\n")
    except Exception:
        pass


# ── one seat, watched ──────────────────────────────────────────────────────────
class Seat:
    def __init__(self, name):
        self.name = name
        self.reset()
        self.explicit_offset = None       # set from OFFSETS on first use

    def reset(self):
        self.sid = ""; self.status = ""; self.started = 0.0
        self.path = ""; self.offset = 0
        self.pending = {}; self.events = []; self.since = []
        self.awake = False; self.sent = 0; self.last_sent = 0.0; self.last_text = ""
        self.last_ground = 0.0; self.last_friction = 0.0; self.last_moving = 0.0
        self.files = set(); self.tools = 0; self.last_tool = ""; self.final_text = ""
        self.open_tool = None; self.explicit_done = False
        self.announced = set()            # files the operator has already heard about

    # -- the explicit queue (safestep.sh) --
    def explicit_path(self):
        return os.path.join(ROOT, "agents", self.name, "safestep.jsonl")

    def drain_explicit(self, cfg, offsets):
        p = self.explicit_path()
        if self.explicit_offset is None:
            self.explicit_offset = offsets.get(p, os.path.getsize(p) if os.path.exists(p) else 0)
        try:
            size = os.path.getsize(p)
        except OSError:
            return
        if size < self.explicit_offset:
            self.explicit_offset = 0
        if size == self.explicit_offset:
            return
        with open(p, encoding="utf-8", errors="replace") as f:
            f.seek(self.explicit_offset); chunk = f.read(); self.explicit_offset = f.tell()
        offsets[p] = self.explicit_offset
        for line in chunk.splitlines():
            try:
                d = json.loads(line)
            except Exception:
                continue
            kind = d.get("kind", "step"); mark = MARK.get(kind, "◆")
            text = f"{mark} {self.name} · {short(d.get('text', ''), 400)}"
            floor = cfg["cadence"]["urgent_floor_s"] if kind in ("ask", "friction", "done") else 5
            self.emit(cfg, kind, text, "explicit", floor=min(floor, 5) if kind == "done" else 5)
            if kind == "done":
                self.explicit_done = True

    # -- the transcript --
    def tail(self):
        if not self.path:
            self.path = find_transcript(self.sid)
            if not self.path:
                return
            # A RESUMED session's transcript already holds every earlier turn.
            # Start reading from where the file is now, or the first Ground line
            # would proudly summarise work the operator saw last week. What is
            # lost is at most the prompt line written a moment before we looked.
            try:
                self.offset = os.path.getsize(self.path)
            except OSError:
                self.offset = 0
            return
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return
        if size <= self.offset:
            return
        with open(self.path, encoding="utf-8", errors="replace") as f:
            f.seek(self.offset); chunk = f.read(); self.offset = f.tell()
        for line in chunk.splitlines():
            for ev in parse_line(line, self.pending):
                if ev["kind"] == "stop":
                    self.last_stop = ev["stop"]
                    continue
                self.events.append(ev); self.since.append(ev)
                if ev["kind"] == "text":
                    self.final_text = ev["text"]
                elif ev["kind"] != "result":
                    self.tools += 1; self.last_tool = f"{ev['tool']} {short(ev['what'], 50)}"
                    self.open_tool = (self.last_tool, time.time())   # a tool is running
                    if ev["kind"] == "file" and ev["what"]:
                        self.files.add(ev["what"])
                else:
                    self.open_tool = None                            # it came back

    # -- speaking --
    def emit(self, cfg, kind, text, source, floor=None):
        now = time.time()
        if text == self.last_text:
            return False
        if floor is not None and now - self.last_sent < floor:
            if source != "explicit":
                return False                  # a derived batch can ride the next batch
            # An explicit signal is the seat's own voice; it is never dropped. It
            # waits out the floor (a few seconds, for the chat's rate limit) and goes.
            time.sleep(min(floor - (now - self.last_sent), 5))
        if source == "derived" and self.sent >= cfg["cadence"]["max_per_turn"]:
            return False
        ok = send(cfg, text)
        if ok:
            self.sent += 1; self.last_sent = time.time(); self.last_text = text   # stamped at send, not at entry
            record(self.name, self.sid, kind, text, source)
            log(f"{source} {kind} {self.name}: {text}")
        return ok

    def derive(self, cfg):
        c = cfg["cadence"]; now = time.time()
        if not self.awake:
            return
        ms = milestones(self.since, announced=getattr(self, "announced", set())); errs = frictions(self.since)
        # Friction first: waiting on a wall costs the operator time.
        if len(errs) >= 3 and now - self.last_friction >= c["urgent_floor_s"]:
            fb = template(self.name, "⧗", errs=errs)
            prompt = (f"Mark: ⧗  Seat: {self.name}. The agent hit these errors:\n" +
                      "\n".join(f"- {e['tool']} {short(e['what'], 60)}: {short(e['text'], 160)}" for e in errs[-4:]) +
                      "\nSay what wall it met and whether it is handling it.")
            if self.emit(cfg, "friction", scribe(cfg, prompt, fb), "derived", floor=c["urgent_floor_s"]):
                self.last_friction = now; self.since = []
            return
        if ms and now - self.last_ground >= c["ground_floor_s"]:
            fb = template(self.name, "◆", ms=ms)
            prompt = (f"Mark: ◆  Seat: {self.name}. Since the last signal the agent achieved:\n" +
                      "\n".join(f"- {k}: {short(w, 100)}" for k, w in ms[-8:]) +
                      f"\n{elapsed(now - self.started)} into the work. Say ONLY what is new." +
                      (f"\nAlready said, do not repeat: {short(self.last_text, 160)}" if self.last_text else ""))
            if self.emit(cfg, "ground", scribe(cfg, prompt, fb), "derived", floor=c["ground_floor_s"]):
                self.last_ground = now; self.since = []
                self.announced = getattr(self, "announced", set()) | {w for k, w in ms if k == "file"}
            return
        # Bounded silence: alive, but nothing meaningful for a while.
        quiet_since = max(self.last_sent, self.started)
        if now - quiet_since >= c["silence_ceiling_s"] and now - self.last_moving >= c["silence_ceiling_s"]:
            # A long-running tool writes nothing while it runs; that is not a
            # stall, it is a seat inside a command. Say which one, and for how long.
            inside = (f"inside {self.open_tool[0]} for {elapsed(now - self.open_tool[1])}"
                      if getattr(self, "open_tool", None) else self.last_tool)
            text = template(self.name, "◆", moving={"tools": self.tools, "elapsed": elapsed(now - self.started),
                                                     "last": inside})
            if self.emit(cfg, "moving", text, "derived"):
                self.last_moving = now

    def arrive(self, cfg, status):
        if self.explicit_done or (not self.awake and self.sent == 0):
            return
        self.tail()
        now = time.time()
        stats = {"elapsed": elapsed(now - self.started), "files": len(self.files), "tools": self.tools,
                 "last": self.final_text}
        if status == "incomplete":
            text = f"● {self.name} · stopped after {stats['elapsed']} · {stats['files']} files · {stats['tools']} tools · the turn was cut short"
        elif getattr(self, "last_stop", "end_turn") != "end_turn":
            # The runner says complete, but the model's last message ended on a
            # tool call: the turn budget ran out mid-step. Say that, not "done".
            text = (f"● {self.name} · ran out of turns after {stats['elapsed']} · {stats['files']} files · "
                    f"{stats['tools']} tools · mid-step: {short(self.last_tool, 60)} · a resume finishes it")
        else:
            fb = template(self.name, "●", arrival=stats)
            prompt = (f"Mark: ●  Seat: {self.name}. The work finished in {stats['elapsed']}: {stats['files']} files, "
                      f"{stats['tools']} tool calls. The agent's final words:\n{short(self.final_text, 900)}\n"
                      "Say what moved and the one next move.")
            text = scribe(cfg, prompt, fb)
        self.emit(cfg, "arrival", text, "derived")

    # -- one look --
    def look(self, cfg, offsets):
        sid, status, epoch = checkpoint(self.name)
        now = time.time()
        if status == "inflight" and sid:
            if sid != self.sid:
                if self.sid and self.status == "inflight":
                    # the runner retried on a fresh id: same turn, new transcript
                    self.sid = sid; self.path = ""; self.offset = 0; self.pending = {}
                else:
                    self.reset(); self.sid = sid; self.started = epoch or now
                self.status = "inflight"
            self.tail()
            w = cfg["wake"]
            if not self.awake and ((w.get("deep_modes_immediately") and deep_mode(self.name))
                                   or now - self.started >= w.get("any_turn_after_s", 90)):
                self.awake = True
                log(f"awake for {self.name} sid={sid[:8]} deep={deep_mode(self.name)} after {elapsed(now - self.started)}")
            self.drain_explicit(cfg, offsets)
            self.derive(cfg)
        elif self.sid and status in ("complete", "incomplete") and sid == self.sid and self.status == "inflight":
            self.drain_explicit(cfg, offsets)
            self.arrive(cfg, status)
            self.status = status
            log(f"turn ended {self.name} sid={sid[:8]} status={status} signals={self.sent}")
        else:
            self.drain_explicit(cfg, offsets)     # a seat may speak between turns too


def main():
    os.makedirs(LOGDIR, exist_ok=True)
    try:
        offsets = json.load(open(OFFSETS))
    except Exception:
        offsets = {}
    seats = {}
    log(f"START safestep watcher root={ROOT} dry={DRY}")
    while True:
        cfg = config()
        for name in cfg.get("seats", []):
            seats.setdefault(name, Seat(name)).look(cfg, offsets)
        try:
            tmp = OFFSETS + ".tmp"
            json.dump(offsets, open(tmp, "w")); os.replace(tmp, OFFSETS)
        except Exception:
            pass
        time.sleep(POLL)


if __name__ == "__main__":
    main()
