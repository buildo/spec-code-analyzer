# figma-analyze — driver & preflight

Twin di `spec-analyze`, ma **Figma design ↔ codice frontend** (confronto visivo, multimodale). Legge il **repo FE locale** al `HEAD` pinnato; renderizza i frame Figma via Images API; opzionalmente screenshotta l'app reale via Playwright. Il workflow (`workflows/figma-analyze.js`) è deterministico: **non** fa fetch né conferme — presuppone questo preflight.

## Componenti
- **`workflows/figma-analyze.js`** — il workflow (Context ∥ → fan-out analyzer multimodale → verifier+rework → reverse-diff → report).
- **`workflows/fetch_figma.py`** — render deterministico dei frame → `design/<idx>.png` (stdlib; token da env/`.env`; mai stampato).
- **`workflows/shoot_app.mjs`** — cattura Playwright dell'app renderizzata → `app-shots/<idx>.png` (best-effort).

## Preflight (interattivo)
**1. Credenziali**
```bash
# Figma (scope file_content:read) — in <outputDir>/.env (gitignored) o in env
echo 'FIGMA_TOKEN=figd_...' >> ./.spec-analyze-fe/.env

# Solo per la cattura RENDERIZZATA (model B): token DEV nel FE, + dev server su
printf 'REACT_APP_MOCK_TOKEN=<jwt fresco>\n' >> ~/LocalWork/PagoPa/pdnd-interop-frontend/.env.development.local
( cd ~/LocalWork/PagoPa/pdnd-interop-frontend && npm run dev )   # Vite :3000, base /ui
```
Il `REACT_APP_MOCK_TOKEN` è un JWT di sessione DEV a breve scadenza: se l'app rende **vuoto**, è scaduto (`shoot_app.mjs` lo segnala come `EMPTY (no content — auth/token expired?)`).

**2. Gathering screenshot da Figma (l'agente — l'utente NON tocca node-id, componenti, colori o spacing)**
Le pagine del file Figma sono nominate per epica/PIN. L'agente trova la pagina e renderizza tutti i suoi frame:
```bash
# a) elenca le pagine (id<TAB>nome) e individua quella che contiene l'epica/PIN (es. "PIN-8621")
python3 workflows/fetch_figma.py --file-key <figmaFileKey> --list-pages --out ./.spec-analyze-fe/<slug>
# b) renderizza OGNI frame-schermata di quella pagina → design/<idx>.png (idx 01,02,… in ordine di lettura)
python3 workflows/fetch_figma.py --file-key <figmaFileKey> --discover-page <pageId> --out ./.spec-analyze-fe/<slug>
```
Output: `design/<idx>.png`, `design-index.md` e `discovered.json` (`[{idx, figmaNode, name}]`). Se più pagine combaciano col nome (o nessuna), fai **confermare la pagina** all'utente prima del passo b.

**3. Pairing design → app (l'UNICO input interattivo dell'utente)**
Per ogni schermata scoperta — mostra `design/<idx>.png` + il `name` del frame — chiedi all'utente l'**URL relativo dell'app** che porta a quella schermata (per ricostruire il flusso utente→app). Alcune schermate non sono raggiungibili dal solo URL (step di wizard, tab interne, accordion): in quei casi raccogli anche una **piccola navigazione** (`steps` + `waitFor`).

Costruisci le unit — `idx`, `titolo` e `figmaNode` vengono da `discovered.json`; `route`/`steps`/`waitFor` dall'utente:
```jsonc
{
  "idx": "03",                                 // da discovered.json
  "titolo": "Dettaglio template — risorse",    // = name del frame (da discovered.json)
  "figmaNode": "3977:52306",                   // da discovered.json — NON digitato a mano
  "route": "/it/fruizione/template-finalita",  // ← URL relativo inserito dall'utente
  "steps": [{"click":"Visualizza"},            // ← SOLO se la schermata richiede navigazione
            {"click":{"role":"tab","name":"E-service e template e-service suggeriti"}}],
  "waitFor": "table"                           // ← asserzione univoca dello schermo target (post-steps)
}
```

> **Coerenza unit (la garantisce il pairing)** — il `figmaNode` viene dallo screenshot scoperto e la `route`/`steps` sono inserite dall'utente PER QUELLO screenshot: per costruzione descrivono la stessa schermata. Se la `route` non riproduce quella schermata, l'analyzer alza `appShotMismatch`, scarta l'app-shot e confronta solo design↔codice.

> **`waitFor` = asserzione post-steps** — selettore CSS/text **univoco** dello schermo finale (non un titolo/route condiviso). Verificato DOPO gli `steps` (i click attendono già da soli). Senza `waitFor` → status `UNVERIFIED`; se non trovato → `WRONG-SCREEN?`.

Note per ricavare route/steps:
- **Deep-link a detail/wizard rende vuoto**: parti da una route stabile (la lista) e arriva con gli `steps`.
- **Tab**: `{"click":{"role":"tab","name":"..."}}` + `waitFor` del contenuto della tab.
- **Accordion**: un `{"click":"..."}` per espanderlo prima dello screenshot.
- **Schermata non riproducibile nell'app** (es. wizard step che richiede un draft attivo): lascia la unit **design-only** (ometti `route`) — meglio nessun app-shot che uno sbagliato.

## Lancio del workflow (dal main-loop di Claude Code)
Passa gli `args`:
```jsonc
{
  "fePath": "/Users/<you>/LocalWork/PagoPa/pdnd-interop-frontend",  // REQUIRED, repo locale = as-is
  "repo": "pagopa/pdnd-interop-frontend",        // per la discovery PR via gh
  "branch": "feature/PIN-10158_dead-code-cleanup",
  "epicKey": "PIN-8621", "workItemKeys": ["PIN-10144"], "prNumbers": [1925],
  "figmaFileKey": "CpRV3kPvFEWLXGtJUgWeZW",
  "outputDir": "./.spec-analyze-fe", "slug": "wi10-adeguamento-fe",
  "appBaseUrl": "http://localhost:3000/ui",
  "renderedCapture": true,                        // false = solo model A (design+codice), nessun token
  "tokenCap": 500000,
  "units": [ /* ≤10, costruite ai passi 2-3: discovery + pairing */ ]
}
```
Le `units` sono il risultato del preflight (discovery + pairing). Includi solo le schermate rilevanti per il WI (scarta i frame Figma fuori scope); se le scoperte superano 10, selezionane ≤10 — il workflow non tronca in silenzio ma avvisa.

## Output (`<outputDir>/<slug>/`)
`design/<idx>.png` + `design-index.md` · `app-shots/<idx>.png` + `app-shots-index.md` · `repo-map/` · `comments.md` · `findings/<idx>-*.md` · `reviews/<idx>-*.md` · `reverse-diff.md` · `report.md` (IT).

## Modelli A vs B
- **A (sempre)**: design-immagine vs codice letto — nessun token/app necessari (`renderedCapture: false`).
- **B (arricchimento)**: aggiunge lo screenshot dell'app renderizzata; richiede token + dev server. Se l'app non è raggiungibile, l'app-shooter salta-con-flag e l'analisi prosegue su A.

## Sicurezza
`FIGMA_TOKEN`/`REACT_APP_MOCK_TOKEN` vivono solo in env o `.env` gitignored, letti dagli script — mai dal modello, mai negli artefatti. `.gitignore` copre `.env`, `.spec-analyze*/`, `node_modules/`.
