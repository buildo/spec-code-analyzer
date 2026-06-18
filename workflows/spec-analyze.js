export const meta = {
  name: 'spec-analyze',
  description: 'Spec-vs-code as a dynamic workflow, A/B-parameterized by args.variant ("prescriptive" default | "goals"): context in parallel, fan-out of N analyzers from the SRS sections, adversarial verification + bounded rework in a pipeline, reverse diff, report. The orchestration skeleton is IDENTICAL across variants — only the two experimental axes differ (axis a = spec style: step-by-step PROCEDURE vs Objective/Contract/Guardrail; axis b = discovery freedom: fixed numeric caps vs budget+judgment).',
  whenToUse: 'After the interactive preflight (credentials + gh check, fetch_atlassian.py, RF-FLOW-2 confirmation and SRS segmentation into <=10 units). Inputs are passed via args (set args.variant to pick the A/B arm). It does NOT run the fetch nor the user confirmation itself. For an A/B comparison, run both variants on the SAME repo/branch/units, into SEPARATE output dirs.',
  phases: [
    { title: 'Context', detail: 'cartographer || crawler (parallel, independent)', model: 'haiku' },
    { title: 'Analysis', detail: 'fan-out: one analyzer per SRS unit', model: 'opus' },
    { title: 'Verification', detail: 'verifier (opus) per finding + bounded rework (opus, <=1 round)', model: 'opus' },
    { title: 'Reverse diff', detail: 'reverse-scout over the definitive findings', model: 'sonnet' },
    { title: 'SRS improved', detail: 'editor (sonnet) fed by two haiku readers (SRS digest ∥ reverse-diff extract): each Work Item restructured into product requirements vs technical specs AND enriched with the reverse-diff code->spec behaviors, then an INDEPENDENT adversarial verifier + one rework over srs-improved.md (importable into a new Confluence page)', model: 'sonnet' },
    { title: 'Report', detail: 'final synthesis report.md with RR-4 and RR-5', model: 'sonnet' },
  ],
}

// ---------------------------------------------------------------------------
// args (prepared by the driver/main-loop, NOT by this script):
//   {
//     variant:    "prescriptive" | "goals",  // A/B arm (default "prescriptive"); switches the
//                                            //   role prompts (axis a) and the discovery freedom (axis b)
//     repo:       "owner/repo",
//     branch:     "develop",                 // main comparison branch (default main)
//     outputDir:  "./.spec-analyze",         // default is variant-aware: ./.spec-analyze (presc) | ./.spec-analyze-goals
//     slug:       "draft-srs-...",           // analysis folder under outputDir
//     srsPath:    "<outputDir>/<slug>/srs.md",
//     cardsPath:  "<outputDir>/<slug>/cards.md" | null,
//     units:      [ { idx: "01", titolo: "...", prose: "..." }, ... ]   // <=10, already segmented
//     mergeNote:  "free-text note about section merges performed" | null
//   }
// All artifacts live under the session launch cwd (never /tmp).
// The role names (cartographer, crawler, analyzer, verifier, reverse-scout) are the
// English working names of the plugin's agents/*.md roles (originally Italian); only
// the working language is English. The editor (srs-improved.md) is an ADDED role with
// no agents/*.md counterpart, variant-agnostic; it restructures the original SRS AND
// enriches it with the reverse-diff (code->spec) behaviors. It is itself a sub-pipeline:
// a sonnet converge step fed by two haiku readers (one per source doc). The final
// report.md is written in ITALIAN on purpose (see reportPrompt).
// ---------------------------------------------------------------------------

// Normalize args: the Workflow runtime sometimes delivers the `args` input as a
// JSON STRING instead of a parsed object (in which case args?.repo is undefined and
// args?.units is not an array). Parse defensively so the workflow works either way.

const A = (typeof args === 'string')
  ? (() => { try { return JSON.parse(args) } catch { return {} } })()
  : (args || {})

const repo = A.repo
const branch = A.branch || 'main'
// A/B arm: anything other than the literal 'goals' falls back to 'prescriptive' (backward-compatible
// with the 3 prior runs + the driver doc, which launch WITHOUT a variant).
const VARIANT = (A.variant === 'goals') ? 'goals' : 'prescriptive'
// Default output-dir is variant-aware so the two arms NEVER mix artifacts (compartmentalization,
// like the original two plugins). The driver may still override outputDir explicitly.
const outputDir = A.outputDir || (VARIANT === 'goals' ? './.spec-analyze-goals' : './.spec-analyze')
const slug = A.slug
const srsPath = A.srsPath || `${outputDir}/${slug}/srs.md`
const cardsPath = A.cardsPath || null
const units = Array.isArray(A.units) ? A.units : []
const mergeNote = A.mergeNote || null

if (!repo || !slug || units.length === 0) {
  throw new Error('Missing args: repo, slug and a non-empty units[] are required. Run the interactive driver first (preflight + fetch + confirmation + segmentation).')
}

// Defend every unit (idx + titolo present), else labels/paths become "...undefined".
// Keep the ORIGINAL position so the error message points at the right unit.
const badUnits = units
  .map((u, i) => ({ u, i }))
  .filter(({ u }) => !u || !u.idx || !(u.titolo ?? u.title))
