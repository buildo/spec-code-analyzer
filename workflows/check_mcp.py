#!/usr/bin/env python3
"""
check_mcp.py — preflight: config + reachability of the vibingwithclaude MCP (stdlib only).

The MCP url/key are NEVER hardcoded in the workflow: the single source of truth is the root
`.env`. Behavior mirrors the Atlassian preflight (fetch_atlassian.py): if `.env` is missing it is
CREATED as a template and the run STOPS so you can fill it in; if present it is read.

Steps:
  1. Locate `.env` at the repo root (default: two levels up from this script; override --env-file).
     Missing -> write a template with all keys + ensure `.gitignore`, then EXIT 2 (blocking).
  2. Load MCP_URL + MCP_API_KEY (real environment overrides `.env`). Missing/empty -> EXIT 2.
  3. Sync the Claude MCP server registration FROM `.env` (idempotent `claude mcp add`), so a url/key
     change in `.env` propagates to the agents that reach the server by name. Best-effort + logged;
     skip with --no-register.
  4. Ping the endpoint (JSON-RPC `initialize`) to verify reachability + auth.
       reachable+authorized -> print OK, EXIT 0.
       unreachable/unauthorized -> print WARNING, EXIT 0 (NON-blocking: the workflow degrades to
       no-cache via useIndex, so a down MCP must never abort the whole analysis).
Also prints the resolved SPEC_OUTPUT_DIR (absolute) so the launcher can pass it as args.outputDir.

Exit codes: 0 = ok/degraded (proceed), 2 = blocking config problem (fill .env and re-run).
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

SERVER_NAME = "vibingwithclaude"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# All keys the project's single root .env is expected to carry. MCP_* + SPEC_OUTPUT_DIR are new;
# the ATLASSIAN_* keys are kept so one .env template covers the whole preflight.
ENV_TEMPLATE = """\
# spec-code-analyzer configuration — NOT committed (gitignored). Fill in and re-run the preflight.

# Atlassian (Confluence/Jira fetch — see workflows/fetch_atlassian.py)
ATLASSIAN_BASE_URL=https://<org>.atlassian.net
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_API_TOKEN=

# vibingwithclaude MCP knowledge-graph cache (see workflows/check_mcp.py, MCP-CACHE.md)
MCP_URL=https://mcp.vibingwithclaude.it/mcp
MCP_API_KEY=

