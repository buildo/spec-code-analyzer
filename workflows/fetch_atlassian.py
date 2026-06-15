#!/usr/bin/env python3
"""fetch_atlassian.py — recupero deterministico Confluence/Jira per spec-tool.

Implementa il contratto CLI / I/O / exit-code (RF-4, RF-5, RF-6), la slugificazione
deterministica (RA-5) e il **fetch reale** verso Atlassian Cloud in sola stdlib di
Python 3 (RNF-7): nessuna dipendenza da installare.

Sicurezza (V8, RF-6, RA-4): il token è letto solo da ambiente / `<out>/.env`, usato
unicamente nell'header Authorization, e **non compare mai su stdout** né negli artefatti.

Contratto (RF-4):
    fetch_atlassian.py --confluence <id|url> --jira <key|url> --out <output-dir>

Esiti (RF-6):
    exit 0  -> srs.md prodotto (eventuale fallimento del solo lato Jira = avviso)
    exit 2  -> input/pagina Confluence non risolvibile o inesistente (404) : srs.md NON prodotto
    exit 3  -> credenziali assenti o permessi negati (401/403)             : srs.md NON prodotto
"""

import argparse
import base64
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser

ENV_KEYS = ("ATLASSIAN_BASE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN")
HTTP_TIMEOUT = 30


# --- RA-5: funzione di slugificazione unica e deterministica ----------------
def slugify(text, max_len=60):
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")  # à→a, é→e, …
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text[:max_len].rstrip("-") or "senza-titolo"


