#!/usr/bin/env python3
"""cortex-stream-parse.py — words as they are produced, and the same final answer.

`claude -p --output-format text` emits nothing at all until the whole turn is
over, so a relay in front of it can only ever fake streaming: block, then dump.
With stream-json and partial messages the deltas arrive as they are produced.

This reads that stream and does two things at once:
  · writes the live text to $CORTEX_STREAM_FILE, which the relay tails
  · prints ONLY the final answer to stdout, so every non-streaming caller sees
    exactly what it saw before

Contract:
  stdin   NDJSON from the CLI
  stdout  the final answer (empty and rc 1 if the turn produced none, so the
          runner's retry policy still sees a failure as a failure)
  \\x1e    a step boundary, which the relay renders as a paragraph break

Thinking is deliberately not streamed. Only text deltas are relayed: a model's
private reasoning is not the answer, and showing it as though it were would be
a small lie told very quickly.
"""
import json
import os
import sys

SEP = "\x1e"


def main() -> int:
    path = os.environ.get("CORTEX_STREAM_FILE", "")
    stream = None
    if path:
        try:
            # truncated on open, so a retried attempt never doubles up
            stream = open(path, "w", buffering=1, encoding="utf-8")
        except Exception:
            stream = None

    def emit(text: str) -> None:
        if stream and text:
            try:
                stream.write(text)
                stream.flush()
            except Exception:
                pass

    result = ""
    blocks = []                  # fallback assembly if no result event arrives
    wrote_any = False
    open_block = False

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue             # a non-JSON line is CLI noise, never fatal
        if not isinstance(ev, dict):
            continue
        etype = ev.get("type")

        if etype == "stream_event":
            inner = ev.get("event") or {}
            itype = inner.get("type")
            if itype == "content_block_start":
                cb = inner.get("content_block") or {}
                if cb.get("type") == "text":
                    # a new text block after earlier text means a new step
                    if wrote_any and not open_block:
                        emit(SEP)
                    open_block = True
            elif itype == "content_block_delta":
                delta = inner.get("delta") or {}
                if delta.get("type") == "text_delta":
                    t = delta.get("text") or ""
                    if t:
                        emit(t)
                        wrote_any = True
            elif itype == "content_block_stop":
                open_block = False

        elif etype == "assistant":
            msg = ev.get("message") or {}
            for part in msg.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "text":
                    blocks.append(part.get("text") or "")

        elif etype == "result":
            r = ev.get("result")
            if isinstance(r, str):
                result = r

    if stream:
        try:
            stream.close()
        except Exception:
            pass

    final = result or (blocks[-1] if blocks else "")
    if not final.strip():
        return 1
    sys.stdout.write(final)
    return 0


if __name__ == "__main__":
    sys.exit(main())