if (badUnits.length > 0) {
  throw new Error(`Malformed args.units: every unit needs a non-empty 'idx' and 'titolo'. Offending units: ${badUnits.map(({ u, i }) => u?.idx ?? `#${i}`).join(', ')}.`)
}

// Defend against duplicate idx: they collide on labels (analyzer:<idx>), on
// reviews/<idx>-… naming, and on the report overview/verdicts rows.
const dupIdx = units.map((u) => u.idx).filter((id, i, all) => all.indexOf(id) !== i)
if (dupIdx.length > 0) {
  throw new Error(`Duplicate args.units idx: ${[...new Set(dupIdx)].join(', ')}. Each unit needs a unique idx (the driver should number/merge sections accordingly).`)
}

const base = `${outputDir}/${slug}`

// RF-FLOW-4 cap guard (the driver should merge sections beyond 10, but never truncate silently).
if (units.length > 10) {
  log(`WARNING: ${units.length} units exceed the RF-FLOW-4 cap of 10 analyzers — the driver should have merged sections. Proceeding WITHOUT silent truncation, but this exceeds the prescriptive cap.`)
}

// ---------------------------------------------------------------------------
// Token-cost ceiling for THIS workflow run (NOT in the original spec; added on top).
// budget.spent() is the WHOLE-TURN shared output-token pool, so we measure the DELTA
// from workflow start. This is a BEST-EFFORT ceiling enforced at agent-spawn
// checkpoints (skip-with-flag, never silent): the runtime's hard auto-throw only
// kicks in when the USER sets a "+Nk" directive (budget.total). We keep a reserve so
// a (partial) report can always be written. Skips are recorded for RR-5.
// ---------------------------------------------------------------------------
const TOKEN_CAP = 500_000
const REPORT_RESERVE = 40_000 // headroom kept for the final report agent

// ---------------------------------------------------------------------------
// Per-role model strategy (tweak one line to re-balance cost/quality).
// Values: 'opus' (max correctness) | 'sonnet' (balanced) | 'haiku' (cheap/fast).
// Rationale: the 3 correctness-critical roles (analyzer, verifier, rework)
// stay on Opus; the 2 mechanical discovery roles go Haiku (also much faster);
// the 2 secondary/synthesis roles go Sonnet. Cost lever: drop verifier→'sonnet'
// for a bigger saving at the cost of adversarial catch-rate on subtle cases.
// NOTE (A/B): a mixed-model run is NOT cost-comparable 1:1 with a uniform-Opus
// run — this is surfaced in RR-5.
// ---------------------------------------------------------------------------
const MODELS = {
  cartographer: 'haiku',
  crawler: 'haiku',
  analyzer: 'opus',
  verifier: 'opus',
  rework: 'opus',
  reverseScout: 'sonnet',
  editorReader: 'haiku',  // the two doc-readers spawned under the editor (SRS digest + reverse-diff extract)
  editor: 'sonnet',       // the converge + rework step that assembles/enriches srs-improved.md
  editorVerify: 'sonnet', // the independent adversarial verifier of srs-improved.md
  report: 'sonnet',
}
const modelMix = Object.entries(MODELS).map(([k, v]) => `${k}=${v}`).join(', ')

// ---------------------------------------------------------------------------
// A/B experimental axes (declared verbatim in RR-5). The TWO axes are the only
// thing that differs between the variants; everything else (skeleton, models,
// token cap, fan-out<=10, rework<=1, verifier, schemas) is kept symmetric.
//   axis (a) = specification STYLE of the role prompts
//   axis (b) = discovery FREEDOM (procedural determinism on PR/comment discovery)
// ---------------------------------------------------------------------------
const AXES = (VARIANT === 'goals')
  ? {
      style: 'GOALS',
      styleDesc: 'roles/playbook expressed as Objective / Input / Output-contract / Guardrail-invariants — outcomes constrained, not the steps ("vincola gli esiti, non i percorsi")',
      discovery: 'BUDGET + JUDGMENT — no fixed numeric ceilings on discovery; the agent decides how many PRs to enrich within a reasonable cost budget, flagging every cut (never a silent truncation). The role boundary (crawler = global bulk harvester; analyzer = targeted gap-fill) and the cost guardrails fan-out<=10 / rework<=1 are kept',
    }
  : {
      style: 'PRESCRIPTIVE',
      styleDesc: 'roles/playbook as step-by-step numbered PROCEDUREs',
      discovery: 'FIXED NUMERIC CAPS — ~30 enriched PRs (crawler) and <=3 new PRs per section (analyzer gap-fill), plus the S1-S4 signal taxonomy',
    }
const startSpent = budget?.spent?.() ?? 0
const spentHere = () => (budget?.spent?.() ?? startSpent) - startSpent
const analysisBudgetExhausted = () => spentHere() >= (TOKEN_CAP - REPORT_RESERVE)
const budgetSkipped = []
let budgetHit = false
const flagBudget = (what) => {
  budgetHit = true
  log(`TOKEN CAP: ~${spentHere()}/${TOKEN_CAP} in-workflow tokens — skipping ${what} (flagged, NOT silently truncated).`)
}

// Shared preamble for every role: invariants, enums, and gh/branch tips.
const COMMON = `
SHARED CONTEXT
- Repository: ${repo}  ·  main branch (as-is truth): ${branch}
- analysis output-dir: ${base}
- repo-map (reusable, repo-scoped): ${outputDir}/repo-map/
- SRS: ${srsPath}${cardsPath ? `  ·  Jira cards/PRs: ${cardsPath}` : '  ·  (no cards.md)'}

CROSS-CUTTING INVARIANTS (follow them to the letter)
- AS-IS truth of branch ${branch}: always read code with ?ref=${branch}.
- COVERAGE STATUS enum: fully_covered | partially_covered | not_covered | uncertain.
- GAP enum: missing | partial | different_approach. Use n/a ONLY when status = uncertain (spec absent or indeterminable).
- PULL-based consultation: read the indexes first (repo-map/index.md, the PR->path index of comments.md), then ONLY what you need. No push injection, zero re-downloads.
- PR discovery goes beyond Jira links; never silently truncate (every limit reached must be flagged).
- SECRETS never in artifacts: the Atlassian token lives only in the environment or in the gitignored .env.
- TOOLS / least privilege (RF-PKG-4): NEVER use Edit, Task/Agent, WebFetch or WebSearch. Use ONLY the tools listed in your role's "TOOLS:" line below; write ONLY to the paths your role owns.

gh TIPS (robustness, already observed on this monorepo)
- 'gh pr ...' and GraphQL may return 401 with an active account: in that case fall back to REST 'gh api'.
- Files >1MB (e.g. OpenAPI bffApi.yml / m2m): use header 'Accept: application/vnd.github.raw' (gh api -H ...).
- File content: gh api "repos/${repo}/contents/<path>?ref=${branch}" --jq .content | base64 -d.
`.trim()

// ---------------------------------------------------------------------------
// Structured-output schemas
// ---------------------------------------------------------------------------
const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['idx', 'titolo', 'stato', 'findingPath'],
  properties: {
    idx: { type: 'string', description: 'section index <NN>' },
    titolo: { type: 'string', description: 'section title' },
    stato: { type: 'string', enum: ['fully_covered', 'partially_covered', 'not_covered', 'uncertain'] },
    gap: { type: 'string', enum: ['missing', 'partial', 'different_approach', 'n/a'] },
    findingPath: { type: 'string', description: 'path of the findings/<NN>-<section>.md file written' },
    note: { type: 'string', description: '1-2 line summary' },
  },
}

const VERIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['idx', 'verdetto', 'reviewPath'],
  properties: {
    idx: { type: 'string' },
    verdetto: { type: 'string', enum: ['confirmed', 'revise'] },
    reviewPath: { type: 'string' },
    contestazioni: { type: 'string', description: 'if revise: pointed, actionable list of objections; otherwise empty' },
  },
}

const EDITOR_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['srsImprovedPath'],
  properties: {
    srsImprovedPath: { type: 'string', description: 'path of the improved SRS markdown written (srs-improved.md)' },
    sectionsSplit: { type: 'number', description: 'number of Work Items restructured into product/technical' },
    enrichedFromReverseDiff: { type: 'number', description: 'number of reverse-diff behaviors placed in the improved SRS, incl. the implementation-notes appendix (0 if reverse-diff absent)' },
    summary: { type: 'string', description: 'one-line summary (state how many reverse-diff items were merged as requirements vs parked in the implementation-notes appendix)' },
  },
}

// Verdict of the independent adversarial verifier run against srs-improved.md (in-band, no file).
const EDITOR_VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'revise'] },
    objections: { type: 'string', description: 'if revise: pointed, actionable list of objections (quote offending lines/sections); otherwise empty' },
  },
}

