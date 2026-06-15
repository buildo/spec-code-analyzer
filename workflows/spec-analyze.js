export const meta = {
  name: 'spec-analyze',
  description: 'Spec-vs-code as a dynamic workflow, A/B-parameterized by args.variant ("prescriptive" default | "goals"): context in parallel, fan-out of N analyzers from the SRS sections, adversarial verification + bounded rework in a pipeline, reverse diff, report. The orchestration skeleton is IDENTICAL across variants — only the two experimental axes differ (axis a = spec style: step-by-step PROCEDURE vs Objective/Contract/Guardrail; axis b = discovery freedom: fixed numeric caps vs budget+judgment).',
  whenToUse: 'After the interactive preflight (credentials + gh check, fetch_atlassian.py, RF-FLOW-2 confirmation and SRS segmentation into <=10 units). Inputs are passed via args (set args.variant to pick the A/B arm). It does NOT run the fetch nor the user confirmation itself. For an A/B comparison, run both variants on the SAME repo/branch/units, into SEPARATE output dirs. DRIVER HYGIENE: on a re-run of an existing slug, the driver MUST first delete the derived artifacts (findings/, reviews/, comments.md, reverse-diff.md, report.md, srs-improved.md) preserving repo-map/ — roles that overwrite via the Write tool (e.g. redattore: no Bash) are REFUSED by the tool on a pre-existing un-Read file and would silently keep the stale version; leftover prior-run files with different names also pollute the findings/*.md glob read by report/ricognitore.',
  phases: [
    { title: 'Context', detail: 'cartografo || crawler (parallel, independent)', model: 'haiku' },
    { title: 'Analysis', detail: 'fan-out: one analyzer per SRS unit', model: 'opus' },
    { title: 'Verification', detail: 'verifier (opus) per finding + bounded rework (opus, <=1 round)', model: 'opus' },
    { title: 'Reverse diff', detail: 'ricognitore-inverso over the definitive findings', model: 'sonnet' },
    { title: 'SRS improved', detail: 'redattore: each Work Item restructured into product requirements vs technical specs (srs-improved.md, importable into a new Confluence page)', model: 'sonnet' },
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
// Role names in labels/headers (cartografo, crawler, analizzatore, verifier,
// ricognitore-inverso) are kept verbatim for traceability to the plugin's
// agents/*.md and the requirements doc; only the working language is English.
// The final report.md is written in ITALIAN on purpose (see reportPrompt).
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

// Defend against duplicate idx: they collide on labels (analizzatore:<idx>), on
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
// Rationale: the 3 correctness-critical roles (analizzatore, verifier, rework)
// stay on Opus; the 2 mechanical discovery roles go Haiku (also much faster);
// the 2 secondary/synthesis roles go Sonnet. Cost lever: drop verifier→'sonnet'
// for a bigger saving at the cost of adversarial catch-rate on subtle cases.
// NOTE (A/B): a mixed-model run is NOT cost-comparable 1:1 with a uniform-Opus
// run — this is surfaced in RR-5.
// ---------------------------------------------------------------------------
const MODELS = {
  cartografo: 'haiku',
  crawler: 'haiku',
  analizzatore: 'opus',
  verifier: 'opus',
  rework: 'opus',
  ricognitore: 'sonnet',
  redattore: 'sonnet',
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
      discovery: 'BUDGET + JUDGMENT — no fixed numeric ceilings on discovery; the agent decides how many PRs to enrich within a reasonable cost budget, flagging every cut (never a silent truncation). The role boundary (crawler = global bulk harvester; analizzatore = targeted gap-fill) and the cost guardrails fan-out<=10 / rework<=1 are kept',
    }
  : {
      style: 'PRESCRIPTIVE',
      styleDesc: 'roles/playbook as step-by-step numbered PROCEDUREs',
      discovery: 'FIXED NUMERIC CAPS — ~30 enriched PRs (crawler) and <=3 new PRs per section (analizzatore gap-fill), plus the S1-S4 signal taxonomy',
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

const REDATTORE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['srsImprovedPath'],
  properties: {
    srsImprovedPath: { type: 'string', description: 'path of the improved SRS markdown written (srs-improved.md)' },
    sectionsSplit: { type: 'number', description: 'number of Work Items restructured into product/technical' },
    summary: { type: 'string', description: 'one-line summary (must state that the conservation self-check was done)' },
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
const cartografoPrompt = `${COMMON}

ROLE: CARTOGRAFO (RF-7) - repository map, run ONCE.
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

ROLE: CRAWLER (RF-8, §10.1) - PR & comment discovery, stage A, run ONCE, in PARALLEL with the cartografo (you do NOT depend on repo-map/). You are the ONLY bulk harvester of comments.
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

const analizzatorePrompt = (u) => `${COMMON}

ROLE: ANALIZZATORE (RF-9, §10.2) - spec->code coverage for ONE section, in fan-out. You are NOT a bulk harvester: broad discovery belongs to the crawler; you only do targeted gap-fill on your own paths.
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
3. Independently RE-LOCATE the section's as-is code looking for coverage or gaps NOT seen by the analizzatore.
4. Check correct use of the status/gap enums and respect for as-is truth.
5. Emit the verdict.

OUTPUT: ${base}/reviews/${idx}-<section>.md with: verdict (confirmed | revise); if revise, the pointed and ACTIONABLE list of objections.
Do NOT rewrite the finding (critic != author). Be adversarial: on well-founded doubt, object. Write only inside reviews/. No secrets.
Return the structured object (idx, verdetto, reviewPath, contestazioni).`

const reworkPrompt = (idx, titolo, findingPath, objections) => `${COMMON}

ROLE: ANALIZZATORE - REWORK (RF-FLOW-5), a single round.
TOOLS: Bash, Read, Grep, Write only.
The verifier issued a 'revise' verdict on the finding ${findingPath} (section ${idx} - ${titolo}).
Address the objections below and REWRITE ${findingPath} as the DEFINITIVE version (single round: if something stays unresolvable, note it in the finding as a "residual objection").

VERIFIER OBJECTIONS:
${objections}

Keep the finding contract (status enum, path:line references verified on ${branch}, gap enum, doubts, any code-side PRs). As-is truth; no secrets.
Return the updated structured object (idx, titolo, stato, gap, findingPath, note).`

const ricognitorePrompt = `${COMMON}

ROLE: RICOGNITORE-INVERSO (RF-10) - reverse diff code->spec, run AFTER verification. Mirror of the analizzatore: start from the CODE and look for what is NOT documented in the SRS.
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
const cartografoPromptGoals = `${COMMON}

ROLE: CARTOGRAFO (RF-7) - repository map, run ONCE. GOALS STYLE (constrain the outcome, not the steps).
TOOLS: Bash, Read, Write only.

OBJECTIVE: produce enough as-is orientation of the repo that the other roles can locate code without re-reading everything. Orientation only - do NOT read file contents.
OUTPUT CONTRACT: a segmented repo-map/ under ${outputDir}/repo-map/ - index.md FIRST (a | area | node | purpose | table, the first consultable thing) plus one compact <area>.md node per coherent area (purpose, key paths WITHOUT content, optional dependsOn). Write ONLY inside ${outputDir}/repo-map/.
GUARDRAILS/INVARIANTS: no file content; compact nodes; repo-scoped & reusable; as-is truth of ${branch}; no secrets; minimal tools. HOW you build it (which gh calls, how you group the areas, aim ~5-15 nodes) is YOUR judgment.
Return a short text summary (number of areas, index path).`

const crawlerPromptGoals = `${COMMON}

ROLE: CRAWLER (RF-8, §10.1) - PR & comment discovery, run ONCE, in PARALLEL with the cartografo (you do NOT depend on repo-map/). GOALS STYLE. You are the ONLY bulk harvester of comments.
TOOLS: Bash, Read, Write only.

OBJECTIVE: a pre-localization overview of the PRs and comments relevant to this feature/domain.
OUTPUT CONTRACT: ${base}/comments.md with, at the HEAD, an index that makes the comments consultable BY PATH (at least: | PR | Title | State | Signals | Touched paths |) and, below, the selected comments per PR (author, file:line, text); the discarded PRs listed at the tail with a one-line reason.
GUARDRAILS/INVARIANTS: discovery does NOT stop at Jira links - draw on AT LEAST Jira remote links, issue keys, feature terms from ${srsPath}, OPEN PRs against ${branch}, AND any other useful signal, by judgment (the concrete queries/commands are YOURS to choose); dedupe (same author+text) and filter noise (bots, LGTM, CI); OPEN PRs = context, NOT coverage. COST BUDGET, NO FIXED NUMERIC CEILING: keep the number of enriched PRs reasonable, prioritize by relevance, and FLAG every cut - never a silent truncation. Judgment decides how many PRs deserve enrichment. No secrets.
Return a short summary (candidate PRs, enriched, discarded, any flagged cut).`

const analizzatorePromptGoals = (u) => `${COMMON}

ROLE: ANALIZZATORE (RF-9, §10.2) - spec->code coverage for ONE section, in fan-out. GOALS STYLE. You are NOT a bulk harvester: broad discovery belongs to the crawler.
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

ROLE: ANALIZZATORE - REWORK (RF-FLOW-5), a single round. GOALS STYLE.
TOOLS: Bash, Read, Grep, Write only.
The verifier issued a 'revise' verdict on the finding ${findingPath} (section ${idx} - ${titolo}).

OBJECTIVE: address the objections below and REWRITE ${findingPath} as the DEFINITIVE version (single round: if something stays unresolvable, note it in the finding as a "residual objection").
VERIFIER OBJECTIONS:
${objections}
OUTPUT CONTRACT / GUARDRAILS: keep the finding contract (status enum, path:line references verified on ${branch}, gap enum, doubts, any code-side PRs); as-is truth; no secrets.
Return the updated structured object (idx, titolo, stato, gap, findingPath, note).`

const ricognitorePromptGoals = `${COMMON}

ROLE: RICOGNITORE-INVERSO (RF-10) - reverse diff code->spec, run AFTER verification. GOALS STYLE. Mirror of the analizzatore: start from the CODE and find what is NOT documented in the SRS.
TOOLS: Bash, Read, Glob, Grep, Write only.

OBJECTIVE: identify behaviors in the code (endpoints, rules, edge cases) that are undocumented in the SRS.
OUTPUT CONTRACT: ${base}/reverse-diff.md - a list of undocumented behaviors with code references (path:line) and a note on why the SRS does not cover them. It MUST be written in ITALIAN (headings and prose), consistently with report.md; keep code references, paths, identifiers and code snippets verbatim (do NOT translate code).
GUARDRAILS/INVARIANTS: as-is truth; areas with PR activity but NO findings are the natural candidates; pull-based consultation; you may split by code area if it is large (still an outcome); no secrets. HOW you hunt is YOUR judgment.
Return a short summary (number of entries).`

// Variant selector: the orchestration below references P.* only — the skeleton is identical.
const P = (VARIANT === 'goals')
  ? { cartografo: cartografoPromptGoals, crawler: crawlerPromptGoals, analizzatore: analizzatorePromptGoals, verifier: verifierPromptGoals, rework: reworkPromptGoals, ricognitore: ricognitorePromptGoals }
  : { cartografo: cartografoPrompt, crawler: crawlerPrompt, analizzatore: analizzatorePrompt, verifier: verifierPrompt, rework: reworkPrompt, ricognitore: ricognitorePrompt }

// Redattore: markdown in, markdown out. The improved SRS is a derivative PROPOSAL
// the user reviews and imports into a NEW Confluence page (Insert > Markup > Markdown).
// Variant-agnostic: it restructures the original SRS only, independent of the analysis.
const redattoreOut = `${base}/srs-improved.md`

const redattorePrompt = `${COMMON}

ROLE: REDATTORE (SRS-IMPROVED) - ADDED STEP, purely editorial restructuring of the SRS. Does NOT use the analysis output.
TOOLS: Read, Write, Glob, Grep only. Read ONLY ${srsPath} (no findings/reviews/code, no gh, no network).

GOAL
Rewrite the FULL SRS (${srsPath}) into ${redattoreOut}, ITALIAN markdown, same structure/tone/style, with ONE change: every "[Work Item N]" section is split into two subsections, in order:
- "### Requisiti di prodotto" — the WHAT/WHY: behavior, business rules, validations, constraints, error semantics, backward-compat as seen by the caller.
- "### Specifiche tecniche" — the HOW: endpoints, table/column/event/schema identifiers, module names, implementation/merge-ordering/migration notes.

RULES (accuracy first)
1. REDISTRIBUTE, don't duplicate: each original sentence goes into exactly ONE subsection — nothing left above/outside, nothing repeated, nothing dropped or invented. Roughly same length as the original; if a WI grows a lot you are duplicating — redo it.
2. Source-faithful: subsections contain ONLY facts written in the SRS (no limits/states/defaults recalled from elsewhere). Mixed sentence → split the sentence, not the meaning. Truly undecidable → put under "Requisiti di prodotto" with "(dettaglio tecnico: ...)".
3. Verbatim: keep all code identifiers, endpoint paths, SQL and snippets unchanged. Pre-existing sub-headings inside a WI move under the right subsection, demoted one level.
4. Non-WI sections (Overview, Vincoli, Scenari di test, Change log, ecc.) copied unchanged, except obvious typos ("Inoltree" -> "Inoltre").
5. No empty subsections: title-only WI → keep its heading + "_(nessun dettaglio nell'SRS)_", no subsections; single-nature WI → emit only the applicable one.

WRITE: the Write tool refuses to overwrite a file not Read this session. If ${redattoreOut} already exists, Read it first, then Write; read it back and confirm it is YOUR content before returning. Output is markdown for a NEW Confluence page (Insert > Markup > Markdown); write ONLY this file. Return the structured object (srsImprovedPath, sectionsSplit, summary).`

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
   - ADDED STEP (redattore, on top of the original spec): ${redattoreOut} (each Work Item restructured into "Requisiti di prodotto" vs "Specifiche tecniche") is generated in PARALLEL with this report — list it among the deliverables in RR-5 noting it may still be in progress at report time; do NOT block on it.

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
  () => agent(P.cartografo, { label: 'cartografo', phase: 'Context', model: MODELS.cartografo }),
  () => agent(P.crawler, { label: 'crawler', phase: 'Context', model: MODELS.crawler }),
])
if (!mapResult || !crawlResult) {
  const failed = [!mapResult && 'cartografo (repo-map/)', !crawlResult && 'crawler (comments.md)'].filter(Boolean).join(' and ')
  throw new Error(`Context phase aborted: ${failed} failed — downstream analysis depends on it and cannot proceed reliably.`)
}

// RF-FLOW-4/5 — Fan-out analyzers -> verifier -> bounded rework, in a pipeline (no barrier between units)
const results = await pipeline(
  units,
  // stage 1: ANALIZZATORE (skipped-with-flag if the token cap is exhausted)
  (u) => {
    if (analysisBudgetExhausted()) { budgetSkipped.push(`analizzatore:${u.idx}`); flagBudget(`analizzatore:${u.idx}`); return null }
    return agent(P.analizzatore(u), {
      label: `analizzatore:${u.idx}`,
      phase: 'Analysis',
      schema: ANALYSIS_SCHEMA,
      model: MODELS.analizzatore,
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
if (analysisBudgetExhausted()) {
  budgetSkipped.push('ricognitore-inverso')
  flagBudget('ricognitore-inverso (reverse diff)')
} else {
  await agent(P.ricognitore, { label: 'ricognitore-inverso', phase: 'Reverse diff', model: MODELS.ricognitore })
}

// RF-FLOW-7 — Report (always attempted within REPORT_RESERVE; documents the cap status in RR-5)
// + ADDED STEP — redattore (srs-improved.md): independent of the report, so the two run in parallel.
//   Budget gate decided BEFORE building budgetInfo, so a skipped redattore shows up in RR-5.
phase('Report')
const skipRedattore = analysisBudgetExhausted()
if (skipRedattore) { budgetSkipped.push('redattore'); flagBudget('redattore (srs-improved.md)') }
const budgetInfo = `TOKEN CAP for this run: ${TOKEN_CAP} output tokens (best-effort, enforced at agent-spawn checkpoints; runtime hard-throw only with a user "+Nk" directive). In-workflow spend (budget.spent() delta) at report time: ~${spentHere()}. Cap hit: ${budgetHit ? 'YES' : 'no'}.${budgetSkipped.length ? ` Skipped for budget (NOT silently truncated): ${budgetSkipped.join(', ')}.` : ''} PER-ROLE MODEL MIX: ${modelMix}. CAVEAT: a mixed-model run is NOT cost-comparable 1:1 with a uniform-Opus run — state this when comparing RR-5 against the goals variant.`
const [improved, report] = await parallel([
  () => skipRedattore
    ? Promise.resolve(null)
    : agent(redattorePrompt, { label: 'redattore', phase: 'SRS improved', schema: REDATTORE_SCHEMA, model: MODELS.redattore }),
  () => agent(reportPrompt(okResults, verdicts, budgetInfo), { label: 'report', phase: 'Report', schema: REPORT_SCHEMA, model: MODELS.report }),
])
if (!report) log(`WARNING: report agent failed — ${base}/report.md may be missing; findings/reviews/reverse-diff are still on disk.`)
if (!improved && !skipRedattore) log(`WARNING: redattore agent failed — ${base}/srs-improved.md may be missing; the rest of the deliverables are unaffected.`)

return {
  variant: VARIANT,
  repo,
  branch,
  slug,
  reportPath: report?.reportPath,
  summary: report?.summary,
  srsImprovedPath: improved?.srsImprovedPath,
  srsImprovedSummary: improved?.summary,
  units: units.length,
  analyzed: okResults.length,
  tokenCap: TOKEN_CAP,
  tokenSpentApprox: spentHere(),
  budgetHit,
  budgetSkipped,
  results: okResults,
  verdicts,
}
