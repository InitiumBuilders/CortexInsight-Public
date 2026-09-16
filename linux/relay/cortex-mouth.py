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
import json
import os
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


def log_interaction(agent, msg, out, status, latency, attempts) -> None:
    """The fleet's own record of the turn. The console reads this and nothing
    else, so the shape is a contract: keep the keys, keep local time."""
    try:
        os.makedirs(INTERACT_DIR, exist_ok=True)
        day = time.strftime("%Y-%m-%d")           # LOCAL day, like every stamp here
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        rec = {"ts": ts, "agent": agent, "status": status, "via": "mouth-proxy",
               "attempts": attempts, "latency_s": latency, "out_chars": len(out), "msg": msg}
        with open(f"{INTERACT_DIR}/{agent}-{day}.jsonl", "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        with open(f"{INTERACT_DIR}/{agent}-{day}.md", "a") as f:
            f.write(f"\n### {ts} · {agent} · {status} · {latency}s · {len(out)} chars\n"
                    f"**In:** {msg[:2000]}\n\n**Out:** {out[:6000]}\n\n---\n")
    except Exception:
        pass


def agent_from_model(model: str) -> str:
    """A caller names a model; we hear a seat. Longest, most specific first —
    'davaris' must never be read as 'davara'."""
    m = (model or "").lower()
    for name in ("sympath-cortex", "august-v3", "workhorse", "davaris", "davari", "davara", "arden", "august"):
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


def attempt(agent, msg, env, on_delta):
    """One turn. Without on_delta this blocks until the runner is done; with it,
    the runner streams to a temp file and we relay the words as they land."""
    if on_delta is None or os.path.exists(STREAM_OFF):
        p = subprocess.run(["bash", RUNNER, agent], input=msg, capture_output=True,
                           text=True, timeout=TIMEOUT, env=env)
        return p.returncode, (p.stdout or "").strip(), ""

    fd, spath = tempfile.mkstemp(prefix=f"cortex-stream-{agent}-", suffix=".txt")
    os.close(fd)
    env = dict(env)
    env["CORTEX_STREAM_FILE"] = spath
    streamed = []

    def sink(text):
        streamed.append(text)
        on_delta(text)

    proc = subprocess.Popen(["bash", RUNNER, agent], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
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

    offset, deadline = 0, time.time() + TIMEOUT
    try:
        while True:
            finished = proc.poll() is not None
            offset = _pump(spath, offset, sink)
            if finished:
                break
            if time.time() > deadline:
                proc.kill()
                raise subprocess.TimeoutExpired(RUNNER, TIMEOUT)
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
)

WHAT_TO_DO = {
    "auth": ("This machine is signed out of Claude Code, so no turn can run. Sign it back in with:\n"
             "  claude setup-token\n"
             "then save the token it prints:\n"
             "  umask 077; printf '%s' '<the-token>' > ~/.claude/cortex-oauth-token\n"
             "and restart the relay:  cortex relay restart"),
    "billing": "The account behind this subscription cannot run turns right now (billing). Nothing was spent here.",
    "limit": "This subscription has hit its usage limit for now. The turn was not run; try again when the window resets.",
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


def relay(agent, msg, on_delta=None) -> str:
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)        # subscription only, never a billed key
    env["CORTEX_ROOT"] = ROOT
    t0 = time.time()
    for n in range(RETRIES + 1):
        try:
            rc, out, streamed = attempt(agent, msg, env, on_delta)
            if out.startswith("[paused]"):
                # The operator turned the fleet off. Never retried: a pause will
                # not clear on its own, and a swallowed message must not log as OK.
                latency = round(time.time() - t0, 1)
                log(f"PAUSED {agent} ({latency}s)")
                log_interaction(agent, msg, out, "PAUSED", latency, n + 1)
                return tail_of(out, streamed)
            if rc == 0 and out:
                latency = round(time.time() - t0, 1)
                kind = real_failure(out)
                if kind:
                    # Never retried: a signed-out machine will still be signed
                    # out in three seconds, and retrying only delays the truth.
                    said = WHAT_TO_DO.get(kind, out)
                    log(f"{kind.upper()}-FAIL {agent} ({latency}s): {out[:120]}")
                    log_interaction(agent, msg, said, kind.upper(), latency, n + 1)
                    return said
                log(f"OK {agent} {len(out)}c in {latency}s (attempt {n + 1})")
                log_interaction(agent, msg, out, "OK", latency, n + 1)
                return tail_of(out, streamed)
            log(f"retry {agent} rc={rc} empty={not out} (attempt {n + 1})")
        except subprocess.TimeoutExpired:
            log(f"TIMEOUT {agent} after {TIMEOUT}s (attempt {n + 1})")
        except Exception as e:                                  # noqa: BLE001
            log(f"ERROR {agent} {type(e).__name__}: {e} (attempt {n + 1})")
        time.sleep(2 * (n + 1))
    latency = round(time.time() - t0, 1)
    held = ("The relay could not complete this turn after every retry. Nothing was lost and no "
            "paid API was touched. Send it again in a moment; if it keeps happening, run: cortex doctor")
    log(f"FINAL-FAIL {agent} ({latency}s)")
    log_interaction(agent, msg, held, "FAIL", latency, RETRIES + 1)
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
            seats = ["davara", "davaris", "davari", "workhorse", "sympath-cortex", "arden", "august", "august-v3"]
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
        text = latest_user_text(body.get("messages"))
        if not text:
            return self._json(400, {"error": "no user message"})

        if not body.get("stream"):
            return self._json(200, completion(agent, relay(agent, text)))

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
        owed = relay(agent, text, on_delta=lambda t: chunk({"content": t}))
        if owed:
            chunk({"content": owed})
        chunk({}, "stop")
        try:
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except Exception:
            pass


def main():
    os.makedirs(os.path.join(ROOT, "logs"), exist_ok=True)
    # The phrase matters: a console older than this file recognises a relay
    # starting by these exact words. Keeping them costs nothing and means a
    # desktop build that has not been updated still sees the relay come up.
    log(f"START cortex-mouth-proxy on 127.0.0.1:{PORT} root={ROOT} key={'yes' if KEY else 'no'}")
    print(f"relay listening on 127.0.0.1:{PORT}  (fleet tree: {ROOT})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
