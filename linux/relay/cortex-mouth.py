#!/usr/bin/env python3
"""cortex-mouth.py — the loopback relay.

WHAT IT IS, in one sentence: an OpenAI-shaped endpoint on 127.0.0.1 that turns
every request into one Claude Code turn on the operator's own subscription.

WHY IT EXISTS: everything in this system speaks to agents the same way — the
console, a messaging gateway, a cron, a script. If each of them called Claude
Code itself there would be four auth paths, four log formats and four places for
a turn to go missing. There is one mouth instead, and everything talks through
it.

WHAT IT GUARANTEES:
  · The message reaches the runner on STDIN, never as an argument. A pasted
    message longer than the argument limit used to die right here.
  · ANTHROPIC_API_KEY is stripped from the environment of every turn, so a key
    that happens to be set on the box can never turn a $0 subscription turn into
    a billed API call.
  · Every turn is written to the fleet's own logs in the shape the console reads:
    logs/interactions/<agent>-<date>.jsonl and a readable .md beside it.
  · It never returns an error to a person. If every attempt fails it says so in
    a sentence, because a gateway that answers with a stack trace has failed
    twice.

WHAT IT BINDS TO: 127.0.0.1 and nothing else. If CORTEX_MOUTH_KEY is set, a
request must carry that secret as the first path segment, which is what makes it
safe to put behind a tunnel later. Empty means loopback only.

Configuration, all through the environment:
  CORTEX_ROOT          the fleet tree (required)
  CORTEX_MOUTH_PORT    default 8788
  CORTEX_MOUTH_KEY     capability secret; empty = loopback only
  CORTEX_MOUTH_TIMEOUT seconds for one turn, default 1800
  CORTEX_MOUTH_RETRIES retries after the first attempt, default 2
"""
import base64
import calendar
import hashlib
import io
import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.environ.get("CORTEX_ROOT", "").rstrip("/")
if not ROOT:
    raise SystemExit("CORTEX_ROOT is not set: the relay does not guess where the fleet lives")

PORT = int(os.environ.get("CORTEX_MOUTH_PORT", "8788"))
RUNNER = os.environ.get("CORTEX_RUNNER") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "cortex-run.sh")
LOG = os.path.join(ROOT, "logs", "mouth-proxy.log")
INTERACT_DIR = os.path.join(ROOT, "logs", "interactions")
TIMEOUT = int(os.environ.get("CORTEX_MOUTH_TIMEOUT", "1800"))
RETRIES = int(os.environ.get("CORTEX_MOUTH_RETRIES", "2"))
STREAM_POLL = float(os.environ.get("CORTEX_STREAM_POLL", "0.25"))
SEP = "\x1e"                                   # the runner's step boundary
STREAM_OFF = os.path.expanduser("~/.cortex_stream_disabled")


def mouth_key() -> str:
    # An explicitly set variable is the answer, even when it is empty: setting it
    # to nothing is how an operator says "loopback only, no capability key", and
    # quietly falling through to a stale key file would ignore that instruction.
    if "CORTEX_MOUTH_KEY" in os.environ:
        return os.environ["CORTEX_MOUTH_KEY"].strip()
    try:
        with open(os.path.expanduser("~/.cortex_mouth_key")) as f:
            return f.read().strip()
    except Exception:
        return ""


KEY = mouth_key()


def log(line: str) -> None:
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as f:
            f.write(f"{time.strftime('%F %T')} {line}\n")
    except Exception:
        pass