// Digest emitted by the haiku SRS reader spawned under the editor: faithful technical
// content per Work Item + any product-intent sentences + verbatim non-WI sections, so
// the sonnet converge step can author the product view and assemble the technical view.
const SRS_DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['workItems'],
  properties: {
    workItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['heading'],
        properties: {
          heading: { type: 'string', description: 'the [Work Item N] heading, verbatim' },
          product: { type: 'array', items: { type: 'string' }, description: 'sentences in the WI that already express user need / feature goal / business outcome (often few or none) — raw material for the authored product view' },
          technical: { type: 'array', items: { type: 'string' }, description: 'the WI body kept FAITHFUL (the HOW), snippets/identifiers verbatim, file paths and line refs DROPPED' },
          subheadings: { type: 'array', items: { type: 'string' }, description: 'pre-existing sub-headings inside the WI, verbatim' },
        },
      },
    },
    otherSections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['heading'],
        properties: {
          heading: { type: 'string', description: 'non-WI section heading — esp. Overview, Vincoli e assunzioni, Assunzioni funzionali, UI/UX (product-context, mined for the product view), plus Scenari di test, Change log, ...' },
          body: { type: 'string', description: 'the section body verbatim (to be copied unchanged / mined for product context)' },
        },
      },
    },
  },
}

// Digest emitted by the haiku reverse-diff reader spawned under the editor: the
// behaviors that ARE in code but ABSENT from the SRS, each mapped to the WI it
// best belongs to (or "none" for a tail section).
const REVDIFF_DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['present', 'behaviors'],
  properties: {
    present: { type: 'boolean', description: 'true if reverse-diff.md existed and was non-empty' },
    behaviors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['titolo', 'targetWorkItem', 'specWorthy'],
        properties: {
          titolo: { type: 'string', description: 'short Italian title of the undocumented behavior' },
          specWorthy: { type: 'boolean', description: 'true if it is a contract / business rule / error-semantics / observable behavior the SRS OUGHT to document; false if incidental implementation detail (internal status-code choice, in-memory optimization, etc.)' },
          productReq: { type: 'string', description: 'one-line requirement in SRS voice (the behavior as a rule/outcome, Italian); fill ONLY if it has a genuine user/business dimension, else ""' },
          technicalDetail: { type: 'string', description: 'the behavior as a spec statement in Italian (NOT a diff note); endpoints/identifiers/snippets/db-entities verbatim, NO file paths or line numbers' },
          codeRefs: { type: 'string', description: 'code references path:line — INTERNAL traceability only, never written into the document' },
          targetWorkItem: { type: 'string', description: 'the [Work Item N] heading it best belongs to, or "none"' },
          why: { type: 'string', description: 'why it is absent from the SRS' },
        },
      },
    },
  },
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['reportPath'],
  properties: {
    reportPath: { type: 'string', description: 'path of the report.md written' },
    summary: { type: 'string', description: 'one-line summary of the coverage outcome' },
  },
}

// ---------------------------------------------------------------------------
// Role prompts (inlined, faithful to the prescriptive variant's agents/*.md)
// ---------------------------------------------------------------------------
const cartographerPrompt = `${COMMON}

ROLE: CARTOGRAPHER (RF-7) - repository map, run ONCE.
TOOLS: Bash, Read, Write only.
Build the as-is orientation of the repo for all the other roles. Do NOT read file contents: produce orientation only.

PROCEDURE
1. Get the repo tree: gh api "repos/${repo}/git/trees/${branch}?recursive=1" --jq '.tree[] | select(.type=="blob") | .path'. If truncated, supplement with gh api repos/${repo}/contents/<dir> on the main directories.
2. Group the paths into coherent AREAS/modules (by top-level folder, domain or layer - your judgment). Aim for 5-15 compact nodes.
3. For each area write a node ${outputDir}/repo-map/<area>.md with: area purpose, key paths (no content), optional dependsOn.
4. Write ${outputDir}/repo-map/index.md as the first consultable thing: a | area | node | purpose | table listing every node.

OUTPUT: write ONLY inside ${outputDir}/repo-map/. No file content, compact nodes, as-is ${branch}, no secrets.
Return a short text summary (number of areas, index path).`

const crawlerPrompt = `${COMMON}

ROLE: CRAWLER (RF-8, §10.1) - PR & comment discovery, stage A, run ONCE, in PARALLEL with the cartographer (you do NOT depend on repo-map/). You are the ONLY bulk harvester of comments.
TOOLS: Bash, Read, Write only.

PROCEDURE
1. Discover candidate PRs from ALL these signals:
   - S1: PRs from Jira remote links (the index at the tail of ${cardsPath || 'cards.md'}, if present);
   - S2: epic/card issue keys in titles/body/commits (gh search prs --repo ${repo} "<KEY>", gh pr list --search "<key>");
   - S3: feature key terms extracted from ${srsPath} (search over titles/body);
   - S4: OPEN PRs against ${branch} (gh pr list --state open --base ${branch}) = context, NOT coverage.
2. Enrich each candidate in a single call: gh pr view <n> --json number,title,state,files,author,body. Judge relevance vs domain/spec. Irrelevant ones are DISCARDED and listed at the tail with a one-line reason (no silent truncation).
3. Collect comments from the relevant PRs (review comments with file:line, issue comments, review bodies: gh pr view <n> --json reviews,comments; gh api repos/${repo}/pulls/<n>/comments). Filter noise (bots, LGTM, CI, pleasantries); dedupe (same author + same text).
4. LIMIT: at most ~30 enriched PRs; beyond that keep the most relevant ones and FLAG the cut.

OUTPUT: ${base}/comments.md. At the HEAD the PR->path index: | PR | Title | State | Signals | Touched paths |. Then one section per PR with the selected comments (author, file:line, text). At the tail the discarded PRs with reason.
Discovery does NOT stop at Jira links; open PRs = context; no secrets.
Return a short summary (candidate PRs, enriched, discarded, any cut).`

const analyzerPrompt = (u) => `${COMMON}

ROLE: ANALYZER (RF-9, §10.2) - spec->code coverage for ONE section, in fan-out. You are NOT a bulk harvester: broad discovery belongs to the crawler; you only do targeted gap-fill on your own paths.
TOOLS: Bash, Read, Grep, Write only.

ASSIGNED SECTION
- index: ${u.idx}
- title: ${u.titolo ?? u.title}
- requirement prose:
${u.prose ?? u.prosa ?? '(prose not provided - re-read the matching section in ' + srsPath + ')'}

PROCEDURE
1. Read ${outputDir}/repo-map/index.md, then ONLY the repo-map/<area>.md nodes relevant to the section.
2. Locate the as-is code: infer likely paths from the map nodes and confirm them with gh search code / gh api repos/${repo}/contents/<path>?ref=${branch}. You may look beyond the map if needed.
3. Read the relevant code via gh (gh api ".../contents/<path>?ref=${branch}" --jq .content | base64 -d).
4. Consult ${base}/comments.md IN PULL by path: match your paths against the PR->path index (by file or directory) and read ONLY the comments of the PRs that touch them. Zero re-downloads.
5. Gap-fill for paths NOT covered by the index: gh api "repos/${repo}/commits?path=<file>&sha=${branch}" -> associated PRs. CAP: <=3 new PRs per section. Mark them as "code-side discovery (gap-fill)".
6. Write the finding.

OUTPUT: ${base}/findings/${u.idx}-<section>.md with: status (enum), notes + code references (path:line), gap (enum), open doubts, and an optional "code-side discovered PRs" section.
As-is truth; enums to the letter; pull-based consultation; gap-fill <=3 PRs; no secrets.
Return the structured object (idx, titolo, stato, gap, findingPath, note).`

