#!/usr/bin/env python3
"""fetch_figma.py — render deterministico di frame Figma per il workflow figma-analyze.

Specchio di fetch_atlassian.py: sola stdlib di Python 3 (nessuna dipendenza), token letto
solo da ambiente o `<out>/.env`, **mai stampato**, exit-code espliciti.

Contratto (CLI):
    fetch_figma.py --file-key <key> (--units <units.json> | --nodes <id,id,...>) \
                   --out <output-dir> [--scale 1]

`--units` è l'input CANONICO: un JSON array di unit `{ "idx": "01", "figmaNode": "3977:52475", ... }`
(l'`idx` confermato in preflight è l'unica fonte di verità che lega design/<idx>.png a unit/finding/report).
`--nodes` è solo un HELPER DI DEBUG: idx = posizione 1-based.

Output (sotto <out>):
    design/<idx>.png      un PNG per ogni frame renderizzabile
    design-index.md       tabella: idx | node | file | name | status

Esiti (RF-6, adattati al multi-nodo):
    exit 0  -> almeno un frame renderizzato (i fallimenti per-nodo sono FLAGGATI in
               design-index.md, non fatali)
    exit 2  -> file o TUTTI i nodi non risolvibili (niente renderizzato)
    exit 3  -> credenziali assenti o permessi negati (401/403)
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

FIGMA_API = "https://api.figma.com/v1"
ENV_KEY = "FIGMA_TOKEN"
HTTP_TIMEOUT = 60


def log(msg):
    """Diagnostica su stderr (stdout resta pulito; il token non compare MAI)."""
    print(msg, file=sys.stderr)


def fail(code, msg):
    log(f"ERROR: {msg}")
    sys.exit(code)


# --- credenziali: env ha precedenza, fallback su <out>/.env (come fetch_atlassian) ---
def load_token(out_dir):
    tok = os.environ.get(ENV_KEY, "")
    if tok:
        return tok
    # Search <out>/.env then the PARENT dir's .env (the preflight usually puts .env at
    # outputDir level, while --out points at outputDir/<slug>).
    candidates = [
        os.path.join(out_dir, ".env"),
        os.path.join(os.path.dirname(os.path.normpath(out_dir)), ".env"),
    ]
    for env_path in candidates:
        if not os.path.isfile(env_path):
            continue
        with open(env_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                if key.strip() == ENV_KEY:
                    return val.strip().strip('"').strip("'")
    return ""


def normalize_node_id(raw):
    """Accetta sia la forma URL '3977-52475' sia quella API '3977:52475'."""
    return str(raw).strip().replace("-", ":")


def api_get(path, token):
    """GET su api.figma.com. Solleva HTTPError; il chiamante mappa gli status su exit-code."""
    req = urllib.request.Request(FIGMA_API + path, headers={"X-Figma-Token": token})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_to_exit(err):
    """401/403 -> 3 (creds), 404 -> 2 (non risolvibile), altro -> 2."""
    if isinstance(err, urllib.error.HTTPError) and err.code in (401, 403):
        return 3
    return 2


def download(url, dest):
    with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as resp:
        data = resp.read()
    with open(dest, "wb") as fh:
        fh.write(data)


def build_units(args):
    """Ritorna una lista di dict {idx, node} dall'input --units (canonico) o --nodes (debug)."""
    if args.units:
        with open(args.units, encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, list) or not raw:
            fail(2, f"--units file is not a non-empty JSON array: {args.units}")
        units = []
        for i, u in enumerate(raw):
            idx = str(u.get("idx") or f"{i + 1:02d}")
            node = u.get("figmaNode") or u.get("node")
            if not node:
                fail(2, f"unit {idx} has no 'figmaNode'")
            units.append({"idx": idx, "node": normalize_node_id(node)})
        return units
    # --nodes: debug, idx = posizione 1-based
    ids = [n for n in (args.nodes or "").split(",") if n.strip()]
    if not ids:
        fail(2, "neither --units nor --nodes provided a renderable node")
    return [{"idx": f"{i + 1:02d}", "node": normalize_node_id(n)} for i, n in enumerate(ids)]


