# spec-code-analyzer

Confronta una **specifica (SRS)** con il **codice as-is** di un repository e produce un report di copertura strutturato, sezione per sezione.

Risponde a due domande:

1. **SRS → codice**: ogni requisito della specifica è coperto dal codice? Dove sono i gap?
2. **codice → SRS** (reverse diff): quali comportamenti esistono nel codice ma **non** sono documentati nella specifica?

È pensato per il monorepo PagoPa/Interop, ma è generico: dato un SRS (tipicamente da Confluence) e un repo GitHub con i suoi PR/commenti, ricostruisce lo stato di copertura confrontando la specifica con il codice di un branch preciso.

## Com'è fatto

Il cuore è un **Workflow Claude Code** (`workflows/spec-analyze.js`) che orchestra in modo deterministico una flotta di subagent, ciascuno con un ruolo e privilegi minimi:

| Fase | Ruolo | Cosa fa | Modello |
|------|-------|---------|---------|
| **Context** | `cartographer` ∥ `crawler` | mappa del repo (aree/moduli) e raccolta PR + commenti rilevanti, in parallelo | haiku |
| **Analysis** | `analyzer` (fan-out, 1 per sezione SRS) | per ogni sezione stabilisce lo stato di copertura e i riferimenti al codice (`path:line`) | opus |
| **Verification** | `verifier` + `rework` | revisione **adversariale** di ogni finding (falsifica, non conferma) + un singolo round di rework se serve | opus |
| **Reverse diff** | `reverse-scout` | parte dal codice e trova comportamenti non documentati nell'SRS | sonnet |
| **SRS improved** | `editor` (2 reader haiku → converge → verify adversariale → rework) | riscrive l'SRS in `srs-improved.md`: ogni Work Item separato in **Requisiti di prodotto** vs **Specifiche tecniche** e arricchito con i comportamenti code→spec del reverse-diff; in parallelo col report | sonnet (reader haiku) |
| **Report** | `report` | sintesi finale `report.md` (in italiano) con tabella di copertura, gap, RR-4 (verificato/contestato) e RR-5 (evidenze di esecuzione e costi) | sonnet |

Principi chiave:
- **Pull-based, zero re-download**: gli agent leggono prima gli indici (mappa repo, indice PR→path) e poi solo ciò che serve.
- **As-is truth**: il codice è sempre letto a un `?ref=<branch>` fisso.
- **Niente troncamenti silenziosi**: ogni limite raggiunto (cap PR, tetto token) viene segnalato esplicitamente nel report.
- **Tetto di costo** best-effort (~500k token) con riserva per garantire sempre la scrittura del report.
- **Segreti fuori dagli artefatti**: il token Atlassian vive solo nell'ambiente o in un `.env` gitignored.

### Confronto A/B (varianti)

Il workflow è parametrizzato via `args.variant`, con scheletro **identico** tra le due varianti — cambiano solo due assi sperimentali:

- `prescriptive` (default): i ruoli sono **procedure numerate**; discovery con cap numerici fissi (~30 PR, ≤3 PR/sezione).
- `goals`: i ruoli sono espressi come **Obiettivo / Contratto di output / Invarianti-guardrail** (vincola gli esiti, non i passi); discovery a **budget + giudizio**, senza tetti numerici fissi.

Le due varianti scrivono in directory separate (`./.spec-analyze` vs `./.spec-analyze-goals`) per non mischiare gli artefatti.

## Componenti

- **`workflows/spec-analyze.js`** — il workflow di orchestrazione (descritto sopra).
- **`workflows/fetch_atlassian.py`** — fetch deterministico di Confluence/Jira (solo stdlib Python 3, nessuna dipendenza). Produce `srs.md` (+ eventuale `cards.md`). Credenziali da env o `<out>/.env`, mai stampate.
- **`workflows/run_cost.py`** — post-processing del costo reale per-agent/per-fase, ricostruito dai transcript JSONL della run (il workflow internamente vede solo il totale output-token; questo script recupera input + cache per il breakdown della RR-5).

## Come si usa

Il workflow **non** esegue da solo il fetch né la conferma utente: presuppone un preflight interattivo. Flusso tipico:

**1. Preflight** — verifica credenziali Atlassian e `gh` autenticato:

```bash
export ATLASSIAN_BASE_URL="https://<org>.atlassian.net"
export ATLASSIAN_EMAIL="tu@example.com"
export ATLASSIAN_API_TOKEN="..."        # oppure in <out>/.env (gitignored)
gh auth status
```

**2. Fetch della specifica** da Confluence (+ eventuale card Jira):

```bash
python3 workflows/fetch_atlassian.py \
  --confluence <id|url> \
  --jira <KEY|url> \
  --out ./.spec-analyze/<slug>
```

**3. Segmentazione** dell'SRS in **≤10 unità** (sezioni), confermata con l'utente.

**4. Lancio del workflow** (dal main-loop di Claude Code) passando gli `args`:

```jsonc
{
  "variant": "prescriptive",            // o "goals"
  "repo": "owner/repo",
  "branch": "develop",
  "slug": "draft-srs-...",
  "srsPath": "./.spec-analyze/<slug>/srs.md",
  "cardsPath": "./.spec-analyze/<slug>/cards.md",  // o null
  "units": [ { "idx": "01", "titolo": "...", "prose": "..." } ],
  "mergeNote": "eventuali merge di sezioni eseguiti"  // o null
}
```

Output sotto `<outputDir>/<slug>/`: `repo-map/`, `comments.md`, `findings/`, `reviews/`, `reverse-diff.md`, l'`srs-improved.md` (SRS riscritto prodotto/tecnico + arricchito) e il `report.md` finale.

**5. Breakdown costi** (opzionale, dopo la run):

```bash
python3 workflows/run_cost.py <transcript-dir> --notif-total <subagent_tokens> --md
```

### Confronto A/B

Per un confronto pulito, lancia **entrambe** le varianti sugli **stessi** repo/branch/unità, in directory separate, poi confronta i due `report.md`.

## Requisiti

- [Claude Code](https://claude.com/claude-code) (il workflow gira nel suo runtime).
- `gh` CLI autenticato sul repo da analizzare.
- Python 3 (solo stdlib — nessun pacchetto da installare).
- Credenziali Atlassian Cloud (per il fetch dell'SRS).