const verifierPrompt = (idx, titolo, findingPath) => `${COMMON}

ROLE: VERIFIER (RF-13) - adversarial review of ONE finding. Your job is to FALSIFY, not to confirm. You are the critic, separate from the author: do NOT rewrite the finding, find its weaknesses.
TOOLS: Bash, Read, Grep, Write only.

INPUT
- finding to verify: ${findingPath} (section ${idx} - ${titolo})
- matching SRS section in ${srsPath}; repo-map/ and comments.md in pull; as-is code via gh (?ref=${branch}).

PROCEDURE
1. Re-read the section's requirement prose and the finding.
2. Verify that EVERY cited code reference ACTUALLY exists on branch ${branch} (file and line) and that it SUPPORTS the declared status. Flag non-existent or irrelevant references (also check for off-by-one on the lines).
3. Independently RE-LOCATE the section's as-is code looking for coverage or gaps NOT seen by the analyzer.
4. Check correct use of the status/gap enums and respect for as-is truth.
5. Emit the verdict.

OUTPUT: ${base}/reviews/${idx}-<section>.md with: verdict (confirmed | revise); if revise, the pointed and ACTIONABLE list of objections.
Do NOT rewrite the finding (critic != author). Be adversarial: on well-founded doubt, object. Write only inside reviews/. No secrets.
Return the structured object (idx, verdetto, reviewPath, contestazioni).`

const reworkPrompt = (idx, titolo, findingPath, objections) => `${COMMON}

ROLE: ANALYZER - REWORK (RF-FLOW-5), a single round.
TOOLS: Bash, Read, Grep, Write only.
The verifier issued a 'revise' verdict on the finding ${findingPath} (section ${idx} - ${titolo}).
Address the objections below and REWRITE ${findingPath} as the DEFINITIVE version (single round: if something stays unresolvable, note it in the finding as a "residual objection").

VERIFIER OBJECTIONS:
${objections}

Keep the finding contract (status enum, path:line references verified on ${branch}, gap enum, doubts, any code-side PRs). As-is truth; no secrets.
Return the updated structured object (idx, titolo, stato, gap, findingPath, note).`

const reverseScoutPrompt = `${COMMON}

ROLE: REVERSE-SCOUT (RF-10) - reverse diff code->spec, run AFTER verification. Mirror of the analyzer: start from the CODE and look for what is NOT documented in the SRS.
TOOLS: Bash, Read, Glob, Grep, Write only.

PROCEDURE
1. Enumerate ${base}/findings/*.md and collect the paths/areas already covered by the sections.
2. Compare against ${outputDir}/repo-map/ and the PR->path index of ${base}/comments.md: AREAS with PR activity but NO findings are the natural candidates for undocumented behavior.
3. For the candidates, inspect the as-is code via gh (?ref=${branch}) and find behaviors, endpoints, rules or edge cases ABSENT from the SRS.
4. Write the reverse diff.

OUTPUT: ${base}/reverse-diff.md - a list of undocumented behaviors, with code references (path:line) and a note on why they are not covered by the SRS.
The reverse-diff.md MUST be written in ITALIAN (headings and prose in Italian), consistently with report.md; keep code references, paths, identifiers and code snippets verbatim (do NOT translate code).
As-is truth; pull-based consultation; you may split by code area if it is large; no secrets.
Return a short summary (number of entries).`

// ---------------------------------------------------------------------------
// GOALS-variant role prompts (faithful to spec-tool-goals.md §8.4 / §10).
// SAME COMMON preamble, SAME assigned-section block, SAME output contract and
// SAME enums as the prescriptive prompts above — ONLY the body switches from a
// numbered PROCEDURE to Objective / Output-contract / Guardrail-invariants, and
// the discovery caps become "budget + judgment". This is exactly axis (a)+(b).
// ---------------------------------------------------------------------------
const cartographerPromptGoals = `${COMMON}

ROLE: CARTOGRAPHER (RF-7) - repository map, run ONCE. GOALS STYLE (constrain the outcome, not the steps).
TOOLS: Bash, Read, Write only.

OBJECTIVE: produce enough as-is orientation of the repo that the other roles can locate code without re-reading everything. Orientation only - do NOT read file contents.
OUTPUT CONTRACT: a segmented repo-map/ under ${outputDir}/repo-map/ - index.md FIRST (a | area | node | purpose | table, the first consultable thing) plus one compact <area>.md node per coherent area (purpose, key paths WITHOUT content, optional dependsOn). Write ONLY inside ${outputDir}/repo-map/.
GUARDRAILS/INVARIANTS: no file content; compact nodes; repo-scoped & reusable; as-is truth of ${branch}; no secrets; minimal tools. HOW you build it (which gh calls, how you group the areas, aim ~5-15 nodes) is YOUR judgment.
Return a short text summary (number of areas, index path).`

const crawlerPromptGoals = `${COMMON}

ROLE: CRAWLER (RF-8, §10.1) - PR & comment discovery, run ONCE, in PARALLEL with the cartographer (you do NOT depend on repo-map/). GOALS STYLE. You are the ONLY bulk harvester of comments.
TOOLS: Bash, Read, Write only.

OBJECTIVE: a pre-localization overview of the PRs and comments relevant to this feature/domain.
OUTPUT CONTRACT: ${base}/comments.md with, at the HEAD, an index that makes the comments consultable BY PATH (at least: | PR | Title | State | Signals | Touched paths |) and, below, the selected comments per PR (author, file:line, text); the discarded PRs listed at the tail with a one-line reason.
GUARDRAILS/INVARIANTS: discovery does NOT stop at Jira links - draw on AT LEAST Jira remote links, issue keys, feature terms from ${srsPath}, OPEN PRs against ${branch}, AND any other useful signal, by judgment (the concrete queries/commands are YOURS to choose); dedupe (same author+text) and filter noise (bots, LGTM, CI); OPEN PRs = context, NOT coverage. COST BUDGET, NO FIXED NUMERIC CEILING: keep the number of enriched PRs reasonable, prioritize by relevance, and FLAG every cut - never a silent truncation. Judgment decides how many PRs deserve enrichment. No secrets.
Return a short summary (candidate PRs, enriched, discarded, any flagged cut).`

const analyzerPromptGoals = (u) => `${COMMON}

ROLE: ANALYZER (RF-9, §10.2) - spec->code coverage for ONE section, in fan-out. GOALS STYLE. You are NOT a bulk harvester: broad discovery belongs to the crawler.
TOOLS: Bash, Read, Grep, Write only.

ASSIGNED SECTION
- index: ${u.idx}
- title: ${u.titolo ?? u.title}
- requirement prose:
${u.prose ?? u.prosa ?? '(prose not provided - re-read the matching section in ' + srsPath + ')'}

OBJECTIVE: establish, for your section, how much the as-is code on ${branch} covers it and where the gaps are.
OUTPUT CONTRACT: ${base}/findings/${u.idx}-<section>.md with status (enum), notes + code references (path:line), gap (enum), open doubts, and an optional "code-side discovered PRs" section.
GUARDRAILS/INVARIANTS: evaluate on as-is truth; consult ${outputDir}/repo-map/ and ${base}/comments.md IN PULL (read the indexes first, then ONLY what you need - zero re-downloads); you MAY look beyond the map; STAY IN ROLE - for paths NOT covered by the comments index do TARGETED gap-fill with a CONTAINED BUDGET, marking those PRs as "code-side discovery", WITHOUT becoming a second crawler and WITHOUT re-downloads (no fixed numeric cap - judgment decides what is enough); respect the enums to the letter; no secrets. In rework (RF-FLOW-5) you receive the verifier's objections and produce the definitive version. HOW you locate the code is YOUR judgment.
Return the structured object (idx, titolo, stato, gap, findingPath, note).`

