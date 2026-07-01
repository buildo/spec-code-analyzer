# MCP knowledge-graph cache for `spec-analyze`

Wires the `spec-analyze` workflow (`workflows/spec-analyze.js`) to the **vibingwithclaude**
MCP knowledge-graph as a cache in front of the discovery phase.

- **On start**, look up indexed context and, on a **fresh** hit, reuse it and skip discovery.
- **On a miss**, run discovery as usual and **populate** the graph from its output.

Design constraint: the Workflow JS body can only call `agent()/parallel()/pipeline()/phase()/log()`;
the MCP tools are reachable **only inside spawned agents**. So every MCP read/write lives in a
dedicated agent (`context-broker`, `indexer`), never in the JS body. (Verified by spike, 2026-07.)

## Flow

```
Context lookup ──fresh?──► reuse: broker materializes repo-map/ + comments.md → SKIP discovery
      │ miss / MCP down / useIndex=false
      ▼
Context (cartographer ‖ crawler)  →  Index write-back (ingest into the graph, non-blocking)
      ▼
Analysis → Verification → Reverse diff → SRS improved → Report   (unchanged)
```

The `Context` barrier is preserved: `repo-map/` + `comments.md` must exist before the Analysis
pipeline, whether produced by discovery or materialized from the cache.

## Config (`args`)

| arg | default | meaning |
|---|---|---|
| `useIndex` | `true` | set `false` to bypass the MCP entirely (flow is then exactly the original) |
| `workspace` | `repo` | tenant scope; **sanitized** to `[a-z0-9-]` (the MCP rejects slashes), e.g. `pagopa/interop-be-monorepo` → `pagopa-interop-be-monorepo` |

If the MCP is unreachable the workflow degrades to the original discovery flow — no regressions.

## Node / workspace contract

Workspace = sanitized `owner/repo` (repo-scoped, reusable across features/slugs). Staleness is
**repo-level** (FASE 1): the indexed bundle's `commit_sha` (stored in `node.extra`) is compared to
the current branch HEAD; equal ⇒ fresh, else miss. `get_context` returns `card.extra.commit_sha`
and `body_md` verbatim, so no server change is needed.

Bundles are built deterministically by `workflows/repo_map_to_bundle.py`:

- **cartographer bundle** (`source_kind: cartographer`): one `area` node per area —
  `name=area_key`, `summary=purpose`, `body_md=<area>.md` (verbatim), `extra={paths, dependsOn,
  commit_sha, branch}`, `links: dependsOn→area`.
- **crawler bundle** (`source_kind: crawler`): one `pr` node per enriched PR —
  `name=pr-<n>`, `extra={number, state, signals, paths, commit_sha}`, `links: touches→area`
  (mapped by path prefix); plus one doc node `comments-md` (type `pr`, number 0) whose `body_md`
  is the **entire `comments.md` verbatim**, so a fresh hit restores it exactly.

Materialization on a fresh hit rebuilds `repo-map/index.md` (table from the area cards),
`repo-map/<area>.md` (each area card's `body_md`), and `comments.md` (the `comments-md` node's
`body_md`). The broker **self-verifies** all targets exist and are non-empty before reporting
`fresh` — the JS body cannot check the filesystem, so the broker is the only guard.

## Machine-readable sidecars (M4)

For deterministic parsing, cartographer/crawler also emit JSON sidecars alongside the prose:
- `repo-map/index.json` — `{ "areas": [{ area_key, purpose, paths[], dependsOn[] }] }`
  (`area_key` = the `<area>.md` filename stem, so JSON and node file join).
- `comments.index.json` — `{ "prs": [{ number, title, state, signals, paths[] }] }` (enriched PRs only).

## Robustness invariants

- The cache never overrides as-is truth: any doubt ⇒ miss ⇒ full discovery.
- Write-back is best-effort/non-fatal: an MCP failure logs a warning, never aborts the analysis.
- `ingest_bundle` is the primary write path (`schema_version: "1.0"`, validated); the indexer
  falls back to `upsert_node`/`add_link` if `ingest_bundle` is unavailable.
- `replace_edges` is asserted only for bundles that actually carry the nodes being re-linked, and
  empty bundles are omitted, so a partial/failed discovery never wipes prior edges.

## Status

**FASE 1 — implemented, reviewed, spikes green (2026-07).** Repo-level fresh/miss, write-back,
sidecars, deterministic transform. Not yet: committed to `main`, live E2E on a real repo.

## FASE 2 backlog (deferred)

Per-area staleness instead of whole-repo fresh/miss:
- diff changed paths (`gh … compare <indexedSha>…<HEAD>`) ∩ each area's key paths → stale areas only.
- **Requires new contracts that do not exist today**: a cartographer mode for *scoped* re-generation
  of only the stale areas, and a deterministic re-synthesis of `repo-map/index.md` merging fresh +
  cached areas. Crawler staleness = PRs merged since `indexedSha`.
- Configurable tolerance (`maxStaleAreas` / commit budget).

Other open items:
- `workflows/run_cost.py` `ROLE_PHASE`/`PHASE_ORDER` are stale (old Italian role names, missing
  `SRS improved`) and don't know the new phases → the RR-5 cost breakdown misclassifies the MCP
  phases. Pre-existing drift; fix separately.