def _kill_tree(proc) -> None:
    """Stop the runner AND everything it started. Killing only the bash wrapper
    left the claude process alive with its tools, still working on a turn nobody
    was waiting for — and free to collide with the retry that followed it."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _ckpt_mark(agent, status) -> None:
    """The runner's EXIT trap cannot run after a SIGKILL, so the console would
    keep drawing a seat as in-flight forever. Say honestly that it was cut short."""
    path = os.path.join(ROOT, "agents", agent, "checkpoint.state")
    try:
        lines = [l for l in io.open(path, encoding="utf-8").read().splitlines() if not l.startswith("STATUS=")]
        lines.append(f"STATUS={status}")
        io.open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    except Exception:
        pass


# Secrets arrive in messages. On 2026-09-19 the operator pasted an ElevenLabs
# key into the chat to install it; without this, that key would have been written
# verbatim into a 644 interaction log and sat there forever. The log is a record
# of what was said, not a place to keep a credential — so a credential is replaced
# by a fingerprint that is still enough to tell two keys apart.
_SECRETS = [
    (re.compile(r"\bsk_[A-Za-z0-9]{40,}"), "elevenlabs"),
    (re.compile(r"\bsk-(?:ant|proj|or)-[A-Za-z0-9_\-]{20,}"), "api"),
    (re.compile(r"\b\d{8,12}:AA[A-Za-z0-9_\-]{30,}"), "telegram-bot"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"), "github"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"), "slack"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "aws"),
]


def redact(text: str) -> str:
    s = str(text or "")
    for rx, kind in _SECRETS:
        s = rx.sub(lambda m, k=kind: f"[{k}:{m.group(0)[:4]}…{m.group(0)[-3:]} REDACTED]", s)
    return s


def log_interaction(agent, msg, out, status, latency, attempts, extra=None) -> None:
    """The fleet's own record of the turn. The console reads this and nothing
    else, so the shape is a contract: keep the keys, keep local time.
    Lengths are measured on the ORIGINAL text; only what is written is redacted."""
    in_chars, out_chars = len(msg or ""), len(out or "")
    try:
        msg, out = redact(msg), redact(out)
        os.makedirs(INTERACT_DIR, exist_ok=True)
        day = time.strftime("%Y-%m-%d")           # LOCAL day, like every stamp here
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        rec = {"ts": ts, "agent": agent, "status": status, "via": "mouth-proxy",
               "attempts": attempts, "latency_s": latency, "out_chars": out_chars,
               "in_chars": in_chars, "msg": msg[:4000]}
        if extra:
            rec.update(extra)
        with open(f"{INTERACT_DIR}/{agent}-{day}.jsonl", "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        with open(f"{INTERACT_DIR}/{agent}-{day}.md", "a") as f:
            f.write(f"\n### {ts} · {agent} · {status} · {latency}s · {out_chars} chars\n"
                    f"**In:** {msg[:2000]}\n\n**Out:** {out[:6000]}\n\n---\n")
    except Exception:
        pass


def agent_from_model(model: str) -> str:
    """A caller names a model; we hear a seat. Longest, most specific first —
    'davaris' must never be read as 'davara'."""
    m = (model or "").lower()
    # One August. A caller still naming the retired "august-v3" seat lands on the
    # real one by substring, not on the default seat by accident.
    for name in ("sympath-cortex", "workhorse", "davaris", "davari", "davara", "arden", "august", "scribe", "greta"):
        if name in m:
            return name
    if "sympath" in m:
        return "sympath-cortex"
    if "adapt" in m:
        return "arden"
    return os.environ.get("CORTEX_DEFAULT_AGENT", "davara")


def latest_user_text(messages) -> str:
    for msg in reversed(messages or []):
        if isinstance(msg, dict) and msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, list):     # the content-parts form
                content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
            return str(content).strip()
    return ""


# ── The thread, not just the last line ──────────────────────────────────────
# An OpenAI-shaped caller (Hermes, a gateway, a script) keeps the conversation
# on ITS side and re-sends the whole thread every turn. The runner, on the other
# hand, starts a FRESH Claude Code session per turn — so whatever is not in this
# request body is not in the turn. Forwarding only the last user line, which is
# all this relay used to do, made every multi-turn caller amnesiac: "yes, do
# that" arrived with no idea what "that" was. The thread is flattened here.
#
# The budgets are deliberate, not timidity. A subscription turn costs wall-clock
# and rate limit, and a 40 KB tool manifest re-sent every turn buys nothing the
# runner does not already inject through --append-system-prompt. The caller's
# standing context keeps its HEAD (instructions lead); the history keeps its
# TAIL (the recent turns are what the next line answers).
#
#   CORTEX_MOUTH_CONTEXT        full (default) | last   — "last" is the old behaviour
#   CORTEX_MOUTH_SYSTEM_CHARS   caller's standing-context budget, default 6000
#   CORTEX_MOUTH_HISTORY_CHARS  prior-turn budget,                default 24000
CONTEXT_MODE = os.environ.get("CORTEX_MOUTH_CONTEXT", "full").strip().lower()
SYSTEM_CHARS = int(os.environ.get("CORTEX_MOUTH_SYSTEM_CHARS", "6000") or 0)
HISTORY_CHARS = int(os.environ.get("CORTEX_MOUTH_HISTORY_CHARS", "24000") or 0)

ROLE_LABEL = {"user": "OPERATOR", "assistant": "YOU, EARLIER", "tool": "TOOL RESULT"}


def _flatten(content) -> str:
    """Either wire form of a message body, as plain text."""
    if isinstance(content, list):                 # the content-parts form
        return "".join(p.get("text", "") for p in content if isinstance(p, dict)).strip()
    return str(content or "").strip()


def _clip(text: str, budget: int, keep: str) -> str:
    """Trim to budget on a line boundary, saying so where the cut happened, so
    the seat never mistakes a truncation for the operator changing the subject."""
    if budget <= 0 or len(text) <= budget:
        return text
    if keep == "head":
        cut = text[:budget]
        nl = cut.rfind("\n")
        return (cut[:nl] if nl > budget // 2 else cut) + "\n…(trimmed here)…"
    cut = text[-budget:]
    nl = cut.find("\n")
    return "…(earlier turns trimmed)…\n" + (cut[nl + 1:] if 0 <= nl < 400 else cut)


def _seat_soul(agent: str) -> str:
    """The identity the RUNNER will inject for this seat, read fresh so an edit
    to a SOUL takes effect on the next turn with nothing to restart."""
    if not agent:
        return ""
    try:
        with io.open(os.path.join(ROOT, "agents", agent, "SOUL.md"), encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _drop_duplicate_soul(system: str, agent: str) -> str:
    """cortex-run.sh already hands this seat its SOUL through
    --append-system-prompt. A caller that carries the same file in its own system
    prompt — Hermes does, it leads with SOUL.md — would send those 7 KB twice in
    every single turn, and the duplicate crowds out the part that is actually
    unique to the caller: memory, the user profile, the environment notes it
    appends underneath. So the duplicated prefix is dropped and the remainder,
    which is the only part the runner does not already know, is kept whole."""
    soul = _seat_soul(agent)
    if not soul or not system.startswith(soul[:300]):
        return system
    cut, n = 0, min(len(soul), len(system))
    while cut < n and soul[cut] == system[cut]:
        cut += 1
    rest = system[cut:].lstrip()
    if not rest:
        return ""
    return ("(this seat's SOUL is already loaded by the runner; what follows is "
            "what the caller added on top of it)\n\n") + rest


def conversation_text(messages, agent: str = "") -> str:
    """The whole thread as one prompt: standing context, history, then the line
    to answer. Identical to latest_user_text() for a single-message request, so
    every caller that worked before this existed still sees the same behaviour."""
    msgs = [m for m in (messages or []) if isinstance(m, dict)]
    last = latest_user_text(msgs)
    if CONTEXT_MODE == "last" or not last:
        return last

    system = "\n\n".join(t for t in (_flatten(m.get("content"))
                                     for m in msgs if m.get("role") == "system") if t)
    system = _drop_duplicate_soul(system, agent)
    here = max((i for i, m in enumerate(msgs) if m.get("role") == "user"), default=-1)
    history = []
    for m in msgs[:here]:
        role = m.get("role")
        if role == "system":
            continue
        body = _flatten(m.get("content"))
        if body:
            history.append("%s: %s" % (ROLE_LABEL.get(role, role or "note"), body))

    if not system and not history:
        return last                               # a one-shot call, unchanged

    parts = []
    if system:
        parts.append("--- standing context from the caller ---\n" + _clip(system, SYSTEM_CHARS, "head"))
    if history:
        parts.append("--- the conversation so far ---\n" + _clip("\n\n".join(history), HISTORY_CHARS, "tail"))
    parts.append("--- the message to answer now ---\n" + last)
    return "\n\n".join(parts)

# ── Continuity: one Claude session per conversation, resumed ────────────────
# Flattening the thread (above) makes a fresh session coherent. It does not
# make it CONTINUOUS: the seat still starts every turn from zero, re-reads the
# whole thread, and forgets what it read and did last time. Claude Code can
# resume a session by id, and a resumed session keeps everything — tool output,
# files it read, its own reasoning — in a window far larger than anything a
# caller would re-send. So the relay keeps, per seat, a map from the caller's
# conversation to the Claude session that IS that conversation, and resumes it.
#
# Identity is derived, because an OpenAI-shaped request carries none: the key
# is the conversation's opening line. Continuity is CHECKED, not assumed: the
# caller's last assistant message must contain the tail of what this relay last
# returned for that session. If it does not — a different thread that opened
# with the same words, a caller that rewrote history, a session we lost — the
# turn falls back to a fresh session rehydrated from the caller's thread, which
# is exactly what happened on every turn before this existed. Nothing regresses.
STATELESS = {"scribe", "greta"}                                   # seats that never keep a session
SESSION_MAX_TURNS = int(os.environ.get("CORTEX_SESSION_MAX_TURNS", "400") or 400)
SESSION_MAX_AGE = int(os.environ.get("CORTEX_SESSION_MAX_AGE_S", str(14 * 86400)) or 14 * 86400)
SESSION_KEEP = 60                                        # conversations remembered per seat
# How long a caller waits for a busy seat before being told so. Generous enough
# that an ordinary turn ahead of you never trips it; short enough that nobody
# queues behind a 90-minute deep turn until their own client gives up and retries.
LOCK_WAIT = int(os.environ.get("CORTEX_MOUTH_LOCK_WAIT", "600") or 600)
# Seconds of silence before the relay proves to the caller that the seat is still
# working. Hermes kills a local stream after 900s without a chunk, and a deep turn
# spends far longer than that inside tools where no text flows. An empty delta
# stamps liveness without counting as delivered text, so the caller neither hangs
# up nor decides the reply already happened.
HEARTBEAT_S = int(os.environ.get("CORTEX_MOUTH_HEARTBEAT_S", "30") or 30)
_seat_locks, _seat_locks_guard, _sessions_guard = {}, threading.Lock(), threading.Lock()


def seat_lock(agent):
    """Two turns of one seat must not resume the same session at once."""
    with _seat_locks_guard:
        return _seat_locks.setdefault(agent, threading.Lock())


# A message refused while the seat is busy is spooled here and carried into the
# next turn on that seat. Bounded on both count and size: a spool that can grow
# without limit is a way to blow up the next prompt, and the point of this is to
# keep the operator's words, not to keep every retry a client ever made.
PENDING_MAX = int(os.environ.get("CORTEX_MOUTH_PENDING_MAX", "5") or 5)
PENDING_CHARS = int(os.environ.get("CORTEX_MOUTH_PENDING_CHARS", "6000") or 6000)
_pending_guard = threading.Lock()


def pending_path(agent):
    return os.path.join(ROOT, "agents", agent, "pending.jsonl")


# Hermes titles a chat by asking the SAME seat for a name, which arrives here as
# an ordinary request: it takes the seat lock, burns a full turn, and — once the
# spool existed — drained the operator's held message into a title generator that
# answers in JSON and then discards it. Six of these ran on this seat on
# 2026-09-19 alone, one of them for 498 s. A subcall is machinery talking to
# machinery; it must not consume anything meant for the operator, and it must
# never move his gear.
TITLE_MARKERS = ("you name chat sessions", "write a title that lets")


def is_subcall(text):
    low = (text or "").lower()
    return any(m in low for m in TITLE_MARKERS)


def spool_pending(agent, text):
    """Keep a busied-out message for the next turn. Never raises: losing the
    message is bad, taking the relay down with it is worse."""
    text = (text or "").strip()
    if not text:
        return False
    try:
        p = pending_path(agent)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with _pending_guard:
            rows = _read_pending(p)
            # Dedupe against what was already DELIVERED as well as what is still
            # waiting. The spool alone is the wrong window: the drain empties it,
            # so a client retrying the same text a minute later spools it again
            # and the operator's words arrive twice.
            recent = [r.get("text") for r in _read_pending(p + ".drained")[-PENDING_MAX * 4:]]
            if any(r.get("text") == text for r in rows) or text in recent:
                return True                      # a client retrying is not a new message
            rows.append({"at": time.time(), "text": text[:PENDING_CHARS]})
            rows = rows[-PENDING_MAX:]
            tmp = p + ".tmp"
            with open(tmp, "w") as f:
                for r in rows:
                    f.write(json.dumps(r) + "\n")
            os.replace(tmp, p)
        return True
    except Exception as e:
        log(f"spool_pending {agent}: {type(e).__name__}: {e}")
        return False


def _read_pending(p):
    rows = []
    try:
        with open(p) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except Exception:
                        pass
    except FileNotFoundError:
        pass
    return rows


def drain_pending(agent):
    """Take everything spooled for this seat and clear it. Cleared on read, not
    on success: a message replayed forever because a later turn failed would be
    worse than one lost, and the operator can always say it again."""
    try:
        p = pending_path(agent)
        with _pending_guard:
            rows = _read_pending(p)
            if not rows:
                return []
            # APPEND to the delivered history, never replace it. os.replace()
            # kept exactly one generation, so the only copy of an earlier message
            # was destroyed by the next drain — and that history is also the
            # dedupe window, so clobbering it brings the double-delivery back.
            try:
                hist = _read_pending(p + ".drained")[-PENDING_MAX * 8:] + rows
                tmp = p + ".drained.tmp"
                with open(tmp, "w") as f:
                    for r in hist:
                        f.write(json.dumps(r) + "\n")
                os.replace(tmp, p + ".drained")
            except Exception as e:
                log(f"drain_pending history {agent}: {type(e).__name__}: {e}")
            try:
                os.unlink(p)
            except Exception:
                open(p, "w").close()
        return [r.get("text", "") for r in rows if r.get("text")]
    except Exception as e:
        log(f"drain_pending {agent}: {type(e).__name__}: {e}")
        return []


# Hermes CONSUMES these lines: it strips them out and acts on them (sends the
# file, makes the audio a voice bubble). So the reply it carries back in the next
# request is NOT the reply we recorded — and the continuity check, which compares
# the two, declared a brand-new session every time this seat sent a file. That
# cost a full re-flatten of the thread and a cold prompt cache on exactly the
# turns that had just done the most work. Measured 2026-09-19: the turn after an
# audio clip logged `tail-mismatch` and took 1361 s.
# Leading whitespace, and \r before the newline: re.M's `$` matches only before
# \n, and \r is not absorbed by \S* or [ \t]*, so a CRLF caller slipped the whole
# fix. Found in review 2026-09-19 — `_norm("x\r\nMEDIA:/a.ogg\r\ny")` left the
# directive in place and the 1361 s cold session came straight back.
_DIRECTIVE = re.compile(
    r"^[ \t]*(?:MEDIA:\S*|!\[[^\]]*\]\([^)]*\)|\[\[[A-Za-z0-9_]+\]\])[ \t\r]*$", re.M)


def _norm(text) -> str:
    t = _DIRECTIVE.sub(" ", str(text or ""))
    return re.sub(r"\s+", " ", t).strip()


def _reply_tail(text) -> str:
    n = _norm(text)
    return n[-400:] if len(n) > 400 else n


def _reply_head(text) -> str:
    """A second anchor from the FRONT of the reply. Telegram splits anything over
    ~4000 chars, and a caller may carry back only one piece; a compactor may keep
    only the opening. One anchor at each end means continuity survives either."""
    n = _norm(text)
    return n[:400] if len(n) > 900 else ""


def _continues(entry, prev: str, strict: bool = False) -> bool:
    """True when `prev` (the reply the caller is carrying) is recognisably the
    reply we recorded for `entry`.

    strict=True uses the TAIL ONLY. Review 2026-09-19 demonstrated the head
    anchor cross-wiring two different conversations: two threads whose replies
    share a 400-char opening, the second one compacted so its key changes, and
    the re-filing scan below hands thread B thread A's session — then pops A's
    entry, destroying it. Endings differ far more than openings (measured over
    53 real replies: longest shared opening 20 chars, longest shared tail 39),
    and compaction keeps the END of a thread, which is exactly what re-filing is
    for. So the scan across OTHER conversations is tail-only; the head anchor is
    kept for the direct same-key check, where there is no other thread to confuse
    it with."""
    if not prev or not entry:
        return False
    keys = ("tail",) if strict else ("tail", "head")
    for k in keys:
        a = entry.get(k)
        if a and a in prev:
            return True
    return False


def sessions_path(agent) -> str:
    return os.path.join(ROOT, "agents", agent, "sessions.json")


def load_sessions(agent) -> dict:
    try:
        with io.open(sessions_path(agent), encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("conversations"), dict):
            return d
    except Exception:
        pass
    return {"conversations": {}, "live": ""}


def save_sessions(agent, data) -> None:
    path = sessions_path(agent)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".sessions-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def conversation_key(agent, msgs) -> str:
    first = next((m for m in msgs if m.get("role") == "user"), None)
    opening = _norm(_flatten(first.get("content")) if first else "")[:400]
    return hashlib.sha1((agent + "|" + opening).encode("utf-8")).hexdigest()[:20]


def last_assistant_text(msgs) -> str:
    for m in reversed(msgs):
        if m.get("role") == "assistant":
            return _flatten(m.get("content"))
    return ""


def plan_session(agent, msgs):
    """resume the session that IS this conversation, or start one. None = stateless seat."""
    if agent in STATELESS:
        return None
    key = conversation_key(agent, msgs)
    conv = load_sessions(agent)["conversations"]
    entry = conv.get(key)
    prev = _norm(last_assistant_text(msgs))
    # The key is an index; the TAIL is the identity. When Hermes compacts a long
    # thread it rewrites the opening line the key was made from, so the key changes
    # while the conversation does not. Before declaring a new thread, look for the
    # one whose last reply the caller is still carrying and re-file it under the
    # new key. Continuity then survives compaction — the moment a long thread
    # needs it most — instead of ending exactly there.
    if prev and not _continues(entry, prev):
        # Newest first: if more than one stored conversation could claim this
        # reply, the most recently touched one is the live thread.
        others = sorted(conv.items(), key=lambda kv: float(kv[1].get("last_ts") or 0), reverse=True)
        for k2, e2 in others:
            if k2 != key and _continues(e2, prev, strict=True):
                with _sessions_guard:
                    data = load_sessions(agent)
                    moved = data["conversations"].pop(k2, None)
                    if moved:
                        data["conversations"][key] = moved
                        save_sessions(agent, data)
                entry = moved or entry
                break
    now = time.time()
    why = "new-thread"
    if entry and entry.get("sid"):
        if not prev:
            why = "no-history"
        elif not _continues(entry, prev):
            why = "tail-mismatch"
        elif int(entry.get("turns", 0)) >= SESSION_MAX_TURNS:
            why = "rotated-turns"
        elif now - float(entry.get("created_ts", now)) >= SESSION_MAX_AGE:
            why = "rotated-age"
        else:
            return {"mode": "resume", "sid": entry["sid"], "key": key, "turn": int(entry.get("turns", 0)) + 1, "why": "continuity"}
    return {"mode": "new", "sid": str(uuid.uuid4()), "key": key, "turn": 1, "why": why}


def checkpoint_sid(agent) -> str:
    """The session the runner actually used — authoritative, because a failed
    resume makes the runner fall back to a fresh id of its own."""
    try:
        with io.open(os.path.join(ROOT, "agents", agent, "checkpoint.state"), encoding="utf-8") as f:
            for line in f:
                if line.startswith("SID="):
                    return line[4:].strip()
    except Exception:
        pass
    return ""


def record_session(agent, plan, out, model="") -> str:
    """Store the turn against its conversation and return the session id actually used."""
    if not plan:
        return ""
    sid = checkpoint_sid(agent) or plan["sid"]
    with _sessions_guard:
        data = load_sessions(agent)
        conv = data["conversations"]
        e = conv.get(plan["key"]) if plan["mode"] == "resume" else None
        now = time.time()
        if not e or e.get("sid") != sid:
            e = {"sid": sid, "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "created_ts": now, "turns": 0}
        e.update({"sid": sid, "tail": _reply_tail(out), "head": _reply_head(out),
                  "turns": int(e.get("turns", 0)) + 1,
                  "last": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "last_ts": now, "model_last": model})
        conv[plan["key"]] = e
        data["live"] = plan["key"]
        stored = sid
        if len(conv) > SESSION_KEEP:                     # forget the oldest threads
            for k in sorted(conv, key=lambda k: float(conv[k].get("last_ts", 0)))[:len(conv) - SESSION_KEEP]:
                del conv[k]
        save_sessions(agent, data)
    return stored


# ── Modes: the operator's words move the gear lever ──────────────────────────
# "motus max" in a Telegram message is an instruction, not a topic. The relay
# hears it on the message being answered NOW, sets the mode through the one CLI
# that owns modes (motus-mode.sh, so there is exactly one definition of what a
# mode is), and prepends a line so the seat acknowledges the shift in its
# reply. The runner reads the same file and applies model/effort/turns.
MODES_FILE = os.path.expanduser("~/.cortexinsight/modes.json")
MODE_CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "motus-mode.sh")
MODE_RULES = (
    # OFF is matched FIRST: "seekdepth mode off" contains "seekdepth mode", so
    # scanning in the other order would turn it back on.
    ("cruise",    re.compile(r"\bseek[\s-]?depth(?:\s+mode)?\s+off\b|\bturn\s+off\s+seek[\s-]?depth\b|\bmain\s+mode\b", re.I)),
    ("seekdepth", re.compile(r"\b(?:activate\s+|switch\s+to\s+)?seek[\s-]?depth(?:\s+mode)?\b", re.I)),
    ("max",     re.compile(r"\bmotus\s+(?:motivus\s+)?max(?:\s+mode)?\b", re.I)),
    ("motivus", re.compile(r"\bmotus\s+motivus(?:\s+mode)?\b", re.I)),
    # "cool down" needs a separator: "add a cooldown" is a sentence about code,
    # not an instruction to drop out of a deep session for two hours.
    ("cruise",  re.compile(r"\bmotus\s+(?:cruise|normal|cool)(?:\s+mode)?\b|\bcool[\s-]+down\b", re.I)),
)
SLASH_MODE = re.compile(r"^\s*/motus\s+(max|motivus|seekdepth|cruise|normal|cool|main)\b", re.I | re.M)
DEEP_TIMEOUT = int(os.environ.get("CORTEX_MOUTH_TIMEOUT_DEEP", "5400") or 5400)


def detect_mode(text):
    m = SLASH_MODE.search(text or "")
    if m:
        w = m.group(1).lower()
        return "cruise" if w in ("normal", "cool", "main") else w
    for mode, rx in MODE_RULES:
        if rx.search(text or ""):
            return mode
    return None


def apply_mode_trigger(agent, text):
    """Set the mode the operator just asked for. Returns (line for the prompt, info)."""
    mode = detect_mode(text)
    if not mode or not os.path.exists(MODE_CLI):
        return "", None
    try:
        p = subprocess.run(["bash", MODE_CLI, agent, mode, "--by", "telegram", "--note", (text or "")[:160]],
                           capture_output=True, text=True, timeout=15)
        info = json.loads(p.stdout.strip().splitlines()[-1]) if p.returncode == 0 and p.stdout.strip() else None
    except Exception as e:                                          # noqa: BLE001
        log(f"MODE {agent} could not set {mode}: {type(e).__name__}: {e}")
        return "", None
    if not info:
        return "", None
    until = info.get("until") or "you say otherwise"
    line = (f"[MODE ⇒ {info.get('label')} · {info.get('model')} · effort {info.get('effort')} · "
            f"{info.get('turns')} turns · until {until}]")
    log(f"MODE {agent} ⇒ {info.get('mode')} ({info.get('model')}, {info.get('effort')}) by telegram")
    return line, info


def current_mode(agent) -> dict:
    """The mode in force for this seat, expiry honoured. Read, never written, here."""
    try:
        e = (json.load(open(MODES_FILE)) or {}).get(agent) or {}
        if e.get("mode") in (None, "", "cruise"):
            return {}
        until = e.get("until")
        # timegm, not mktime: the stamp is UTC and mktime would apply local DST,
        # expiring a mode an hour early on any box not running in UTC.
        if until and calendar.timegm(time.strptime(until, "%Y-%m-%dT%H:%M:%SZ")) <= time.time():
            return {}
        return e
    except Exception:
        return {}


def turn_timeout(agent) -> int:
    return DEEP_TIMEOUT if current_mode(agent).get("deep") else TIMEOUT


# ── Images: saved to disk, seen through the Read tool ───────────────────────
# The seat cannot be handed pixels through this wire, but it can read a file.
# So an image the caller attaches is written to the seat's inbox and the prompt
# says where it is. If the caller already named a local path (Hermes does, as
# "[Image attached: /path]"), that path is used and nothing is decoded twice.
IMG_PATH_RX = re.compile(r"\[Image attached: (/[^\]\n]+)\]")
INBOX_KEEP = 200
INBOX_MAX_BYTES = 20 * 1024 * 1024
_EXT = {"image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}


def _inbox(agent) -> str:
    d = os.path.join(ROOT, "agents", agent, "inbox")
    os.makedirs(d, exist_ok=True)
    return d


def _save_data_url(agent, url, n) -> str:
    try:
        head, payload = url.split(",", 1)
        mime = head[5:].split(";", 1)[0].strip().lower()
        ext = _EXT.get(mime)
        if not ext:
            return ""
        raw = base64.b64decode(payload, validate=False)
        if not raw or len(raw) > INBOX_MAX_BYTES:
            return ""
        d = _inbox(agent)
        path = os.path.join(d, time.strftime("%Y%m%d-%H%M%S") + f"-{n}.{ext}")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        files = sorted(os.listdir(d))
        for old in files[:max(0, len(files) - INBOX_KEEP)]:
            try:
                os.unlink(os.path.join(d, old))
            except OSError:
                pass
        return path
    except Exception:
        return ""


def harvest_images(agent, msgs):
    """Image references from the LAST user message only, as prompt lines."""
    last = next((m for m in reversed(msgs) if m.get("role") == "user"), None)
    if not last:
        return []
    content = last.get("content")
    text = _flatten(content)
    named = [p for p in IMG_PATH_RX.findall(text) if os.path.isfile(p)]
    parts = [p for p in content if isinstance(p, dict) and p.get("type") == "image_url"] if isinstance(content, list) else []
    refs = list(named)
    if len(named) < len(parts):                          # something was not named: decode it
        n = 0
        for p in parts:
            url = str((p.get("image_url") or {}).get("url") or "")
            if url.startswith("data:"):
                saved = _save_data_url(agent, url, n)
                n += 1
                if saved:
                    refs.append(saved)
            elif url.startswith("/") and os.path.isfile(url) and url not in refs:
                refs.append(url)
            elif url.startswith("http"):
                refs.append(url)
    return [f"[image attached: {r} — view it with the Read tool]" for r in refs]


def _pump(path, offset, on_delta) -> int:
    """Relay whatever the runner has written since `offset`. A file that SHRANK
    means the runner retried and truncated it, so reset rather than replay."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return offset
    if size < offset:
        offset = 0
        on_delta("\n\n")
    if size == offset:
        return offset
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            f.seek(offset)
            new = f.read()
    except OSError:
        return offset
    if new:
        on_delta(new.replace(SEP, "\n\n"))
    return offset + len(new.encode("utf-8"))