const verifierPromptGoals = (idx, titolo, findingPath) => `${COMMON}

ROLE: VERIFIER (RF-13) - adversarial review of ONE finding. GOALS STYLE. Your job is to FALSIFY, not to confirm (critic != author).
TOOLS: Bash, Read, Grep, Write only.

INPUT
- finding to verify: ${findingPath} (section ${idx} - ${titolo})
- matching SRS section in ${srsPath}; repo-map/ and comments.md in pull; as-is code via gh (?ref=${branch}).

OBJECTIVE: falsify the finding - surface unsupported verdicts, non-existent references, coverage/gaps missed or overstated, enums used wrongly, as-is violations.
OUTPUT CONTRACT: ${base}/reviews/${idx}-<section>.md with verdict ∈ {confirmed, revise} and, if revise, a pointed and ACTIONABLE list of objections. Write ONLY inside reviews/.
GUARDRAILS/INVARIANTS: do NOT rewrite the finding; VERIFY the real existence of EVERY cited reference on ${branch} (file+line, watch off-by-one) and that it SUPPORTS the declared status; independently re-locate the section's as-is code; be adversarial (seek weaknesses, do NOT rubber-stamp); no secrets. HOW you conduct the verification is YOUR judgment.
Return the structured object (idx, verdetto, reviewPath, contestazioni).`

const reworkPromptGoals = (idx, titolo, findingPath, objections) => `${COMMON}

ROLE: ANALYZER - REWORK (RF-FLOW-5), a single round. GOALS STYLE.
TOOLS: Bash, Read, Grep, Write only.
The verifier issued a 'revise' verdict on the finding ${findingPath} (section ${idx} - ${titolo}).

OBJECTIVE: address the objections below and REWRITE ${findingPath} as the DEFINITIVE version (single round: if something stays unresolvable, note it in the finding as a "residual objection").
VERIFIER OBJECTIONS:
${objections}
OUTPUT CONTRACT / GUARDRAILS: keep the finding contract (status enum, path:line references verified on ${branch}, gap enum, doubts, any code-side PRs); as-is truth; no secrets.
Return the updated structured object (idx, titolo, stato, gap, findingPath, note).`

const reverseScoutPromptGoals = `${COMMON}

ROLE: REVERSE-SCOUT (RF-10) - reverse diff code->spec, run AFTER verification. GOALS STYLE. Mirror of the analyzer: start from the CODE and find what is NOT documented in the SRS.
TOOLS: Bash, Read, Glob, Grep, Write only.

OBJECTIVE: identify behaviors in the code (endpoints, rules, edge cases) that are undocumented in the SRS.
OUTPUT CONTRACT: ${base}/reverse-diff.md - a list of undocumented behaviors with code references (path:line) and a note on why the SRS does not cover them. It MUST be written in ITALIAN (headings and prose), consistently with report.md; keep code references, paths, identifiers and code snippets verbatim (do NOT translate code).
GUARDRAILS/INVARIANTS: as-is truth; areas with PR activity but NO findings are the natural candidates; pull-based consultation; you may split by code area if it is large (still an outcome); no secrets. HOW you hunt is YOUR judgment.
Return a short summary (number of entries).`

// Variant selector: the orchestration below references P.* only — the skeleton is identical.
const P = (VARIANT === 'goals')
  ? { cartographer: cartographerPromptGoals, crawler: crawlerPromptGoals, analyzer: analyzerPromptGoals, verifier: verifierPromptGoals, rework: reworkPromptGoals, reverseScout: reverseScoutPromptGoals }
  : { cartographer: cartographerPrompt, crawler: crawlerPrompt, analyzer: analyzerPrompt, verifier: verifierPrompt, rework: reworkPrompt, reverseScout: reverseScoutPrompt }

// Editor: markdown in, markdown out. The improved SRS is a derivative PROPOSAL
// the user reviews and imports into a NEW Confluence page (Insert > Markup > Markdown).
// Variant-agnostic restructuring, now ENRICHED with the reverse-diff (code->spec)
// behaviors. Topology: the sonnet converge step is fed by two haiku readers (one per
// source doc) that run in parallel and converge back into the converge step.
const editorOut = `${base}/srs-improved.md`
const reverseDiffPath = `${base}/reverse-diff.md`

// Shared editor policy — reused VERBATIM by the SRS-reader (classifier) and the converge step,
// so both agree on (a) product requirement vs technical spec and (b) the ban on code references.
// The quoted Italian strings are LITERALS the editor must emit (the output doc is Italian).
const EDITOR_BUCKETS = `
PRODUCT vs TECHNICAL — two DERIVED VIEWS of each Work Item, NOT a verbatim partition of its sentences:
- "Requisiti di prodotto" = a SYNTHESIZED, GROUNDED product view: the user need, the feature goal/value, the observable behavior/outcome and business rules as the user/consumer experiences them (acceptance-style where natural). You MAY rephrase and condense — it need NOT be verbatim or same-length — but every statement MUST be traceable to the SRS. Draw the product framing from the product-context sections (Overview, Vincoli e assunzioni, Assunzioni funzionali, UI/UX) AND the Work Item's own intent. Invent nothing. If a Work Item is purely technical/enabling (no user-facing dimension), the product subsection is exactly: "_(nessun requisito di prodotto dedicato: WI tecnico/abilitante)_".
- "Specifiche tecniche" = the HOW, kept FAITHFUL and LOSSLESS from the Work Item body: endpoints & contracts, request/response shapes, validations, config parameters, events, db entities/tables/columns, schemas, protobuf events, merge/migration ordering, implementation notes. No technical fact may be dropped or invented.
- FIDELITY IS ASYMMETRIC: the technical view loses nothing and invents nothing; the product view may rephrase but adds no facts not in the SRS. A detail is product ONLY if it expresses a user need, feature goal or business value; otherwise it is technical.`.trim()

const EDITOR_NO_CODE_REFS = `
NO CODE REFERENCES in the document (files and line numbers change over time — keep them out):
- FORBIDDEN: file paths (e.g. packages/.../config.ts), line numbers, :NN-NN ranges, "Riferimento codice:" labels, source file names.
- ALLOWED: code snippets (\`\`\` blocks), event names (e.g. PurposeTemplateEServiceTemplateLinkedV2), db entities/tables/columns (e.g. eservice_template_version_purpose_template), API endpoints (e.g. POST /purposeTemplates/:id/linkEserviceTemplates).`.trim()

