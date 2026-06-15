#!/usr/bin/env python3
"""
run_cost.py — REAL per-agent / per-phase cost breakdown for a spec-analyze
Workflow run, reconstructed from the subagent transcript JSONL files.

WHY THIS EXISTS
---------------
Inside a Workflow script the only cost signal available is `budget.spent()`
(a WHOLE-TURN, OUTPUT-only, shared counter). `agent()` returns text/schema,
never usage. So the report agent can only print the output-token delta
(~200-240k for an 8-unit run) — which UNDERSTATES the true cost by ~5x because
input + cache reads (each agent re-reads its cached context every tool turn)
dominate. The harness DOES track per-agent usage, out-of-band, in:
  1. the /workflows TUI,
  2. the task-completion notification (`subagent_tokens`),  <- authoritative TOTAL
  3. the per-agent transcript files agent-*.jsonl.          <- this script reads #3
This is the DRIVER-side post-processing step the workflow itself cannot do.

USAGE
-----
  python3 workflows/run_cost.py <transcript-dir> [--notif-total N] [--md]

  <transcript-dir> = .../subagents/workflows/<runId>/   (printed when the
                     Workflow tool launches; also the task transcript dir).
  --notif-total N  = the `subagent_tokens` from the completion notification,
                     printed verbatim as the AUTHORITATIVE total for cross-check.
  --md             = emit a Markdown table (paste into the report's RR-5).

Token accounting (per unique assistant message.id, to avoid double-counting
streaming events): output_tokens, input_tokens (fresh, non-cached),
cache_creation_input_tokens, cache_read_input_tokens.
"""
import json, sys, glob, os, re

ROLE_PHASE = {
    "cartografo": "Context", "crawler": "Context",
    "analizzatore": "Analysis",
    "verifier": "Verification", "rework": "Verification",
    "ricognitore": "Reverse diff", "report": "Report",
}
PHASE_ORDER = ["Context", "Analysis", "Verification", "Reverse diff", "Report", "?"]


def _first_user_text(path):
    """Return the text of the first user message (the role prompt)."""
    with open(path) as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") != "user":
                continue
            msg = d.get("message") or {}
            c = msg.get("content")
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return " ".join(
                    b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"
                )
    return ""


def _label(prompt):
    """Map a role prompt to (role, label). Order matters: REWORK before ANALIZZATORE."""
    idx = ""
    m = re.search(r"index:\s*([0-9]+)", prompt) or re.search(r"section\s+([0-9]+)\s*-", prompt)
    if m:
        idx = m.group(1)
    if "ROLE: CARTOGRAFO" in prompt:
        return "cartografo", "cartografo"
    if "ROLE: CRAWLER" in prompt:
        return "crawler", "crawler"
    if "REWORK" in prompt:
        return "rework", f"rework:{idx or '??'}"
    if "ROLE: ANALIZZATORE" in prompt:
        return "analizzatore", f"analizzatore:{idx or '??'}"
    if "ROLE: VERIFIER" in prompt:
        return "verifier", f"verifier:{idx or '??'}"
    if "RICOGNITORE" in prompt:
        return "ricognitore", "ricognitore-inverso"
    if "ORCHESTRATOR - REPORT" in prompt or "ROLE: ORCHESTRATOR" in prompt:
        return "report", "report"
    return "?", "?"


def _agent_stats(path):
    seen = {}      # msgid -> usage dict (dedup streaming repeats; keep max output)
    tools = 0
    t0 = t1 = None
    with open(path) as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            ts = d.get("timestamp")
            if ts:
                t0 = ts if t0 is None else min(t0, ts)
                t1 = ts if t1 is None else max(t1, ts)
            msg = d.get("message")
            if not isinstance(msg, dict):
                continue
            for b in (msg.get("content") or []):
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    tools += 1
            u = msg.get("usage")
            mid = msg.get("id")
            if u and mid:
                prev = seen.get(mid)
                if prev is None or u.get("output_tokens", 0) >= prev.get("output_tokens", 0):
                    seen[mid] = u
    out = sum(u.get("output_tokens", 0) for u in seen.values())
    inp = sum(u.get("input_tokens", 0) for u in seen.values())
    cc = sum(u.get("cache_creation_input_tokens", 0) for u in seen.values())
    cr = sum(u.get("cache_read_input_tokens", 0) for u in seen.values())
    return dict(output=out, input=inp, cc=cc, cr=cr, tools=tools, t0=t0, t1=t1)


