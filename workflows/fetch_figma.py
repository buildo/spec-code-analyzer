#!/usr/bin/env python3
"""fetch_figma.py — render deterministico di frame Figma per il workflow figma-analyze.

Specchio di fetch_atlassian.py: sola stdlib di Python 3 (nessuna dipendenza), token letto
solo da ambiente o `<out>/.env`, **mai stampato**, exit-code espliciti.

Contratto (CLI) — una delle quattro modalità:
    fetch_figma.py --file-key <key> --list-pages --out <dir>
    fetch_figma.py --file-key <key> --discover-page <pageId> --out <dir> [--scale 1]
    fetch_figma.py --file-key <key> --units <units.json> --out <dir> [--scale 1]
    fetch_figma.py --file-key <key> --nodes <id,id,...> --out <dir> [--scale 1]

`--list-pages` stampa su stdout le pagine del file (`<id>\t<nome>`) e esce: serve al preflight per trovare
la pagina di un'epica/PIN per nome, senza che l'utente tocchi i node-id.
`--discover-page <pageId>` ENUMERA e renderizza OGNI frame-schermata della pagina (FRAME diretti + FRAME dentro
SECTION di primo livello), in ordine di lettura (alto→basso, sx→dx); idx assegnato 01,02,…; scrive anche
`discovered.json` ([{idx, figmaNode, name}]) da cui il preflight costruisce le unit aggiungendo route/steps.
`--units` è l'input CANONICO per la run: un JSON array `{ "idx": "01", "figmaNode": "3977:52475", ... }`
(l'`idx` confermato in preflight è l'unica fonte di verità che lega design/<idx>.png a unit/finding/report).
`--nodes` è solo un HELPER DI DEBUG: idx = posizione 1-based.

Output (sotto <out>):
    design/<idx>.png      un PNG per ogni frame renderizzabile
    design-index.md       tabella: idx | node | file | name | status
    discovered.json       (solo --discover-page) [{idx, figmaNode, name}] per il pairing del preflight

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


def get_pages(key, token):
    """Ritorna [(id, name)] delle pagine (CANVAS) del file — una sola chiamata shallow."""
    d = api_get(f"/files/{key}?depth=1", token)
    doc = d.get("document") or {}
    return [(c["id"], c.get("name", "")) for c in doc.get("children", []) if c.get("type") == "CANVAS"]


def discover_frames(key, page_id, token):
    """Enumera le frame-schermata di una pagina: FRAME diretti + FRAME dentro SECTION di primo livello,
    ordinati in lettura (alto→basso, sx→dx). Ritorna (file_name, [{idx, node, name}])."""
    q = urllib.parse.urlencode({"ids": page_id, "depth": "2"})
    d = api_get(f"/files/{key}/nodes?{q}", token)
    file_name = d.get("name") or key
    page = ((d.get("nodes") or {}).get(page_id) or {}).get("document") or {}
    frames = []
    for child in page.get("children", []):
        t = child.get("type")
        if t == "FRAME":
            frames.append(child)
        elif t == "SECTION":
            frames.extend(s for s in child.get("children", []) if s.get("type") == "FRAME")

    def pos(f):
        bb = f.get("absoluteBoundingBox") or {}
        # bucket y (tolleranza 50px) così frame quasi-allineati restano ordinati sx→dx
        return (round((bb.get("y") or 0) / 50.0), bb.get("x") or 0)

    frames.sort(key=pos)
    out = [
        {"idx": f"{i + 1:02d}", "node": normalize_node_id(f["id"]), "name": f.get("name", "")}
        for i, f in enumerate(frames)
    ]
    return file_name, out


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
    g.add_argument("--units", help="path to units.json (canonical run input)")
    g.add_argument("--nodes", help="comma-separated node ids (debug only)")
    g.add_argument("--discover-page", help="page node id: enumerate + render every SCREEN frame on it (no hand node-ids)")
    g.add_argument("--list-pages", action="store_true", help="print the file's pages (id<TAB>name) and exit")
    ap.add_argument("--out", required=True, help="output dir (design/ is written under it; for --list-pages used only to find .env)")
    ap.add_argument("--scale", default="1")
    args = ap.parse_args()

    key = args.file_key
    token = load_token(args.out)
    if not token:
        fail(3, f"{ENV_KEY} not set (env or {args.out}/.env)")

    # --list-pages: stampa le pagine ed esce (il preflight le filtra per epica/PIN per nome).
    if args.list_pages:
        try:
            for pid, name in get_pages(key, token):
                print(f"{pid}\t{name}")
        except urllib.error.HTTPError as e:
            fail(http_to_exit(e), f"figma /files failed (HTTP {e.code}) — file or token issue")
        except (urllib.error.URLError, ValueError) as e:
            fail(2, f"figma /files failed: {e}")
        sys.exit(0)

    # Risolvi le unit da renderizzare (+ nomi già noti) secondo la modalità.
    names = {}
    file_name = key
    if args.discover_page:
        try:
            file_name, disc = discover_frames(key, normalize_node_id(args.discover_page), token)
        except urllib.error.HTTPError as e:
            fail(http_to_exit(e), f"figma /nodes failed (HTTP {e.code}) — page or token issue")
        except (urllib.error.URLError, ValueError) as e:
            fail(2, f"figma /nodes failed: {e}")
        if not disc:
            fail(2, f"no SCREEN frames found on page {args.discover_page}")
        units = [{"idx": u["idx"], "node": u["node"]} for u in disc]
        names = {u["node"]: u["name"] for u in disc}
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "discovered.json"), "w", encoding="utf-8") as fh:
            json.dump(disc, fh, ensure_ascii=False, indent=2)
        log(f"discovered {len(disc)} frames on page {args.discover_page} -> {args.out}/discovered.json")
    else:
        units = build_units(args)
        # Nomi dei nodi (best-effort) + esistenza file: una sola chiamata /nodes.
        try:
            q = urllib.parse.urlencode({"ids": ",".join(u["node"] for u in units), "depth": "0"})
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

    ids = [u["node"] for u in units]

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