// Haiku reader #1 — reads the ORIGINAL SRS and emits the per-WI product/technical split.
const srsReaderPrompt = `${COMMON}

ROLE: EDITOR / SRS-READER - haiku reader under the editor. Read ONLY ${srsPath}. TOOLS: Read, Glob, Grep only.
GOAL: digest the FULL SRS into the structured object below for the converge step (which authors the product view + assembles the technical view). You do NOT write the final document.

${EDITOR_NO_CODE_REFS}

RULES
1. For every "[Work Item N]": fill technical[] with the WI body kept FAITHFUL (the HOW — endpoints, events, db entities, validations, ordering, impl notes), snippets/SQL/identifiers verbatim but file paths and line references DROPPED; fill product[] with any sentences in the WI that ALREADY express a user need / feature goal / business outcome (often few or none — that is fine, the converge step authors the product view from these plus the product-context sections).
2. Record pre-existing sub-headings inside each WI verbatim (subheadings[]).
3. Copy EVERY non-WI section VERBATIM into otherSections[] (heading + body) — especially Overview, Vincoli e assunzioni, Assunzioni funzionali, UI/UX (the converge step mines these for product framing), plus Scenari di test, Change log, etc.
4. Don't invent or duplicate. technical[] must be COMPLETE for each WI; a stripped code reference is the only allowed removal.

Return the structured object (workItems[], otherSections[]).`

// Haiku reader #2 — reads the reverse-diff and extracts the code->spec behaviors to merge in.
const revReaderPrompt = `${COMMON}

ROLE: EDITOR / REVERSE-DIFF-READER - haiku reader under the editor. Read ONLY ${reverseDiffPath}. TOOLS: Read, Glob, Grep only.
GOAL: extract the behaviors that ARE in the code but ABSENT from the SRS, so the converge step can enrich the improved SRS.

RULES
1. If ${reverseDiffPath} is missing or empty, return { present: false, behaviors: [] } (Glob/Grep to check; do NOT error).
2. For EACH undocumented behavior emit: titolo; specWorthy (true if it is a contract / business rule / error-semantics / observable behavior the SRS OUGHT to document; false if incidental implementation detail — e.g. an internal status-code choice, an in-memory optimization); productReq (one-line requirement in SRS voice — the behavior as a rule/outcome, Italian — fill ONLY if it has a genuine user/business dimension, else ""); technicalDetail (the behavior phrased as a spec statement in Italian, NOT as a diff note — keep endpoints/identifiers/snippets/db-entities verbatim, NO file paths or line numbers); codeRefs (path:line, INTERNAL traceability only — never written to the document); why (why it is absent from the SRS).
3. targetWorkItem: map to the "[Work Item N]" it best belongs to, or "none".
4. Extract, don't invent. The reverse diff is ITALIAN; keep it Italian.

Return the structured object (present, behaviors[]).`

// Sonnet converge — assembles the improved SRS from the two digests and enriches it.
const editorConvergePrompt = (srsDigest, revDigest, reverseDiffExpected) => `${COMMON}

ROLE: EDITOR (SRS-IMPROVED) - the CONVERGE step. Two haiku readers digested the source docs; you assemble the final document and ENRICH it with the reverse-diff behaviors.
TOOLS: Read, Write, Glob, Grep only. You MAY Read ${srsPath} and ${reverseDiffPath} to verify; write ONLY ${editorOut}.

INPUT (from the two haiku readers):
- SRS digest (per-WI faithful technical[] + product-intent product[] + verbatim non-WI sections, incl. the product-context sections):
${JSON.stringify(srsDigest, null, 2)}
- Reverse-diff digest (code->spec behaviors with specWorthy flags; reverse-diff ${reverseDiffExpected ? 'was produced this run' : 'was NOT produced — expect present:false'}):
${JSON.stringify(revDigest, null, 2)}

GOAL: write ${editorOut}, ITALIAN markdown, same structure/tone/style as the SRS, restructured AND enriched.

These two policies apply to the WHOLE document (original content AND enrichment):
${EDITOR_BUCKETS}

${EDITOR_NO_CODE_REFS}

RESTRUCTURE (two derived views per Work Item)
1. Split every "[Work Item N]" into two subsections, in order: "### Requisiti di prodotto" then "### Specifiche tecniche". AUTHOR "### Requisiti di prodotto" as a grounded product view: synthesize it from the WI's product[] sentences PLUS the product-context sections in the digest (Overview, Vincoli e assunzioni, Assunzioni funzionali, UI/UX) and the WI's intent; rephrase/condense freely but invent nothing and keep every statement traceable to the SRS. Build "### Specifiche tecniche" FAITHFULLY from the WI's technical[] — include all of it, drop no technical fact. Pre-existing sub-headings move under the right subsection, demoted one level.
2. FIDELITY IS ASYMMETRIC: the technical view loses no technical fact and invents none; the product view may rephrase but adds no facts not in the SRS. Purely-technical WI → product subsection is exactly "_(nessun requisito di prodotto dedicato: WI tecnico/abilitante)_".
3. Keep snippets/SQL/event names/db entities/endpoints verbatim, but STRIP every file path / line number / "Riferimento codice". Non-WI sections copied unchanged, except obvious typos ("Inoltree" -> "Inoltre") and stripped code references.
4. No empty subsections beyond the explicit "nessun requisito di prodotto" marker above.

ENRICH with the reverse diff (spec-worthy only goes into the requirements)
5. Merge ONLY specWorthy=true behaviors into the Work Items, phrased as requirement/spec statements (NOT diff notes): for one whose targetWorkItem matches a WI, add its productReq under "### Requisiti di prodotto" (only if non-empty and genuinely product-level) and its technicalDetail under "### Specifiche tecniche". Never write codeRefs. Prefix every added line with "_(da reverse-diff — presente nel codice, assente nell'SRS originale)_ ".
6. specWorthy=true with targetWorkItem="none": same treatment in a final section "## Comportamenti rilevati dal codice (reverse diff) non presenti nell'SRS originale".
7. specWorthy=false behaviors: do NOT place them among requirements — collect them (marked, same prefix) in a clearly-labeled appendix "## Rilievi implementativi (non requisiti)". Omit the appendix if there are none.
8. Enrichment is ALWAYS additive and ALWAYS marked — never fold code-derived content silently into the original prose. If the digest is present:false/empty, add no enrichment. Set enrichedFromReverseDiff to the count of behaviors actually placed in the document (requirements + appendix).

An independent adversarial verifier will check this document afterwards (asymmetric fidelity, classification, no code references, spec-worthy placement, marked enrichment) and may send it back for rework — produce your best version, you do NOT self-verify here.

WRITE: the Write tool refuses to overwrite a file not Read this session — if ${editorOut} exists, Read it first, then Write and read it back to confirm. Output is markdown for a NEW Confluence page (Insert > Markup > Markdown); write ONLY this file. Return the structured object (srsImprovedPath, sectionsSplit, enrichedFromReverseDiff, summary stating how many items became requirements vs went to the implementation-notes appendix).`

// Single adversarial verify + one rework over srs-improved.md (replaces the editor's self-check).
// The verifier is read-only: it returns objections in-band to the rework step, no review file.

