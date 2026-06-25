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

**2. Segmenta il Work Item in ≤10 screen-unit** e conferma. Ogni unit:
```jsonc
{
  "idx": "01", "titolo": "...", "prose": "<testo del requisito WI>",
  "figmaNode": "3977:52475",                 // nodo del frame (forma API o URL)
  "route": "/it/fruizione/template-finalita", // mode B: route STABILE da cui partire
  "waitFor": "text=I miei template",          // opz: selettore/`networkidle`
  "steps": [{"click":"Visualizza"},           // opz: naviga fino alla schermata
            {"click":{"role":"tab","name":"E-service e template e-service suggeriti"}}],
  "settle": 2500, "dataNote": "..."
}
```
Nota recipe: il deep-link diretto a una detail route rende **vuoto** — parti da una route stabile (es. la lista) e arriva alla schermata con gli `steps`.

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
  "units": [ /* ≤10, come sopra */ ]
}
```

## Output (`<outputDir>/<slug>/`)
`design/<idx>.png` + `design-index.md` · `app-shots/<idx>.png` + `app-shots-index.md` · `repo-map/` · `comments.md` · `findings/<idx>-*.md` · `reviews/<idx>-*.md` · `reverse-diff.md` · `report.md` (IT).

## Modelli A vs B
- **A (sempre)**: design-immagine vs codice letto — nessun token/app necessari (`renderedCapture: false`).
- **B (arricchimento)**: aggiunge lo screenshot dell'app renderizzata; richiede token + dev server. Se l'app non è raggiungibile, l'app-shooter salta-con-flag e l'analisi prosegue su A.

## Sicurezza
`FIGMA_TOKEN`/`REACT_APP_MOCK_TOKEN` vivono solo in env o `.env` gitignored, letti dagli script — mai dal modello, mai negli artefatti. `.gitignore` copre `.env`, `.spec-analyze*/`, `node_modules/`.