def main():
    ap = argparse.ArgumentParser(description="Render Figma frames to PNG (deterministic).")
    ap.add_argument("--file-key", required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--units", help="path to units.json (canonical)")
    g.add_argument("--nodes", help="comma-separated node ids (debug only)")
    ap.add_argument("--out", required=True, help="output dir (design/ is written under it)")
    ap.add_argument("--scale", default="1")
    args = ap.parse_args()

    token = load_token(args.out)
    if not token:
        fail(3, f"{ENV_KEY} not set (env or {args.out}/.env)")

    units = build_units(args)
    ids = [u["node"] for u in units]
    key = args.file_key

    # Nomi dei nodi (best-effort) + esistenza file: una sola chiamata /nodes.
    names = {}
    file_name = key
    try:
        q = urllib.parse.urlencode({"ids": ",".join(ids), "depth": "0"})
        nodes_resp = api_get(f"/files/{key}/nodes?{q}", token)
        file_name = nodes_resp.get("name") or key
        for nid, wrap in (nodes_resp.get("nodes") or {}).items():
            doc = (wrap or {}).get("document") or {}
            if doc.get("name"):
                names[nid] = doc["name"]
    except urllib.error.HTTPError as e:
        fail(http_to_exit(e), f"figma /nodes failed (HTTP {e.code}) — file or token issue")
    except (urllib.error.URLError, ValueError) as e:
        fail(2, f"figma /nodes failed: {e}")

    # Render: una sola chiamata /images per tutti gli id.
    try:
        q = urllib.parse.urlencode({"ids": ",".join(ids), "format": "png", "scale": str(args.scale)})
        img_resp = api_get(f"/images/{key}?{q}", token)
    except urllib.error.HTTPError as e:
        fail(http_to_exit(e), f"figma /images failed (HTTP {e.code})")
    except (urllib.error.URLError, ValueError) as e:
        fail(2, f"figma /images failed: {e}")

    images = img_resp.get("images") or {}
    if img_resp.get("err") and not images:
        fail(2, f"figma /images returned error and no images: {img_resp.get('err')}")

    design_dir = os.path.join(args.out, "design")
    os.makedirs(design_dir, exist_ok=True)

    rows = []
    ok_count = 0
    for u in units:
        idx, node = u["idx"], u["node"]
        fname = f"design/{idx}.png"
        dest = os.path.join(design_dir, f"{idx}.png")
        url = images.get(node)
        name = names.get(node, "")
        if not url:
            rows.append((idx, node, "—", name, "MISSING (no render url)"))
            log(f"  - {idx} {node}: no render url (flagged, not fatal)")
            continue
        try:
            download(url, dest)
            ok_count += 1
            rows.append((idx, node, fname, name, "ok"))
            log(f"  - {idx} {node}: ok -> {fname}")
        except (urllib.error.URLError, OSError) as e:
            rows.append((idx, node, "—", name, f"DOWNLOAD FAILED ({e})"))
            log(f"  - {idx} {node}: download failed (flagged): {e}")

    # design-index.md
    index_path = os.path.join(args.out, "design-index.md")
    with open(index_path, "w", encoding="utf-8") as fh:
        fh.write(f"# Design index — {file_name} (`{key}`)\n\n")
        fh.write(f"scale: {args.scale} · renderizzati: {ok_count}/{len(units)}\n\n")
        fh.write("| idx | node | file | name | status |\n")
        fh.write("|-----|------|------|------|--------|\n")
        for idx, node, fname, name, status in rows:
            safe_name = (name or "").replace("|", "\\|")
            fh.write(f"| {idx} | `{node}` | {fname} | {safe_name} | {status} |\n")

    log(f"design-index.md written: {ok_count}/{len(units)} rendered -> {index_path}")
    if ok_count == 0:
        fail(2, "no frame rendered (all nodes unresolvable)")
    sys.exit(0)


if __name__ == "__main__":
    main()