// Independent adversarial verifier — tries to FALSIFY srs-improved.md against the editor contracts.
const editorVerifierPrompt = `${COMMON}

ROLE: EDITOR / ADVERSARIAL VERIFIER - independent critic of ${editorOut}. FALSIFY it, don't rubber-stamp; you did NOT write it.
TOOLS: Read, Glob, Grep only (read-only — write NOTHING). Read ${editorOut}, ${srsPath} and ${reverseDiffPath}.

The document must satisfy these contracts — hunt for ANY violation:
${EDITOR_BUCKETS}

${EDITOR_NO_CODE_REFS}

CHECKS (fidelity is ASYMMETRIC: technical lossless+faithful, product grounded but may rephrase)
A) TECHNICAL FIDELITY: every technical fact of each WI (endpoints, events, db entities, validations, ordering, impl notes) survives in "### Specifiche tecniche" — nothing dropped or invented; non-WI sections copied unchanged.
B) PRODUCT GROUNDING: "### Requisiti di prodotto" reads as a real product view (user need / goal / outcome / business rule), every claim TRACEABLE to the SRS (Overview/Vincoli/Assunzioni/UI-UX/WI) — flag invented facts AND flag implementation/functional details masquerading as product requirements. Purely-technical WI must carry the "_(nessun requisito di prodotto dedicato…)_" marker, not padding.
C) NO CODE REFERENCES: grep for ANY file path, line number, :NN-NN range or "Riferimento codice" — must be ZERO.
D) ENRICHMENT: spec-worthy reverse-diff behaviors appear among the requirements (or the trailing "Comportamenti rilevati dal codice" section), phrased as requirements not diff notes; non-spec-worthy ones appear ONLY in the "## Rilievi implementativi (non requisiti)" appendix; every added line carries the marker "_(da reverse-diff …)_"; nothing code-derived is unmarked; no codeRefs leaked.

Verdict 'confirmed' ONLY if A-D all pass; else 'revise' with a POINTED, ACTIONABLE objection list (quote the offending lines) so the rework step can fix them directly.
Return the structured object (verdict, objections).`

// One rework round — the editor fixes srs-improved.md per the verifier objections.
const editorReworkPrompt = (objections) => `${COMMON}

ROLE: EDITOR (SRS-IMPROVED) - REWORK (single round). The adversarial verifier returned 'revise' on ${editorOut}.
TOOLS: Read, Write, Glob, Grep only. Read ${editorOut} (and ${srsPath}/${reverseDiffPath} as needed); write ONLY ${editorOut}.

Policies still hold:
${EDITOR_BUCKETS}

${EDITOR_NO_CODE_REFS}

Fix EVERY objection below and rewrite ${editorOut}; preserve what's already correct, add no new violations (nothing dropped/duplicated/invented, zero code references, all enrichment marked).

VERIFIER OBJECTIONS:
${objections}

WRITE: Read ${editorOut} first (Write refuses un-Read files), overwrite it, then read it back to confirm it is your content. Return the structured object (srsImprovedPath, sectionsSplit, enrichedFromReverseDiff, summary).`

const reportPrompt = (results, verdicts, budgetInfo) => `${COMMON}

ROLE: ORCHESTRATOR - REPORT (RF-FLOW-7). Write ${base}/report.md. The report MUST be written in ITALIAN (markdown), using your judgment, reading ${base}/findings/*.md, ${base}/reviews/*.md, ${base}/reverse-diff.md (and ${base}/comments.md for PR evidence).
TOOLS: Read, Write, Glob, Grep, Bash only (no Edit/Task/WebFetch/WebSearch).

MANDATORY STRUCTURE (section headings and prose in Italian)
1. OVERVIEW: table of sections with coverage status (use the summarized results below, but verify against the findings/ files).
2. SRS -> CODE part: per section, gap, doubts, code references (path:line).
3. CODE -> SRS part: synthesis of reverse-diff.md (undocumented behaviors).
4. RR-4: distinguish sections CONFIRMED by the verifier from those REVISED or still CONTESTED (report the residual objections read from findings/reviews).
5. RR-5 - Experimental axes and execution evidence (closing chapter):
   - Declare the TWO axes of the A/B comparison and THIS run's position on each: (a) specification style = ${AXES.style} (${AXES.styleDesc}); (b) discovery freedom = ${AXES.discovery}.
   - Execution evidence: PRs discovered/enriched/discarded (from comments.md), flagged cuts, caps reached, judgment calls${mergeNote ? `, and this section merge: ${mergeNote}` : ''}.
   - FIDELITY NOTE (Workflow orchestration): unlike the Task-based variant, per-subagent tokens are NOT exposed in-band by the workflow. Report the flow TOTAL as read from the session (/cost) and the per-phase breakdown as visible in /workflows; time is read from the driver (date +%s timestamps) or from /workflows. Do not invent numbers: always state the source.
   - TOKEN CAP (added on top of the original spec): ${budgetInfo} — report this verbatim in the cost evidence, and if anything was skipped for budget, list it explicitly (no silent truncation).
   - ADDED STEP (editor, on top of the original spec): ${editorOut} (each Work Item restructured into "Requisiti di prodotto" vs "Specifiche tecniche", AND enriched with the reverse-diff code->spec behaviors, each marked with a provenance tag) is generated in PARALLEL with this report by a sonnet converge step fed by two haiku readers — list it among the deliverables in RR-5 noting it may still be in progress at report time; do NOT block on it.

ANALYSIS RESULTS (structured summary, validate against the files):
${JSON.stringify(results, null, 2)}

VERIFIER VERDICTS:
${JSON.stringify(verdicts, null, 2)}

As-is truth; enums to the letter; no secrets. Return the structured object (reportPath, summary).`

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
log(`spec-analyze (${VARIANT}) · style=${AXES.style} · ${repo}@${branch} · ${units.length} SRS units · out ${base}`)

// RF-FLOW-3 — Context in parallel (barrier: analyzers depend on repo-map/ and comments.md)
phase('Context')
const [mapResult, crawlResult] = await parallel([
  () => agent(P.cartographer, { label: 'cartographer', phase: 'Context', model: MODELS.cartographer }),
  () => agent(P.crawler, { label: 'crawler', phase: 'Context', model: MODELS.crawler }),
])
if (!mapResult || !crawlResult) {
  const failed = [!mapResult && 'cartographer (repo-map/)', !crawlResult && 'crawler (comments.md)'].filter(Boolean).join(' and ')
  throw new Error(`Context phase aborted: ${failed} failed — downstream analysis depends on it and cannot proceed reliably.`)
}

// RF-FLOW-4/5 — Fan-out analyzers -> verifier -> bounded rework, in a pipeline (no barrier between units)
const results = await pipeline(
  units,
  // stage 1: ANALYZER (skipped-with-flag if the token cap is exhausted)
  (u) => {
    if (analysisBudgetExhausted()) { budgetSkipped.push(`analyzer:${u.idx}`); flagBudget(`analyzer:${u.idx}`); return null }
    return agent(P.analyzer(u), {
      label: `analyzer:${u.idx}`,
      phase: 'Analysis',
      schema: ANALYSIS_SCHEMA,
      model: MODELS.analyzer,
    })
  },
  // stage 2: VERIFIER + bounded REWORK (<=1 round), per single unit
  async (finding, u) => {
    if (!finding) return null
    // Trust the ORIGINAL unit idx (A): keep findings/<NN> and reviews/<NN> aligned even
    // if the analyzer echoed a slightly different idx in its structured output.
    const idx = u.idx
    const titolo = finding.titolo || u.titolo || u.title || ''
    // Token cap: keep the finding but skip verification (flagged) — RNF-3 says an
    // unverified section is acceptable, surfaced in the report.
    if (analysisBudgetExhausted()) {
      budgetSkipped.push(`verifier:${idx}`)
      flagBudget(`verifier:${idx}`)
      return { ...finding, idx, verifierOutcome: 'skipped-budget', reviewPath: null }
    }
    const verdict = await agent(P.verifier(idx, titolo, finding.findingPath), {
      label: `verifier:${idx}`,
      phase: 'Verification',
      schema: VERIFIER_SCHEMA,
      model: MODELS.verifier,
    })
    if (verdict && verdict.verdetto === 'revise') {
      // Token cap: skip the rework round (flagged); the finding stays as-is with the objections on record.
      if (analysisBudgetExhausted()) {
        budgetSkipped.push(`rework:${idx}`)
        flagBudget(`rework:${idx}`)
        return { ...finding, idx, verifierOutcome: 'revise->skipped-budget', reviewPath: verdict.reviewPath }
      }
      const definitive = await agent(
        P.rework(idx, titolo, finding.findingPath, verdict.contestazioni || '(objections in the review file)'),
        { label: `rework:${idx}`, phase: 'Verification', schema: ANALYSIS_SCHEMA, model: MODELS.rework },
      )
      // B: if the rework agent died, the file was NOT rewritten — say so instead of claiming success.
      return { ...(definitive || finding), idx, verifierOutcome: definitive ? 'revise->rewritten' : 'revise->rework-failed', reviewPath: verdict.reviewPath }
    }
    return { ...finding, idx, verifierOutcome: verdict ? verdict.verdetto : 'verifier-failed', reviewPath: verdict?.reviewPath }
  },
)