def attempt(agent, msg, env, on_delta, timeout=None, on_beat=None):
    """One turn. Without on_delta this blocks until the runner is done; with it,
    the runner streams to a temp file and we relay the words as they land, and
    prove liveness with on_beat when no words have landed for a while."""
    timeout = timeout or TIMEOUT
    if on_delta is None or os.path.exists(STREAM_OFF):
        p = subprocess.Popen(["bash", RUNNER, agent], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
        try:
            out, _ = p.communicate(msg, timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(p)
            _ckpt_mark(agent, "incomplete")
            raise
        return p.returncode, (out or "").strip(), ""

    fd, spath = tempfile.mkstemp(prefix=f"cortex-stream-{agent}-", suffix=".txt")
    os.close(fd)
    env = dict(env)
    env["CORTEX_STREAM_FILE"] = spath
    streamed = []

    def sink(text):
        streamed.append(text)
        on_delta(text)

    proc = subprocess.Popen(["bash", RUNNER, agent], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env,
                            start_new_session=True)      # its own process group, so a kill reaches claude too
    box = {}

    def feed():
        try:
            proc.stdin.write(msg)
            proc.stdin.close()
        except Exception:
            pass

    def drain():
        # stdout on its own thread: a reply bigger than the pipe buffer would
        # otherwise wedge the child while we sit here tailing the stream file.
        try:
            box["out"] = proc.stdout.read()
        except Exception:
            box["out"] = ""

    threading.Thread(target=feed, daemon=True).start()
    threading.Thread(target=drain, daemon=True).start()

    offset, deadline = 0, time.time() + timeout
    last_activity = time.time()
    try:
        while True:
            finished = proc.poll() is not None
            new_offset = _pump(spath, offset, sink)
            if new_offset != offset:
                offset, last_activity = new_offset, time.time()
            if finished:
                break
            now = time.time()
            if now > deadline:
                _kill_tree(proc)
                _ckpt_mark(agent, "incomplete")
                raise subprocess.TimeoutExpired(RUNNER, timeout)
            if on_beat is not None and now - last_activity >= HEARTBEAT_S:
                on_beat()                                # "still here" — an empty delta, no text
                last_activity = now
            time.sleep(STREAM_POLL)
        for _ in range(8):
            if "out" in box:
                break
            time.sleep(0.05)
        return proc.returncode, (box.get("out") or "").strip(), "".join(streamed)
    finally:
        try:
            os.unlink(spath)
        except OSError:
            pass


# A turn that comes back rc=0 with a sentence about being signed out is a turn
# that FAILED, and the first version of this file recorded it as OK. That is the
# worst possible outcome: the clean rate stays at 100%, the console shows a
# healthy fleet, and every agent has been mute since the token expired. These are
# the shapes the CLI produces when the problem is the operator's session rather
# than the question, and each one gets an answer that says what to do about it.
NOT_REALLY_OK = (
    ("failed to authenticate", "auth"),
    ("oauth session expired", "auth"),
    ("please run /login", "auth"),
    ("invalid api key", "auth"),
    ("credit balance is too low", "billing"),
    ("usage limit reached", "limit"),
    # The CLI's other way of saying the same thing. On 2026-09-19 an 84-minute
    # turn returned exactly this, 52 characters, and the relay logged it OK —
    # a total outage that read as a clean day.
    #
    # It must be the CLI's whole phrase, not the bare words "session limit". A
    # review caught the first cut of this matching "Done — session limit bumped,
    # gates green" and replacing that real answer with an outage notice. Every
    # pattern here has to be something a seat would never say on purpose; this
    # seat discusses session limits often, so the generic form is a trap.
    ("hit your session limit", "limit"),
    ("reached your session limit", "limit"),
    # The runner's own "gave up" sentence. It exits 0 so the caller gets a reply,
    # and for a while this relay took that reply for a success and logged OK.
    ("could not complete (transient failure", "runner"),
)

WHAT_TO_DO = {
    "auth": ("This machine is signed out of Claude Code, so no turn can run. Sign it back in with:\n"
             "  claude setup-token\n"
             "then save the token it prints:\n"
             "  umask 077; printf '%s' '<the-token>' > ~/.claude/cortex-oauth-token\n"
             "and restart the relay:  systemctl --user restart cortex-relay"),
    "billing": "The account behind this subscription cannot run turns right now (billing). Nothing was spent here.",
    "limit": "This subscription has hit its usage limit for now. The turn was not run; try again when the window resets.",
    "runner": ("The seat tried this turn three times and could not finish it. Nothing was billed. "
               "The reason is in /root/cortex/logs/runner-stderr/<seat>-<date>.log; send the message again in a moment."),
}


def real_failure(out: str):
    low = (out or "").strip().lower()
    if len(low) > 400:                      # a long answer is an answer, not an error
        return None
    for needle, kind in NOT_REALLY_OK:
        if needle in low:
            return kind
    return None


def tail_of(final, streamed) -> str:
    """What the caller is still owed. If the words were streamed live, the final
    answer IS the tail of that stream and nothing is owed. If the runner replaced
    it (a cap, an auth failure, a graceful refusal) the two diverge, and that
    replacement is exactly what the operator needs to read."""
    if not streamed:
        return final
    if final and streamed.rstrip().endswith(final.rstrip()):
        return ""
    return ("\n\n" + final) if final else ""


def relay(agent, msg, on_delta=None, plan=None, extra=None, on_beat=None) -> str:
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)        # subscription only, never a billed key
    env["CORTEX_ROOT"] = ROOT
    if plan:
        env["CORTEX_SESSION_ID"] = plan["sid"]
        env["CORTEX_SESSION_MODE"] = plan["mode"]
    timeout = turn_timeout(agent)
    meta = dict(extra or {})
    if plan:
        meta["session"] = {"sid": plan["sid"], "mode": plan["mode"], "turn": plan["turn"], "why": plan["why"]}
    t0 = time.time()
    timed_out = False
    n = 0
    for n in range(RETRIES + 1):
        try:
            rc, out, streamed = attempt(agent, msg, env, on_delta, timeout, on_beat)
            if out.startswith("[paused]"):
                # The operator turned the fleet off. Never retried: a pause will
                # not clear on its own, and a swallowed message must not log as OK.
                latency = round(time.time() - t0, 1)
                log(f"PAUSED {agent} ({latency}s)")
                log_interaction(agent, msg, out, "PAUSED", latency, n + 1, meta)
                return tail_of(out, streamed)
            if rc == 0 and out:
                latency = round(time.time() - t0, 1)
                kind = real_failure(out)
                if kind:
                    # Never retried: a signed-out machine will still be signed
                    # out in three seconds, and retrying only delays the truth.
                    said = WHAT_TO_DO.get(kind, out)
                    log(f"{kind.upper()}-FAIL {agent} ({latency}s): {out[:120]}")
                    log_interaction(agent, msg, said, kind.upper(), latency, n + 1, meta)
                    return said
                # Log the session that was ACTUALLY used, not the one we proposed. On a
                # new turn the runner mints its own id (it must, so a retry cannot
                # collide with a registered one), so the planned id is not the id on
                # disk — and a log line naming a session with no transcript behind it
                # is worse than logging no session at all.
                try:
                    used = record_session(agent, plan, out, meta.get("model", ""))
                except Exception as e:                            # noqa: BLE001
                    # A full disk must never cost a finished answer. Lose the
                    # bookkeeping, keep the reply, say so in the log.
                    log(f"WARN {agent} could not record session: {type(e).__name__}: {e}")
                    used = ""
                if plan and used:
                    meta["session"]["sid"] = used                 # the console must not chase a ghost id
                log(f"OK {agent} {len(out)}c in {latency}s (attempt {n + 1})"
                    + (f" [{plan['mode']} {(used or plan['sid'])[:8]} t{plan['turn']}]" if plan else ""))
                log_interaction(agent, msg, out, "OK", latency, n + 1, meta)
                return tail_of(out, streamed)
            log(f"retry {agent} rc={rc} empty={not out} (attempt {n + 1})")
        except subprocess.TimeoutExpired:
            # A turn that ran out the clock is a SLOW failure, and re-running it
            # is the one thing guaranteed not to help: a 90-minute deep turn
            # retried twice is four and a half hours of a seat that answers no
            # one. The runner's own retry policy already knows this (a slow
            # failure is not a flake); this loop must not undo that from above.
            log(f"TIMEOUT {agent} after {timeout}s (attempt {n + 1}) — not retried")
            timed_out = True
            break
        except Exception as e:                                  # noqa: BLE001
            log(f"ERROR {agent} {type(e).__name__}: {e} (attempt {n + 1})")
        time.sleep(2 * (n + 1))
    latency = round(time.time() - t0, 1)
    if timed_out:
        held = (f"This turn ran past its time limit ({timeout // 60} min) and was stopped rather "
                "than re-run. Nothing was billed and nothing was lost. If this was deep work, ask "
                "for a smaller piece of it; the limit itself is CORTEX_MOUTH_TIMEOUT_DEEP.")
        log(f"TIMEOUT-FAIL {agent} ({latency}s)")
        log_interaction(agent, msg, held, "TIMEOUT", latency, n + 1, meta)
        return held
    held = ("The relay could not complete this turn after every retry. Nothing was lost and no "
            "paid API was touched. Send it again in a moment; if it keeps happening, read "
            "/root/cortex/logs/mouth-proxy.log and the seat's runner-stderr log.")
    log(f"FINAL-FAIL {agent} ({latency}s)")
    log_interaction(agent, msg, held, "FAIL", latency, RETRIES + 1, meta)
    return held


def completion(agent, text):
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:24],
        "object": "chat.completion",
        "created": int(time.time()),
        "model": agent,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):          # the access log is ours, not the library's
        return

    def _json(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorised(self):
        """With a key set, it must be the first path segment. Without one, only
        loopback callers get here at all, because that is all we bind to."""
        if not KEY:
            return True, self.path
        parts = self.path.lstrip("/").split("/", 1)
        if parts and parts[0] == KEY:
            return True, "/" + (parts[1] if len(parts) > 1 else "")
        return False, self.path

    def do_GET(self):
        ok, path = self._authorised()
        if not ok:
            return self._json(404, {"error": "not found"})
        if path.rstrip("/").endswith("/health") or path.rstrip("/") in ("", "/health"):
            return self._json(200, {"status": "ok", "backend": "claude-code-cli-relay", "root": ROOT})
        if path.rstrip("/").endswith("/v1/models"):
            seats = ["davara", "davaris", "davari", "workhorse", "sympath-cortex", "arden", "august", "scribe", "greta"]
            return self._json(200, {"object": "list", "data": [{"id": "cortex-" + s, "object": "model"} for s in seats]})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        ok, path = self._authorised()
        if not ok:
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "that was not JSON"})

        agent = agent_from_model(body.get("model", ""))
        msgs = [m for m in (body.get("messages") or []) if isinstance(m, dict)]
        last = latest_user_text(msgs)
        stateful = agent not in STATELESS
        # A title subcall is machinery, not the operator: it may take the seat,
        # but it must not move his gear (the 2h TTL would start on a message he
        # never sent) and it must not drain his spool.
        subcall = is_subcall(_flatten(body.get("system")) + "\n" + "\n".join(
            _flatten(m.get("content")) for m in msgs))
        mode_line, mode_info = (apply_mode_trigger(agent, last)
                                if stateful and not subcall else ("", None))
        images = harvest_images(agent, msgs) if stateful else []
        if not last and not images:
            return self._json(400, {"error": "no user message"})
        plan = plan_session(agent, msgs)
        if plan and plan["mode"] == "resume":
            # The session already holds the thread. Send only what is new.
            text = "\n\n".join(x for x in [mode_line, last or "(see the attached image)"] + images if x)
        else:
            text = "\n\n".join(x for x in [mode_line, conversation_text(msgs, agent) or last] + images if x)
        extra = {"motus": (mode_info or current_mode(agent)).get("mode", "cruise") if stateful else "n/a",
                 "model": (mode_info or current_mode(agent)).get("model", "") if stateful else ""}
        lock = seat_lock(agent) if stateful else threading.Lock()
        # A stateful seat runs one turn at a time — one checkpoint, one resumed
        # session — so a caller arriving mid-turn waits. But not forever. Past
        # LOCK_WAIT it is told the seat is busy, plainly, instead of queueing
        # behind a 90-minute deep turn until its own client timeout fires and it
        # retries into the same queue, doubling work that nobody asked for twice.
        acquired = lock.acquire(timeout=LOCK_WAIT)
        if acquired:
            # Anything the operator said while this seat was busy goes in first,
            # labelled, so the seat answers it instead of reading it as its own
            # recap. Drained here and not earlier: a drain on the busy path would
            # empty the spool for a turn that never runs, losing exactly the
            # words this whole mechanism exists to keep.
            held = drain_pending(agent) if (stateful and not subcall) else []
            if held:
                text = ("--- SENT WHILE YOU WERE MID-TURN (answer these too) ---\n"
                        + "\n\n".join(held)
                        + "\n--- end held messages ---\n\n" + text)
                log(f"PENDING {agent}: carrying {len(held)} held message(s) into this turn")

            def run(**kw):
                return relay(agent, text, plan=plan, extra=extra, **kw)
        else:
            # "Nothing was lost" has to be made true, not asserted. Until
            # 2026-09-19 this branch discarded the caller's words outright: the
            # resume plan sends only the newest user line, so a message refused
            # here never reached the seat unless the continuity anchor happened
            # to break and force a cold re-flatten. It cost the operator an
            # angry message that arrived 19 minutes late by pure accident.
            # Spool it instead; the next turn on this seat carries it.
            spooled = spool_pending(agent, last or text)
            busy = (f"{agent} is mid-turn (deep work in progress) and could not take this message "
                    f"within {LOCK_WAIT // 60} minutes. "
                    + ("It is saved, and it will lead the next turn that seat takes."
                       if spooled else
                       "Send it again when that turn finishes.")
                    + " Say 'motus cruise' to keep future turns short.")
            log(f"BUSY {agent}: lock not acquired in {LOCK_WAIT}s spooled={spooled}")
            log_interaction(agent, text, busy, "BUSY", 0, 0, extra)

            def run(**kw):
                return busy

        try:
            if not body.get("stream"):
                return self._json(200, completion(agent, run()))

            # Server-sent events, so a gateway can show her thinking as it happens.
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            cid = "chatcmpl-" + uuid.uuid4().hex[:24]

            def chunk(delta, finish=None):
                payload = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
                           "model": agent, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                try:
                    self.wfile.write(b"data: " + json.dumps(payload).encode() + b"\n\n")
                    self.wfile.flush()
                except Exception:
                    pass

            chunk({"role": "assistant", "content": ""})
            owed = run(on_delta=lambda t: chunk({"content": t}), on_beat=lambda: chunk({}))
            if owed:
                chunk({"content": owed})
            chunk({}, "stop")
            try:
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except Exception:
                pass
        finally:
            if acquired:
                lock.release()


def main():
    os.makedirs(os.path.join(ROOT, "logs"), exist_ok=True)
    log(f"START cortex-mouth on 127.0.0.1:{PORT} root={ROOT} key={'yes' if KEY else 'no'}")
    print(f"relay listening on 127.0.0.1:{PORT}  (fleet tree: {ROOT})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