# Where the workflow writes its output (absolute path recommended so it always lands here)
SPEC_OUTPUT_DIR=./output
"""


def load_env(path):
    """Parse a KEY=VALUE .env (ignoring comments/blanks, stripping surrounding quotes)."""
    env = {}
    if not os.path.isfile(path):
        return env
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def ensure_gitignore(root):
    """Make sure .env and the output dirs are gitignored (idempotent)."""
    gi = os.path.join(root, ".gitignore")
    have = ""
    if os.path.isfile(gi):
        with open(gi, encoding="utf-8") as fh:
            have = fh.read()
    want = [".env", "output/", "output-goals/", ".spec-analyze*"]
    missing = [w for w in want if w not in have.split()]
    if missing:
        with open(gi, "a", encoding="utf-8") as fh:
            if have and not have.endswith("\n"):
                fh.write("\n")
            fh.write("# spec-code-analyzer secrets & outputs\n" + "\n".join(missing) + "\n")


def create_template(path, root):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(ENV_TEMPLATE)
    os.chmod(path, 0o600)
    ensure_gitignore(root)


def sync_registration(url, key):
    """Idempotently register the MCP server from .env so nothing pins the url but .env."""
    if not _have_claude_cli():
        print("  ~ 'claude' CLI not found — skipping server registration sync "
              "(the workflow agents use whatever is already registered).", file=sys.stderr)
        return
    # remove any stale local registration, then add from .env (ignore remove failure)
    subprocess.run(["claude", "mcp", "remove", SERVER_NAME, "-s", "local"],
                   capture_output=True, text=True)
    add = subprocess.run(
        ["claude", "mcp", "add", "--transport", "http", SERVER_NAME, url,
         "--header", f"Authorization: Bearer {key}", "-s", "local"],
        capture_output=True, text=True)
    if add.returncode == 0:
        print(f"  + registered MCP server '{SERVER_NAME}' from .env (url={url}).", file=sys.stderr)
    else:
        print(f"  ! could not register '{SERVER_NAME}': {add.stderr.strip() or add.stdout.strip()}",
              file=sys.stderr)


def _have_claude_cli():
    try:
        subprocess.run(["claude", "--version"], capture_output=True, text=True)
        return True
    except (OSError, FileNotFoundError):
        return False


def ping(url, key, timeout=10):
    """JSON-RPC initialize against the MCP. Returns (ok, detail)."""
    payload = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "spec-analyze-preflight", "version": "1"},
        },
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
        # streamable-HTTP may answer as SSE: pull the first `data:` JSON line
        data = raw
        if "data:" in raw and not raw.lstrip().startswith("{"):
            for line in raw.splitlines():
                if line.startswith("data:"):
                    data = line[len("data:"):].strip()
                    break
        try:
            obj = json.loads(data)
        except ValueError:
            return True, "reachable (non-JSON body; MCP handshake accepted the request)"
        if isinstance(obj, dict) and obj.get("error"):
            return False, f"server returned error: {obj['error']}"
        info = (obj.get("result", {}) or {}).get("serverInfo", {}) if isinstance(obj, dict) else {}
        return True, f"reachable; serverInfo={info or '(none)'}"
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return False, f"HTTP {e.code} — auth rejected (check MCP_API_KEY)"
        return False, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return False, f"unreachable: {e.reason}"
    except Exception as e:  # noqa: BLE001 — preflight must never crash the caller
        return False, f"error: {e}"


def main():
    ap = argparse.ArgumentParser(description="Preflight config + reachability check for the MCP cache.")
    ap.add_argument("--env-file", default=os.path.join(REPO_ROOT, ".env"))
    ap.add_argument("--no-register", action="store_true", help="skip syncing the Claude MCP registration")
    ap.add_argument("--print-output-dir", action="store_true", help="only print resolved SPEC_OUTPUT_DIR and exit")
    args = ap.parse_args()

    env_path = args.env_file
    root = os.path.dirname(os.path.abspath(env_path)) or REPO_ROOT

    # Step 1 — .env presence (create template + stop if missing, like the Atlassian preflight)
    if not os.path.isfile(env_path):
        create_template(env_path, root)
        print(f"Created {env_path} template (and .gitignore). Fill in MCP_API_KEY / ATLASSIAN_* "
              f"/ SPEC_OUTPUT_DIR, then re-run the preflight.", file=sys.stderr)
        return 2

    env = load_env(env_path)
    # real environment overrides the file
    url = os.environ.get("MCP_URL") or env.get("MCP_URL", "")
    key = os.environ.get("MCP_API_KEY") or env.get("MCP_API_KEY", "")
    out_dir = os.environ.get("SPEC_OUTPUT_DIR") or env.get("SPEC_OUTPUT_DIR", "./output")
    out_abs = out_dir if os.path.isabs(out_dir) else os.path.normpath(os.path.join(root, out_dir))

    if args.print_output_dir:
        print(out_abs)
        return 0

    # Step 2 — required MCP config (blocking if incomplete)
    if not url or not key:
        missing = ", ".join(k for k, v in (("MCP_URL", url), ("MCP_API_KEY", key)) if not v)
        print(f"Incomplete MCP config in {env_path}: missing {missing}. Fill it and re-run.", file=sys.stderr)
        return 2

    print(f"MCP preflight — url={url}  ·  output-dir={out_abs}", file=sys.stderr)

    # Step 3 — sync registration from .env (so the url is pinned only in .env)
    if not args.no_register:
        sync_registration(url, key)

    # Step 4 — reachability (NON-blocking: the workflow degrades to no-cache if this fails)
    ok, detail = ping(url, key)
    if ok:
        print(f"  ✓ MCP reachable & authorized — {detail}", file=sys.stderr)
    else:
        print(f"  ! MCP NOT reachable — {detail}", file=sys.stderr)
        print("    Proceeding anyway: the workflow degrades to no-cache (useIndex miss). "
              "Fix the MCP or run with args.useIndex=false to silence.", file=sys.stderr)
    # print the resolved output dir on stdout for the launcher to capture (args.outputDir)
    print(out_abs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