# --- credenziali: env ha precedenza, fallback su <out>/.env (RC-1) ----------
def load_credentials(out_dir):
    """Ritorna un dict delle credenziali. I VALORI non vanno mai stampati (V8)."""
    creds = {k: os.environ.get(k, "") for k in ENV_KEYS}
    env_path = os.path.join(out_dir, ".env")
    if os.path.isfile(env_path):
        with open(env_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key in ENV_KEYS and not creds.get(key):
                    creds[key] = val  # env ha precedenza: riempi solo i vuoti
    creds["ATLASSIAN_BASE_URL"] = creds["ATLASSIAN_BASE_URL"].rstrip("/")
    return creds


# --- risoluzione input (RF-4) -----------------------------------------------
def resolve_confluence(value):
    """(page_id, anchor|None). Accetta id numerico o URL con /pages/{id}.

    L'eventuale ancora NON filtra il fetch: viene annotata in srs.md (RF-4)."""
    anchor = None
    if "#" in value:
        value, anchor = value.split("#", 1)
    m = re.search(r"/pages/(\d+)", value)
    if m:
        return m.group(1), anchor
    if value.strip().isdigit():
        return value.strip(), anchor
    return None, anchor


def resolve_jira(value):
    """Epic key. Accetta key (PROJ-123) o URL .../browse/KEY."""
    m = re.search(r"/browse/([A-Z][A-Z0-9_]+-\d+)", value)
    if m:
        return m.group(1)
    m = re.match(r"^([A-Z][A-Z0-9_]+-\d+)$", value.strip())
    return m.group(1) if m else None


# --- HTTP (Basic auth Atlassian Cloud) --------------------------------------
class AuthError(Exception):
    pass


class NotFoundError(Exception):
    pass


def _auth_header(creds):
    raw = f"{creds['ATLASSIAN_EMAIL']}:{creds['ATLASSIAN_API_TOKEN']}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def api_get(url, creds):
    """GET JSON con Basic auth. Solleva AuthError (401/403) o NotFoundError (404)."""
    req = urllib.request.Request(url)
    req.add_header("Authorization", _auth_header(creds))
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise AuthError(f"HTTP {e.code} (permessi/credenziali) su {url.split('?')[0]}")
        if e.code == 404:
            raise NotFoundError(f"HTTP 404 (non trovato) su {url.split('?')[0]}")
        raise


# --- Confluence storage (XHTML) -> markdown ---------------------------------
class _StorageToMarkdown(HTMLParser):
    """Converte lo storage-format Confluence in markdown preservando la prosa.
    Gestisce heading, paragrafi, liste, enfasi, codice, link, tabelle. Le macro
    Confluence (ac:/ri:) non riconosciute sono attraversate mantenendone il testo.
    """

    _HEAD = {f"h{i}": i for i in range(1, 7)}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._list = []          # stack: dict(type, idx)
        self._href = None
        self._pre = False
        self._row = None         # cella corrente in tabella
        self._row_cells = None
        self._table_rows = 0

    def _emit(self, s):
        self.parts.append(s)

    def handle_starttag(self, tag, attrs):
        if tag in self._HEAD:
            self._emit("\n\n" + "#" * self._HEAD[tag] + " ")
        elif tag == "p":
            self._emit("\n\n")
        elif tag == "br":
            self._emit("  \n")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "code" and not self._pre:
            self._emit("`")
        elif tag == "pre":
            self._pre = True
            self._emit("\n\n```\n")
        elif tag == "ul":
            self._list.append({"type": "ul"})
        elif tag == "ol":
            self._list.append({"type": "ol", "idx": 0})
        elif tag == "li":
            depth = max(0, len(self._list) - 1)
            indent = "  " * depth
            if self._list and self._list[-1]["type"] == "ol":
                self._list[-1]["idx"] += 1
                self._emit(f"\n{indent}{self._list[-1]['idx']}. ")
            else:
                self._emit(f"\n{indent}- ")
        elif tag == "a":
            self._href = dict(attrs).get("href")
            self._emit("[")
        elif tag in ("table",):
            self._table_rows = 0
            self._emit("\n\n")
        elif tag == "tr":
            self._row_cells = []
        elif tag in ("td", "th"):
            self._row = []

    def handle_endtag(self, tag):
        if tag == "p":
            self._emit("\n")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "code" and not self._pre:
            self._emit("`")
        elif tag == "pre":
            self._emit("\n```\n")
            self._pre = False
        elif tag in ("ul", "ol"):
            if self._list:
                self._list.pop()
            if not self._list:
                self._emit("\n")
        elif tag == "a":
            href = self._href or ""
            self._emit(f"]({href})" if href else "]")
            self._href = None
        elif tag in ("td", "th"):
            if self._row is not None and self._row_cells is not None:
                self._row_cells.append("".join(self._row).strip().replace("\n", " "))
            self._row = None
        elif tag == "tr":
            if self._row_cells is not None:
                self._emit("| " + " | ".join(self._row_cells) + " |\n")
                self._table_rows += 1
                if self._table_rows == 1:  # separatore header
                    self._emit("|" + "---|" * len(self._row_cells) + "\n")
            self._row_cells = None
        elif tag == "table":
            self._emit("\n")

    def handle_data(self, data):
        if self._row is not None:
            self._row.append(data)
        else:
            self._emit(data)

    def markdown(self):
        text = "".join(self.parts)
        text = re.sub(r"\*\*\s*\*\*", "", text)            # grassetti vuoti (macro senza testo)
        text = re.sub(r"(?m)^[ \t]*\*+[ \t]*$", "", text)  # righe di soli asterischi
        text = re.sub(r"\n{3,}", "\n\n", text)             # comprimi righe vuote multiple
        return text.strip() + "\n"


def storage_to_markdown(storage_xhtml):
    parser = _StorageToMarkdown()
    parser.feed(storage_xhtml)
    parser.close()
    return parser.markdown()


# --- Confluence -> srs.md ---------------------------------------------------
def fetch_confluence(creds, page_id, anchor, slug_dir):
    base = creds["ATLASSIAN_BASE_URL"]
    url = f"{base}/wiki/rest/api/content/{page_id}?expand=body.storage,version"
    data = api_get(url, creds)
    title = data.get("title", f"pagina {page_id}")
    version = data.get("version", {}).get("number", "?")
    storage = data.get("body", {}).get("storage", {}).get("value", "") or ""
    body_md = storage_to_markdown(storage)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    header = [
        f"# {title}",
        "",
        f"- **Page id**: {page_id}",
        f"- **Versione**: {version}",
        f"- **Data fetch**: {now}",
    ]
    if anchor:
        header.append(f"- **Sezione di interesse dichiarata** (ancora URL, non filtra il fetch): `{anchor}`")
    header += ["", "---", ""]
    os.makedirs(slug_dir, exist_ok=True)
    path = os.path.join(slug_dir, "srs.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(header) + body_md)
    n_sections = body_md.count("\n#")  # heading nel corpo
    return path, title, n_sections


# --- Jira -> cards.md -------------------------------------------------------
_GH_PR_RE = re.compile(r"github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)", re.I)


def _jql_search(base, creds, jql, warnings, cap=100):
    """Esegue una JQL via Enhanced JQL (/rest/api/3/search/jql) con paginazione a token.
    Ritorna lista di issue (max `cap`). Errori non bloccanti -> avviso.
    NB: il vecchio /rest/api/2/search è stato dismesso da Atlassian (HTTP 410)."""
    issues = []
    token = None
    while len(issues) < cap:
        params = {"jql": jql, "maxResults": min(100, cap - len(issues)), "fields": "summary,status"}
        if token:
            params["nextPageToken"] = token
        url = f"{base}/rest/api/3/search/jql?{urllib.parse.urlencode(params)}"
        try:
            data = api_get(url, creds)
        except (urllib.error.HTTPError, urllib.error.URLError, AuthError, NotFoundError) as e:
            warnings.append(f"JQL fallita ({jql!r}): {e}")
            break
        issues.extend(data.get("issues", []))
        token = data.get("nextPageToken")
        if data.get("isLast") or not token or not data.get("issues"):
            break
    return issues


def _dev_status_prs(base, creds, issue_id):
    """PR dal pannello Development (dev-status API): è qui che vivono le PR collegate
    via integrazione GitHub (commit/branch/PR), NON nei remote link (web-link manuali)."""
    urls = []
    for app in ("GitHub", "github"):
        u = (f"{base}/rest/dev-status/1.0/issue/detail"
             f"?issueId={issue_id}&applicationType={app}&dataType=pullrequest")
        try:
            data = api_get(u, creds)
        except (urllib.error.HTTPError, urllib.error.URLError, AuthError, NotFoundError):
            continue
        for det in data.get("detail", []):
            for pr in det.get("pullRequests", []):
                if pr.get("url"):
                    urls.append(pr["url"])
        if urls:
            break
    return urls


def fetch_jira(creds, epic_key, slug_dir, warnings):
    base = creds["ATLASSIAN_BASE_URL"]
    # Unione: parent (team-managed) ∪ Epic Link (company-managed)
    issues = {}
    for jql in (f'parent = {epic_key}', f'"Epic Link" = {epic_key}'):
        for iss in _jql_search(base, creds, jql, warnings):
            issues[iss["key"]] = iss
    cards = list(issues.values())
    if len(cards) >= 100:
        warnings.append("epica con >= 100 carte: elenco potenzialmente troncato")

    pr_seen = set()
    pr_index = []  # (pr_label, card_key)
    for iss in cards:
        key = iss["key"]
        hrefs = []
        # 1) Pannello Development (dev-status): la fonte primaria delle PR GitHub
        if iss.get("id"):
            hrefs += _dev_status_prs(base, creds, iss["id"])
        # 2) Remote link (web-link manuali): fonte secondaria
        try:
            links = api_get(f"{base}/rest/api/3/issue/{key}/remotelink", creds)
            for ln in links if isinstance(links, list) else []:
                href = (ln.get("object") or {}).get("url", "") or ""
                if href:
                    hrefs.append(href)
        except (urllib.error.HTTPError, urllib.error.URLError, AuthError, NotFoundError):
            pass
        for href in hrefs:
            m = _GH_PR_RE.search(href)
            if m:
                label = f"{m.group(1)}/{m.group(2)}#{m.group(3)}"
                if (label, key) not in pr_seen:
                    pr_seen.add((label, key))
                    pr_index.append((label, key))

    body = [f"# Carte dell'epica {epic_key}", "", f"Carte trovate: {len(cards)}.", "", "## Carte", ""]
    for iss in cards:
        summary = (iss.get("fields") or {}).get("summary", "")
        status = ((iss.get("fields") or {}).get("status") or {}).get("name", "")
        body.append(f"- **{iss['key']}** — {summary} _({status})_")
    body += ["", "## Indice PR scoperte via Jira (pannello Development + remote link)", ""]
    if pr_index:
        body += ["| PR | Carta |", "|---|---|"]
        for pr, card in pr_index:
            body.append(f"| {pr} | {card} |")
    else:
        body.append("_(nessun remote link verso PR GitHub trovato)_")
    body.append("")

    path = os.path.join(slug_dir, "cards.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(body))
    return path, len(cards), len(pr_index)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="fetch_atlassian.py",
        description="Recupero deterministico Confluence/Jira per spec-tool.",
    )
    parser.add_argument("--confluence", required=True, help="id numerico o URL con /pages/{id}")
    parser.add_argument("--jira", required=True, help="epic key (PROJ-123) o URL /browse/KEY")
    parser.add_argument("--out", required=True, help="output-dir (lo passa l'orchestratore)")
    args = parser.parse_args(argv)

    warnings = []
    creds = load_credentials(args.out)
    missing = [k for k in ENV_KEYS if not creds.get(k)]
    if missing:
        print(f"ERRORE: credenziali Atlassian assenti: {', '.join(missing)}", file=sys.stderr)
        print("Imposta le variabili d'ambiente oppure popola <output-dir>/.env.", file=sys.stderr)
        return 3

    page_id, anchor = resolve_confluence(args.confluence)
    epic_key = resolve_jira(args.jira)
    if not page_id:
        print(f"ERRORE: input Confluence non risolvibile: '{args.confluence}'", file=sys.stderr)
        print("Attesi: id numerico, oppure URL contenente /pages/{id}.", file=sys.stderr)
        return 2

    os.makedirs(args.out, exist_ok=True)

    # --- Confluence: senza srs.md NON si prosegue (RF-6) ---
    try:
        # slug provvisorio non noto finché non abbiamo il titolo: scarichiamo prima.
        base = creds["ATLASSIAN_BASE_URL"]
        meta = api_get(f"{base}/wiki/rest/api/content/{page_id}?expand=body.storage,version", creds)
    except AuthError as e:
        print(f"ERRORE: accesso negato a Confluence — {e}", file=sys.stderr)
        print("Verifica email/token e i permessi sulla pagina.", file=sys.stderr)
        return 3
    except NotFoundError as e:
        print(f"ERRORE: pagina Confluence inesistente — {e}", file=sys.stderr)
        return 2
    except urllib.error.URLError as e:
        print(f"ERRORE: rete/Confluence non raggiungibile — {e}", file=sys.stderr)
        return 2

    title = meta.get("title", f"pagina {page_id}")
    slug = slugify(title)
    slug_dir = os.path.join(args.out, slug)
    version = meta.get("version", {}).get("number", "?")
    storage = meta.get("body", {}).get("storage", {}).get("value", "") or ""
    body_md = storage_to_markdown(storage)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    header = [f"# {title}", "", f"- **Page id**: {page_id}", f"- **Versione**: {version}",
              f"- **Data fetch**: {now}"]
    if anchor:
        header.append(f"- **Sezione di interesse dichiarata** (ancora URL, non filtra il fetch): `{anchor}`")
    header += ["", "---", ""]
    os.makedirs(slug_dir, exist_ok=True)
    srs_path = os.path.join(slug_dir, "srs.md")
    with open(srs_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(header) + body_md)
    n_sections = max(1, len(re.findall(r"(?m)^#{1,6} ", body_md)))

    # --- Jira: fallimento => avviso + exit 0 (srs.md già prodotto) ---
    cards_path = None
    n_cards = n_prs = 0
    if not epic_key:
        warnings.append(f"input Jira non risolvibile ('{args.jira}'): cards.md non prodotto")
    else:
        try:
            cards_path, n_cards, n_prs = fetch_jira(creds, epic_key, slug_dir, warnings)
        except AuthError as e:
            warnings.append(f"Jira inaccessibile ({e}): cards.md non prodotto")
        except (urllib.error.URLError, NotFoundError) as e:
            warnings.append(f"Jira non raggiungibile/non trovato ({e}): cards.md non prodotto")

    # --- stdout: SOLO metadati, mai header/token (RF-6, V8) ---
    print("=== fetch-atlassian ===")
    print(f"Titolo pagina : {title}")
    print(f"Slug          : {slug}")
    print(f"Sezioni SRS   : {n_sections}")
    print(f"Carte Jira    : {n_cards}")
    print(f"PR via Jira   : {n_prs}")
    print(f"srs.md        : {srs_path}")
    if cards_path:
        print(f"cards.md      : {cards_path}")
    for w in warnings:
        print(f"AVVISO        : {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