const okResults = results.filter(Boolean)
if (okResults.length === 0) {
  throw new Error(`Analysis aborted: all ${units.length} analyzers failed — no findings produced, nothing to synthesize for reverse-diff/report.`)
}
const verdicts = okResults.map((e) => ({ idx: e.idx, verifierOutcome: e.verifierOutcome, reviewPath: e.reviewPath }))
log(`analysis + verification done: ${okResults.length}/${units.length} units`)

// RF-FLOW-6 — Reverse diff (after verification: uses the definitive findings; implicit barrier from awaiting the pipeline)
phase('Reverse diff')
let reverseDiffDone = false
if (analysisBudgetExhausted()) {
  budgetSkipped.push('reverse-scout')
  flagBudget('reverse-scout (reverse diff)')
} else {
  const rev = await agent(P.reverseScout, { label: 'reverse-scout', phase: 'Reverse diff', model: MODELS.reverseScout })
  // The editor enrichment depends on reverse-diff.md existing; the reader degrades gracefully if not.
  reverseDiffDone = Boolean(rev)
}

// RF-FLOW-7 — Report (always attempted within REPORT_RESERVE; documents the cap status in RR-5)
// + ADDED STEP — editor (srs-improved.md): independent of the report, so the two run in parallel.
//   The editor is itself a sub-pipeline: two haiku readers (SRS digest ∥ reverse-diff
//   extract) converge into the sonnet editor, which assembles + enriches the improved SRS,
//   then an independent adversarial verifier + one rework checks it.
//   Budget gate decided BEFORE building budgetInfo, so a skipped editor shows up in RR-5.
phase('Report')
const skipEditor = analysisBudgetExhausted()
if (skipEditor) { budgetSkipped.push('editor'); flagBudget('editor (srs-improved.md, with reverse-diff enrichment)') }
const budgetInfo = `TOKEN CAP for this run: ${TOKEN_CAP} output tokens (best-effort, enforced at agent-spawn checkpoints; runtime hard-throw only with a user "+Nk" directive). In-workflow spend (budget.spent() delta) at report time: ~${spentHere()}. Cap hit: ${budgetHit ? 'YES' : 'no'}.${budgetSkipped.length ? ` Skipped for budget (NOT silently truncated): ${budgetSkipped.join(', ')}.` : ''} PER-ROLE MODEL MIX: ${modelMix}. CAVEAT: a mixed-model run is NOT cost-comparable 1:1 with a uniform-Opus run — state this when comparing RR-5 against the goals variant.`

// Editor sub-pipeline: two haiku readers (parallel) -> sonnet converge ->
// independent adversarial verify + one rework.
const runEditor = async () => {
  if (skipEditor) return null
  const [srsDigest, revDigest] = await parallel([
    () => agent(srsReaderPrompt, { label: 'editor:srs-reader', phase: 'SRS improved', schema: SRS_DIGEST_SCHEMA, model: MODELS.editorReader }),
    () => agent(revReaderPrompt, { label: 'editor:revdiff-reader', phase: 'SRS improved', schema: REVDIFF_DIGEST_SCHEMA, model: MODELS.editorReader }),
  ])
  // The SRS digest is the backbone — without it the converge step has nothing faithful to assemble.
  if (!srsDigest) { log('WARNING: editor SRS-reader failed — skipping srs-improved.md (no faithful digest to assemble).'); return null }
  // The reverse-diff reader is best-effort: a null/absent digest just means no enrichment.
  const rev = revDigest || { present: false, behaviors: [] }
  const result = await agent(editorConvergePrompt(srsDigest, rev, reverseDiffDone), {
    label: 'editor:converge', phase: 'SRS improved', schema: EDITOR_SCHEMA, model: MODELS.editor,
  })
  if (!result) return null

  // Adversarial verify + one rework. The verifier is an INDEPENDENT critic that tries to
  // falsify srs-improved.md; on 'revise' the editor reworks the file once (revise after that is on record).
  const verdict = await agent(editorVerifierPrompt, { label: 'editor:verify', phase: 'SRS improved', schema: EDITOR_VERIFY_SCHEMA, model: MODELS.editorVerify })
  if (!verdict) { log('WARNING: editor adversarial verifier failed — keeping the unverified srs-improved.md.'); return { ...result, editorVerify: 'verify-failed' } }
  if (verdict.verdict === 'confirmed') { log('editor adversarial verify: confirmed.'); return { ...result, editorVerify: 'confirmed' } }
  log('editor adversarial verify: revise — one rework round.')
  const reworked = await agent(editorReworkPrompt(verdict.objections || '(verifier returned revise without objections — re-check all contracts)'), { label: 'editor:rework', phase: 'SRS improved', schema: EDITOR_SCHEMA, model: MODELS.editor })
  if (!reworked) { log('WARNING: editor rework failed — keeping the pre-rework srs-improved.md with objections on record.'); return { ...result, editorVerify: 'revise->rework-failed' } }
  return { ...reworked, editorVerify: 'revise->reworked' }
}

const [improved, report] = await parallel([
  runEditor,
  () => agent(reportPrompt(okResults, verdicts, budgetInfo), { label: 'report', phase: 'Report', schema: REPORT_SCHEMA, model: MODELS.report }),
])
if (!report) log(`WARNING: report agent failed — ${base}/report.md may be missing; findings/reviews/reverse-diff are still on disk.`)
if (!improved && !skipEditor) log(`WARNING: editor agent failed — ${base}/srs-improved.md may be missing; the rest of the deliverables are unaffected.`)

return {
  variant: VARIANT,
  repo,
  branch,
  slug,
  reportPath: report?.reportPath,
  summary: report?.summary,
  srsImprovedPath: improved?.srsImprovedPath,
  srsImprovedSummary: improved?.summary,
  srsImprovedEnriched: improved?.enrichedFromReverseDiff,
  srsImprovedVerify: improved?.editorVerify,
  units: units.length,
  analyzed: okResults.length,
  tokenCap: TOKEN_CAP,
  tokenSpentApprox: spentHere(),
  budgetHit,
  budgetSkipped,
  results: okResults,
  verdicts,
}
