export const meta = {
  name: 'figma-analyze',
  description: 'Figma-design-vs-frontend-code visual coverage as a dynamic workflow. Twin of spec-analyze: Context in parallel (figma-shooter + optional app-shooter render the screenshots, cartographer maps the LOCAL FE repo, crawler discovers PRs by epic/PIN), fan-out of N multimodal analyzers (one per confirmed screen-unit) comparing the Figma design PNG + optional rendered app PNG + the local code, adversarial verification + bounded rework in a pipeline, reverse diff (code->design), report. Reuses the spec-analyze orchestration spine; reads the LOCAL working tree pinned at HEAD (not gh ?ref).',
  whenToUse: 'After the interactive preflight: FIGMA_TOKEN in <out>/.env (scope file_content:read); for rendered capture, a fresh REACT_APP_MOCK_TOKEN in the FE .env.development.local + dev server up; and the WI segmented into <=10 screen-units (each with idx/titolo/prose/figmaNode and, for rendered capture, a route + recipe). Inputs are passed via args.',
  phases: [
    { title: 'Context', detail: 'figma-shooter + app-shooter (capture) + cartographer + crawler, parallel', model: 'haiku' },
    { title: 'Analysis', detail: 'fan-out: one multimodal analyzer per screen-unit (design + app + code)', model: 'sonnet' },
    { title: 'Verification', detail: 'multimodal verifier per finding + bounded rework (<=1 round)', model: 'sonnet' },
    { title: 'Reverse diff', detail: 'reverse-scout: FE behaviors/screens absent from the design', model: 'sonnet' },
    { title: 'Report', detail: 'final synthesis report.md (IT) with per-screen visual coverage', model: 'sonnet' },
  ],
}

// ---------------------------------------------------------------------------
// args (prepared by the driver/main-loop, NOT by this script):
//   {
//     fePath:       "/abs/path/to/pdnd-interop-frontend",  // REQUIRED. local FE working tree = as-is truth.
//     repo:         "pagopa/pdnd-interop-frontend",        // for crawler PR discovery via gh (remote)
//     branch:       "<checked-out branch>",                // informational; the SHA is pinned at run start
//     epicKey:      "PIN-8621",                            // crawler discovery key (epic)
//     workItemKeys: ["PIN-10144"],                         // crawler discovery keys (the WI's Jira issues)
//     prNumbers:    [1925],                                // OPTIONAL explicit PRs (skip gh search when known)
//     figmaFileKey: "CpRV3kPvFEWLXGtJUgWeZW",
//     outputDir:    "./.spec-analyze-fe",
//     slug:         "wi10-adeguamento-fe",
//     appBaseUrl:   "http://localhost:3000/ui",            // mode B only
//     renderedCapture: true,                               // optional; skip-with-flag if app unreachable
//     tokenCap:     500000,
//     units: [ { idx:"01", titolo:"...", prose:"...", figmaNode:"3977:52475",
//                route?:"/it/...", waitFor?:"text=...", viewport?:"1440x900",
//                steps?:[{click:{role,name}}|{click:"text"}], settle?:2500, dataNote?:"..." } ]  // <=10
//   }
// AS-IS truth = the LOCAL checked-out branch (NOT gh ?ref=). The workflow reads fePath via Read/Grep/Glob
// and pins HEAD (cartographer records the SHA + dirty flag). Secrets (FIGMA_TOKEN / REACT_APP_MOCK_TOKEN)
// live ONLY in env or a gitignored .env and are read by the capture scripts — never by the model.
// The report.md is written in ITALIAN on purpose.
// ---------------------------------------------------------------------------

const A = (typeof args === 'string')
  ? (() => { try { return JSON.parse(args) } catch { return {} } })()
  : (args || {})