def _dur(t0, t1):
    if not t0 or not t1:
        return ""
    try:
        from datetime import datetime
        f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
        s = (f(t1) - f(t0)).total_seconds()
        return f"{int(s)//60}m{int(s)%60:02d}s"
    except Exception:
        return ""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    if not args:
        print(__doc__)
        sys.exit(2)
    td = args[0]
    notif = None
    for fl in flags:
        if fl.startswith("--notif-total"):
            m = re.search(r"(\d[\d_]*)", fl)
            if m:
                notif = int(m.group(1).replace("_", ""))
    md = "--md" in flags

    rows = []
    for f in sorted(glob.glob(os.path.join(td, "agent-*.jsonl"))):
        role, label = _label(_first_user_text(f))
        st = _agent_stats(f)
        st["role"], st["label"] = role, label
        st["phase"] = ROLE_PHASE.get(role, "?")
        st["fresh"] = st["input"] + st["cc"] + st["output"]      # billed write+fresh-read
        st["allread"] = st["fresh"] + st["cr"]                    # incl. cache reads
        rows.append(st)

    rows.sort(key=lambda r: (PHASE_ORDER.index(r["phase"]), r["label"]))
    G = {k: sum(r[k] for r in rows) for k in ("output", "input", "cc", "cr", "fresh", "allread", "tools")}

    def fmt(n):
        return f"{n:,}"

    if md:
        print("| Fase | Agente | output | input fresh | cache_create | cache_read | fresh tot | tool |")
        print("|---|---|--:|--:|--:|--:|--:|--:|")
        for r in rows:
            print(f"| {r['phase']} | {r['label']} | {fmt(r['output'])} | {fmt(r['input'])} | {fmt(r['cc'])} | {fmt(r['cr'])} | {fmt(r['fresh'])} | {r['tools']} |")
        print(f"| **TOT** | **{len(rows)} agenti** | **{fmt(G['output'])}** | **{fmt(G['input'])}** | **{fmt(G['cc'])}** | **{fmt(G['cr'])}** | **{fmt(G['fresh'])}** | **{G['tools']}** |")
        print()
        print(f"- **output-only** (≈ ciò che il report espone via `budget.spent()`): **{fmt(G['output'])}**")
        print(f"- **fresh billable** (input + cache_create + output): **{fmt(G['fresh'])}**")
        print(f"- **incl. cache reads** (input + cache_create + cache_read + output): **{fmt(G['allread'])}**")
        if notif is not None:
            print(f"- **notification `subagent_tokens`** (totale autorevole harness): **{fmt(notif)}**")
        return

    print(f"transcript dir: {td}")
    print(f"agenti: {len(rows)}")
    print(f"{'phase':<13}{'agent':<22}{'output':>10}{'in_fresh':>11}{'cache_cr':>12}{'cache_rd':>13}{'fresh':>11}{'tools':>7}{'time':>8}")
    cur = None
    for r in rows:
        if r["phase"] != cur:
            cur = r["phase"]
            print(f"-- {cur} " + "-" * 40)
        print(f"{'':<13}{r['label']:<22}{r['output']:>10,}{r['input']:>11,}{r['cc']:>12,}{r['cr']:>13,}{r['fresh']:>11,}{r['tools']:>7}{_dur(r['t0'],r['t1']):>8}")
    print("=" * 96)
    print(f"output-only (≈ budget.spent) .......... {G['output']:>13,}")
    print(f"fresh billable (in+cc+out) ............ {G['fresh']:>13,}")
    print(f"incl. cache reads (in+cc+cr+out) ...... {G['allread']:>13,}")
    print(f"tool uses ............................. {G['tools']:>13,}")
    if notif is not None:
        print(f"notification subagent_tokens (auth.) .. {notif:>13,}")


if __name__ == "__main__":
    main()