const fePath = A.fePath
const repo = A.repo
const branch = A.branch || 'unknown'
const epicKey = A.epicKey || null
const workItemKeys = Array.isArray(A.workItemKeys) ? A.workItemKeys : []
const prNumbers = Array.isArray(A.prNumbers) ? A.prNumbers : []
const figmaFileKey = A.figmaFileKey
const outputDir = A.outputDir || './.spec-analyze-fe'
const slug = A.slug
const appBaseUrl = A.appBaseUrl || 'http://localhost:3000/ui'
const renderedCapture = A.renderedCapture !== false // default true; the shooter still skips-with-flag if app is down
const units = Array.isArray(A.units) ? A.units : []
const base = `${outputDir}/${slug}`

// --- arg validation (mirrors spec-analyze.js:39-79) ------------------------
if (!fePath || !figmaFileKey || !slug || units.length === 0) {
  throw new Error('Missing args: fePath, figmaFileKey, slug and a non-empty units[] are required. Run the interactive preflight first (creds + segmentation).')
}
const badUnits = units
  .map((u, i) => ({ u, i }))
  .filter(({ u }) => !u || !u.idx || !(u.titolo ?? u.title) || !(u.figmaNode ?? u.node))
if (badUnits.length > 0) {
  throw new Error(`Malformed args.units: every unit needs a non-empty 'idx', 'titolo' and 'figmaNode'. Offending: ${badUnits.map(({ u, i }) => u?.idx ?? `#${i}`).join(', ')}.`)
}
// idx keys design/<idx>.png, app-shots/<idx>.png, findings/, reviews/ and report rows — collisions corrupt the mapping.
const dupIdx = units.map((u) => u.idx).filter((id, i, all) => all.indexOf(id) !== i)
if (dupIdx.length > 0) {
  throw new Error(`Duplicate args.units idx: ${[...new Set(dupIdx)].join(', ')}. Each unit needs a unique idx.`)
}
if (units.length > 10) {
  log(`WARNING: ${units.length} units exceed the cap of 10 analyzers — the driver should have merged screens. Proceeding WITHOUT silent truncation.`)
}

// --- token-cost ceiling (best-effort, skip-with-flag; see spec-analyze.js) --
const TOKEN_CAP = Number(A.tokenCap) > 0 ? Number(A.tokenCap) : 500_000
const REPORT_RESERVE = 40_000
const TAIL_RESERVE = REPORT_RESERVE
const startSpent = budget?.spent?.() ?? 0
const spentHere = () => (budget?.spent?.() ?? startSpent) - startSpent
const analysisBudgetExhausted = () => spentHere() >= (TOKEN_CAP - TAIL_RESERVE)
const budgetSkipped = []
let budgetHit = false
const flagBudget = (what) => {
  budgetHit = true
  log(`TOKEN CAP: ~${spentHere()}/${TOKEN_CAP} in-workflow tokens — skipping ${what} (flagged, NOT silently truncated).`)
}

// --- per-role model strategy (analysis roles MUST be multimodal) -----------
const MODELS = {
  figmaShooter: 'haiku', // runs fetch_figma.py (deterministic render); cheap
  appShooter: 'haiku',   // runs shoot_app.mjs (Playwright); cheap
  cartographer: 'haiku', // maps the local FE repo + pins HEAD
  crawler: 'haiku',      // PR discovery via gh
  analyzer: 'sonnet',    // MULTIMODAL: reads the design/app PNGs + code
  verifier: 'sonnet',    // MULTIMODAL adversarial review
  rework: 'sonnet',      // MULTIMODAL single-round fix
  reverseScout: 'sonnet',
  report: 'sonnet',
}
const modelMix = Object.entries(MODELS).map(([k, v]) => `${k}=${v}`).join(', ')

// ---------------------------------------------------------------------------
// Structured-output schemas
// ---------------------------------------------------------------------------
const FIGMA_SHOOTER_SCHEMA = {
  type: 'object', additionalProperties: true, required: ['renderedIdx'],
  properties: {
    renderedIdx: { type: 'array', items: { type: 'string' }, description: 'idx values that got a design/<idx>.png' },
    missingIdx: { type: 'array', items: { type: 'string' }, description: 'idx values with NO design PNG (flagged in design-index.md)' },
    indexPath: { type: 'string' },
    note: { type: 'string' },
  },
}
const APP_SHOOTER_SCHEMA = {
  type: 'object', additionalProperties: true, required: ['capturedIdx'],
  properties: {
    capturedIdx: { type: 'array', items: { type: 'string' }, description: 'idx values that got an app-shots/<idx>.png' },
    failedIdx: { type: 'array', items: { type: 'string' }, description: 'idx values not captured (with a classified reason in app-shots-index.md)' },
    skipped: { type: 'boolean', description: 'true if the whole rendered capture was skipped (app down / disabled)' },
    note: { type: 'string' },
  },
}
const FE_ANALYSIS_SCHEMA = {
  type: 'object', additionalProperties: true, required: ['idx', 'titolo', 'stato', 'findingPath'],
  properties: {
    idx: { type: 'string' },
    titolo: { type: 'string' },
    stato: { type: 'string', enum: ['fully_covered', 'partially_covered', 'not_covered', 'uncertain'] },
    dimensions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: true, required: ['name', 'gap'],
        properties: {
          name: { type: 'string', enum: ['layout', 'tokens', 'typography', 'components', 'states', 'copy', 'spacing'] },
          gap: { type: 'string', enum: ['missing', 'partial', 'different_approach', 'n/a'] },
          note: { type: 'string' },
        },
      },
    },
    figmaNode: { type: 'string' },
    route: { type: 'string' },
    designShot: { type: 'string', description: 'path of the design/<idx>.png compared' },
    appShot: { type: 'string', description: 'path of app-shots/<idx>.png compared, or "" if none' },
    codeRefs: { type: 'string', description: 'code references path:line (relative to the pinned HEAD)' },
    renderedShot: { type: 'boolean', description: 'true if a rendered app PNG was available and used' },
    dataInsufficient: { type: 'boolean', description: 'true if a state/element could not be visually verified due to thin DEV data' },
    dataInsufficientReason: { type: 'string' },
    findingPath: { type: 'string' },
    note: { type: 'string' },
  },
}
const VERIFIER_SCHEMA = {
  type: 'object', additionalProperties: true, required: ['idx', 'verdetto', 'reviewPath'],
  properties: {
    idx: { type: 'string' },
    verdetto: { type: 'string', enum: ['confirmed', 'revise'] },
    reviewPath: { type: 'string' },
    contestazioni: { type: 'string', description: 'if revise: pointed, actionable objections; else empty' },
  },
}
const REPORT_SCHEMA = {
  type: 'object', additionalProperties: true, required: ['reportPath'],
  properties: {
    reportPath: { type: 'string' },
    summary: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// Shared preamble — ADAPTED from spec-analyze COMMON for the LOCAL-repo model.
// ---------------------------------------------------------------------------
const COMMON = `
SHARED CONTEXT
- Frontend repo (LOCAL working tree = as-is truth): ${fePath}  ·  branch (informational): ${branch}
- analysis output-dir: ${base}
- repo-map (FE orientation): ${base}/repo-map/
- Figma design screenshots: ${base}/design/<idx>.png  (index: ${base}/design-index.md)
- rendered app screenshots (if captured): ${base}/app-shots/<idx>.png  (index: ${base}/app-shots-index.md)

CROSS-CUTTING INVARIANTS (follow them to the letter)
- AS-IS truth = the LOCAL checked-out tree at ${fePath}, pinned at HEAD by the cartographer. Read code with Read/Grep/Glob on local paths. Do NOT use gh to read FE code (gh is ONLY for PR/comment discovery). codeRefs are path:line relative to that HEAD.
- MULTIMODAL comparison: see a design/app screenshot by calling the Read tool on its PNG path (the runtime renders the image). The comparison is VISUAL, not pixel-perfect.
- COVERAGE STATUS enum: fully_covered | partially_covered | not_covered | uncertain.
- GAP enum (per dimension): missing | partial | different_approach | n/a.
- VISUAL DIMENSIONS: layout, tokens (colours/MUI theme), typography, components, states (hover/disabled/error/empty/loading), copy (i18n strings), spacing.
- DATA-INSUFFICIENCY: if a state/element cannot be visually confirmed because the rendered app lacked the data, set dataInsufficient=true and say so — never guess.
- SECRETS never in artifacts: FIGMA_TOKEN / REACT_APP_MOCK_TOKEN live only in env or a gitignored .env, read by the capture scripts — never echo them.
- TOOLS / least privilege: NEVER use Edit, Task/Agent, WebFetch or WebSearch. Use ONLY the tools listed in your role's "TOOLS:" line; write ONLY to the paths your role owns.

i18n / stack TIPS (pdnd-interop-frontend)
- Copy lives in ${fePath}/src/static/locales/{it,en}/<ns>.json (i18next). Design tokens = MUI theme. Routes = src/router/routes.tsx.
`.trim()

// ---------------------------------------------------------------------------
// Role prompts
// ---------------------------------------------------------------------------
// Minimal per-unit payload for the shooters (idx + node, and the app recipe).
const unitsForFigma = JSON.stringify(units.map((u) => ({ idx: u.idx, figmaNode: u.figmaNode ?? u.node })))
const unitsForApp = JSON.stringify(
  units.map((u) => ({ idx: u.idx, route: u.route, waitFor: u.waitFor, viewport: u.viewport, steps: u.steps, settle: u.settle }))
)

const figmaShooterPrompt = `${COMMON}

ROLE: FIGMA-SHOOTER — render the Figma design frames to PNG, run ONCE. TOOLS: Bash, Read, Write only.
You produce the design screenshots EVERY comparison is based on; they are persisted run intermediates.

PROCEDURE
1. Write this units array to ${base}/units.json (create the dir if needed):
${unitsForFigma}
2. Run: python3 workflows/fetch_figma.py --file-key ${figmaFileKey} --units ${base}/units.json --out ${base} --scale 1
   (the script reads FIGMA_TOKEN from env or ${outputDir}/.env or ${base}/.env — never print it; exit 0 = at least one rendered, 2 = nothing/file bad, 3 = creds.)
3. Read ${base}/design-index.md and report which idx got a design/<idx>.png and which are MISSING.

OUTPUT: design/<idx>.png + design-index.md under ${base}. A missing PNG is flagged, not fatal.
Return the structured object (renderedIdx[], missingIdx[], indexPath, note).`

const appShooterPrompt = `${COMMON}

ROLE: APP-SHOOTER — capture screenshots of the RENDERED FE, run ONCE. TOOLS: Bash, Read, Write only.
This leg is best-effort: the app must be up + authenticated (REACT_APP_MOCK_TOKEN). Read-only navigation.

PROCEDURE
1. Write ${base}/units-app.json containing EXACTLY this JSON, byte-for-byte. Do NOT modify, reorder, add or remove any field. In particular: do NOT add a 'route' to a unit that has none, do NOT invent purposeTemplateIds, do NOT copy another unit's recipe. A unit without a 'route' is intentional — shoot_app.mjs will skip it (that screen is analyzed on design+code only).
${unitsForApp}
2. Run: node workflows/shoot_app.mjs --units ${base}/units-app.json --base ${appBaseUrl} --out ${base}
   (units with no 'route' are skipped; failures are classified in app-shots-index.md — EMPTY render usually means an expired/invalid token.)
3. Read ${base}/app-shots-index.md and report which idx got an app-shots/<idx>.png and which failed (with reasons).

OUTPUT: app-shots/<idx>.png + app-shots-index.md under ${base}. Any failure is flagged, never fatal.
If the app is unreachable / all empty, set skipped=true and explain. Return (capturedIdx[], failedIdx[], skipped, note).`

const cartographerPrompt = `${COMMON}

ROLE: CARTOGRAPHER — orientation map of the LOCAL FE repo + pin the as-is reference, run ONCE. TOOLS: Bash, Read, Write only.

PROCEDURE
1. Pin as-is: run \`git -C ${fePath} rev-parse HEAD\` and \`git -C ${fePath} status --porcelain\`. If ${fePath} is not a git repo or the command fails, STOP with an error (downstream analysis cannot trust an unpinned tree).
2. Build orientation WITHOUT reading file contents: list the tree (git ls-files / find), group paths into coherent AREAS (routes & pages from src/router/routes.tsx and src/pages, shared components, MUI theme/design tokens, i18n locales, api layer). Aim 6-15 compact nodes.
3. Write ${base}/repo-map/index.md FIRST — at the TOP record the pinned HEAD sha + whether the tree is DIRTY (and that codeRefs are relative to that sha) — then a | area | node | purpose | table. Write one ${base}/repo-map/<area>.md per area (purpose, key paths, no content).

OUTPUT: write ONLY inside ${base}/repo-map/. Return a short summary (HEAD sha, dirty?, number of areas, index path).`

const crawlerPrompt = `${COMMON}

ROLE: CRAWLER — PR & comment discovery for the WI, run ONCE in PARALLEL (no dependency on repo-map). TOOLS: Bash, Read, Write only.
gh is used ONLY here, and ONLY against the REMOTE repo ${repo} for PRs/comments (never to read FE code).

PROCEDURE
1. Discover candidate PRs from: ${prNumbers.length ? `the explicit PR numbers [${prNumbers.join(', ')}] FIRST` : 'gh search'}; the epic ${epicKey ? `\`${epicKey}\`` : '(none)'}; and the work-item keys ${workItemKeys.length ? workItemKeys.map((k) => `\`${k}\``).join(', ') : '(none)'} — e.g. \`gh search prs --repo ${repo} "<KEY>"\`, \`gh pr view <n> --json number,title,state,files,author,body\`.
2. For each relevant PR, collect the touched FE files (src/...) and the useful review/issue comments (drop bots/LGTM/CI). A PIN key that resolves to a BE PR (e.g. a different repo / no FE files) is recorded as CONTEXT, not FE coverage.
3. Map PRs -> touched FE paths so analyzers can find the changed screens.

OUTPUT: ${base}/comments.md — at the HEAD a | PR | Title | State | Keys | Touched FE paths | index, then per-PR comments, then discarded PRs with a one-line reason. No secrets.
Return a short summary (PRs found, enriched, discarded, BE-only keys noted).`

const analyzerPrompt = (u) => `${COMMON}

ROLE: ANALYZER (multimodal) — visual coverage for ONE screen-unit, in fan-out. TOOLS: Bash, Read, Grep, Glob, Write only.

ASSIGNED UNIT
- idx: ${u.idx}
- titolo: ${u.titolo ?? u.title}
- requirement prose:
${u.prose ?? u.prosa ?? '(prose not provided)'}
- figma node: ${u.figmaNode ?? u.node}${u.route ? `\n- app route: ${u.route}` : ''}

PROCEDURE
1. READ THE DESIGN: Read ${base}/design/${u.idx}.png (the runtime renders the image). This is the source of truth for the intended UI.
2. READ THE RENDERED APP if present: Read ${base}/app-shots/${u.idx}.png — if it is absent or app-shots-index.md flags it (EMPTY/auth/skip), proceed on design + code only and set renderedShot=false.
3. LOCATE THE CODE: from ${base}/repo-map/index.md + the PR->paths index in ${base}/comments.md, find the components/pages/i18n that implement this screen; Read them on the LOCAL tree at ${fePath}.
4. COMPARE per visual dimension (layout, tokens, typography, components, states, copy, spacing): is each present/faithful in the code (and in the rendered app, if available)? Note where the app/code is MORE explicit than the design, or diverges.
5. If a state/element can't be visually confirmed because the rendered app lacked data, set dataInsufficient=true with a reason.

OUTPUT: ${base}/findings/${u.idx}-<slug>.md with: stato (enum), per-dimension table (dimension | gap enum | note), figma node, route, designShot/appShot paths, codeRefs (path:line), data-insufficiency note. Italian prose.
Return the structured object (idx, titolo, stato, dimensions, figmaNode, route, designShot, appShot, codeRefs, renderedShot, dataInsufficient, dataInsufficientReason, findingPath, note).`

const verifierPrompt = (idx, titolo, findingPath) => `${COMMON}

ROLE: VERIFIER (multimodal) — adversarial review of ONE finding. FALSIFY, don't confirm; critic != author. TOOLS: Bash, Read, Grep, Glob, Write only.

INPUT
- finding: ${findingPath} (unit ${idx} - ${titolo})
- Re-Read ${base}/design/${idx}.png and ${base}/app-shots/${idx}.png (if present); re-locate the code on ${fePath}.

PROCEDURE
1. Verify EVERY cited codeRef actually exists on the pinned tree and supports the claim (watch off-by-one).
2. Re-examine the screenshots: is the declared stato honest? Are claimed matches/gaps real per dimension? Is data-insufficiency used correctly (not as an excuse for a real gap)?
3. Check the enums are used to the letter.

OUTPUT: ${base}/reviews/${idx}-<slug>.md with verdict (confirmed | revise); if revise, a pointed ACTIONABLE objection list. Write ONLY inside reviews/.
Return (idx, verdetto, reviewPath, contestazioni).`

const reworkPrompt = (idx, titolo, findingPath, objections) => `${COMMON}

ROLE: ANALYZER - REWORK (multimodal), a single round. TOOLS: Bash, Read, Grep, Glob, Write only.
The verifier issued 'revise' on ${findingPath} (unit ${idx} - ${titolo}). Address the objections and REWRITE ${findingPath} as the DEFINITIVE version (single round; note any residual objection).

VERIFIER OBJECTIONS:
${objections}

Keep the finding contract (stato enum, per-dimension gaps, codeRefs verified on the pinned tree, designShot/appShot, data-insufficiency). Re-Read the PNGs as needed.
Return the updated structured object (idx, titolo, stato, dimensions, ..., findingPath, note).`

const reverseScoutPrompt = `${COMMON}

ROLE: REVERSE-SCOUT — reverse diff code->design, run AFTER verification. Mirror of the analyzer: start from the CODE/app and find what is NOT in the captured design. TOOLS: Bash, Read, Grep, Glob, Write only.

PROCEDURE
1. Enumerate ${base}/findings/*.md (screens already covered) and ${base}/design-index.md (the captured frames).
2. From ${base}/repo-map/ + ${base}/comments.md (PR-touched paths), find FE screens/components/states (routes, variants, error/empty states, copy) that have NO corresponding captured design frame.
3. Optionally Read any captured app-shots to spot rendered states absent from the design.

OUTPUT: ${base}/reverse-diff.md (ITALIAN) — undocumented-in-design behaviors, with code references (path:line) and a note on why the design doesn't cover them. Keep identifiers/snippets verbatim.
Return a short summary (number of entries).`

const reportPrompt = (results, verdicts, budgetInfo) => `${COMMON}

ROLE: ORCHESTRATOR - REPORT. Write ${base}/report.md in ITALIAN (markdown). Read ${base}/findings/*.md, ${base}/reviews/*.md, ${base}/reverse-diff.md, ${base}/design-index.md, ${base}/app-shots-index.md, ${base}/comments.md. TOOLS: Read, Write, Glob, Grep, Bash only.

MANDATORY STRUCTURE (headings + prose in Italian)
1. OVERVIEW: per-screen table — | idx | schermata | stato | rendered? | note | (use the summarized results, verify against findings/).
2. DESIGN -> CODE: per screen, the per-dimension gaps (layout/tokens/typography/components/states/copy/spacing), with code references (path:line) and the design/app screenshot paths (embed thumbnails where useful).
3. CODE -> DESIGN: synthesis of reverse-diff.md.
4. VERIFICATION: which screens the verifier CONFIRMED vs REVISED / still contested (residual objections).
5. EVIDENCE & LIMITS:
   - As-is: the pinned HEAD sha + whether the tree was dirty (from repo-map/index.md).
   - Rendered capture: which screens had an app-shot vs design-only; list EMPTY/auth/skip flags from app-shots-index.md (e.g. an expired REACT_APP_MOCK_TOKEN), and every DATA-INSUFFICIENCY note — these are NOT coverage gaps, state them as such.
   - TOKEN CAP: ${budgetInfo} — report verbatim; if anything was skipped for budget, list it (no silent truncation).
   - PER-ROLE MODEL MIX: ${modelMix}.

ANALYSIS RESULTS (validate against the files):
${JSON.stringify(results, null, 2)}

VERIFIER VERDICTS:
${JSON.stringify(verdicts, null, 2)}

WRITE: write the FULL report to ${base}/report.md — if it already exists, Read it first (the Write tool refuses to overwrite an un-Read file), then Write and Read it back to confirm your content landed. The report BODY goes in the FILE, never only in the return value.
As-is truth; enums to the letter; no secrets. Return the structured object (reportPath, summary) where 'summary' is a SINGLE LINE outcome (e.g. "3 schermate: 1 fully, 2 partially") — NOT the report body.`

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
log(`figma-analyze · FE ${fePath} · figma ${figmaFileKey} · ${units.length} screen-units · rendered=${renderedCapture} · out ${base}`)

// Context — capture (figma + app) ∥ cartographer ∥ crawler. Barrier: analysis needs design + repo-map.
phase('Context')
const [figmaRes, appRes, mapRes, crawlRes] = await parallel([
  () => agent(figmaShooterPrompt, { label: 'figma-shooter', phase: 'Context', schema: FIGMA_SHOOTER_SCHEMA, model: MODELS.figmaShooter }),
  () => (renderedCapture
    ? agent(appShooterPrompt, { label: 'app-shooter', phase: 'Context', schema: APP_SHOOTER_SCHEMA, model: MODELS.appShooter })
    : Promise.resolve({ capturedIdx: [], failedIdx: [], skipped: true, note: 'renderedCapture disabled' })),
  () => agent(cartographerPrompt, { label: 'cartographer', phase: 'Context', model: MODELS.cartographer }),
  () => agent(crawlerPrompt, { label: 'crawler', phase: 'Context', model: MODELS.crawler }),
])

if (!figmaRes || !mapRes) {
  const failed = [!figmaRes && 'figma-shooter (design/)', !mapRes && 'cartographer (repo-map/)'].filter(Boolean).join(' and ')
  throw new Error(`Context phase aborted: ${failed} failed — design screenshots and the repo map are mandatory inputs for the analysis.`)
}
if (!crawlRes) log('WARNING: crawler failed — analyzers proceed without the PR->paths index (code located via repo-map only).')

// Per-unit gating: a unit with NO design/<idx>.png is NOT analyzable (design is its primary input).
const rendered = new Set((figmaRes.renderedIdx || []).map(String))
const captured = new Set(((appRes && appRes.capturedIdx) || []).map(String))
const analyzable = units.filter((u) => rendered.has(String(u.idx)))
const skippedNoDesign = units.filter((u) => !rendered.has(String(u.idx)))
for (const u of skippedNoDesign) {
  budgetSkipped.push(`analyzer:${u.idx} (no design shot)`)
  log(`SKIP unit ${u.idx} "${u.titolo ?? u.title}" — no design/${u.idx}.png (recorded not_covered).`)
}
if (analyzable.length === 0) {
  throw new Error('Analysis aborted: no unit has a design screenshot (figma-shooter rendered nothing). Check the figma node ids / FIGMA_TOKEN scope.')
}
log(`analyzable: ${analyzable.length}/${units.length} units · app-shots: ${captured.size}${appRes && appRes.skipped ? ' (rendered capture skipped)' : ''}`)

// Analysis — fan-out analyzer -> verifier -> bounded rework, in a pipeline (no barrier between units).
const results = await pipeline(
  analyzable,
  (u) => {
    if (analysisBudgetExhausted()) { budgetSkipped.push(`analyzer:${u.idx}`); flagBudget(`analyzer:${u.idx}`); return null }
    return agent(analyzerPrompt(u), { label: `analyzer:${u.idx}`, phase: 'Analysis', schema: FE_ANALYSIS_SCHEMA, model: MODELS.analyzer })
  },
  async (finding, u) => {
    if (!finding) return null
    const idx = u.idx
    const titolo = finding.titolo || u.titolo || u.title || ''
    if (analysisBudgetExhausted()) {
      budgetSkipped.push(`verifier:${idx}`); flagBudget(`verifier:${idx}`)
      return { ...finding, idx, verifierOutcome: 'skipped-budget', reviewPath: null }
    }
    const verdict = await agent(verifierPrompt(idx, titolo, finding.findingPath), { label: `verifier:${idx}`, phase: 'Verification', schema: VERIFIER_SCHEMA, model: MODELS.verifier })
    if (verdict && verdict.verdetto === 'revise') {
      if (analysisBudgetExhausted()) {
        budgetSkipped.push(`rework:${idx}`); flagBudget(`rework:${idx}`)
        return { ...finding, idx, verifierOutcome: 'revise->skipped-budget', reviewPath: verdict.reviewPath }
      }
      const definitive = await agent(
        reworkPrompt(idx, titolo, finding.findingPath, verdict.contestazioni || '(objections in the review file)'),
        { label: `rework:${idx}`, phase: 'Verification', schema: FE_ANALYSIS_SCHEMA, model: MODELS.rework },
      )
      return { ...(definitive || finding), idx, verifierOutcome: definitive ? 'revise->rewritten' : 'revise->rework-failed', reviewPath: verdict.reviewPath }
    }
    return { ...finding, idx, verifierOutcome: verdict ? verdict.verdetto : 'verifier-failed', reviewPath: verdict?.reviewPath }
  },
)

const okResults = results.filter(Boolean)
// Record the design-less units as explicit not_covered rows so the report is complete.
for (const u of skippedNoDesign) {
  okResults.push({ idx: u.idx, titolo: u.titolo ?? u.title, stato: 'not_covered', verifierOutcome: 'skipped-no-design', note: 'no design screenshot captured', findingPath: null })
}
if (okResults.length === 0) {
  throw new Error(`Analysis aborted: all ${analyzable.length} analyzers failed — nothing to synthesize.`)
}
const verdicts = okResults.map((e) => ({ idx: e.idx, verifierOutcome: e.verifierOutcome, reviewPath: e.reviewPath }))
log(`analysis + verification done: ${okResults.length} unit rows`)

// Reverse diff (after verification).
phase('Reverse diff')
if (analysisBudgetExhausted()) {
  budgetSkipped.push('reverse-scout'); flagBudget('reverse-scout (reverse diff)')
} else {
  await agent(reverseScoutPrompt, { label: 'reverse-scout', phase: 'Reverse diff', model: MODELS.reverseScout })
}

// Report (always attempted within REPORT_RESERVE).
phase('Report')
const budgetInfo = `TOKEN CAP for this run: ${TOKEN_CAP} output tokens (arg-parametrizable, default 500k; best-effort, enforced at agent-spawn checkpoints). In-workflow spend (budget.spent() delta) at report time: ~${spentHere()}. Cap hit: ${budgetHit ? 'YES' : 'no'}.${budgetSkipped.length ? ` Skipped (NOT silently truncated): ${budgetSkipped.join(', ')}.` : ''} PER-ROLE MODEL MIX: ${modelMix}.`
const report = await agent(reportPrompt(okResults, verdicts, budgetInfo), { label: 'report', phase: 'Report', schema: REPORT_SCHEMA, model: MODELS.report })
if (!report) log(`WARNING: report agent failed — ${base}/report.md may be missing; findings/reviews/reverse-diff are still on disk.`)

return {
  fePath,
  figmaFileKey,
  slug,
  reportPath: report?.reportPath,
  summary: report?.summary,
  unitsTotal: units.length,
  analyzed: results.filter(Boolean).length,
  skippedNoDesign: skippedNoDesign.map((u) => u.idx),
  appShotsCaptured: [...captured],
  tokenCap: TOKEN_CAP,
  tokenSpentApprox: spentHere(),
  budgetHit,
  budgetSkipped,
  results: okResults,
  verdicts,
}
