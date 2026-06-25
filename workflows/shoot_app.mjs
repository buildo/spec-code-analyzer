// shoot_app.mjs — cattura screenshot del FE renderizzato per il workflow figma-analyze.
//
// Best-effort / environment-dependent (NON deterministico come il render Figma): richiede
// l'app FE up + autenticata (REACT_APP_MOCK_TOKEN, gestito dal preflight). Naviga in SOLA
// LETTURA secondo la recipe per-unit e scrive app-shots/<idx>.png; i fallimenti sono
// classificati e l'unit resta senza appShot (l'analisi prosegue su design + codice).
//
// Uso:
//   node shoot_app.mjs --units <units.json> --base <appBaseUrl> --out <dir> [--viewport 1440x900]
//
// Recipe per-unit (campi letti da ogni unit di units.json; le unit senza `route` sono saltate):
//   { idx, route, waitFor?: "<css>"|"networkidle", viewport?: "WxH", steps?: [{click:{role,name}}|{click:"<text>"}], settle?: <ms> }
//
// Output: <out>/app-shots/<idx>.png + <out>/app-shots-index.md (idx | route | file | status)
// Exit 0 sempre (i fallimenti per-unit sono flaggati, mai fatali per il batch).

import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

function arg(name, def) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def
}

const unitsPath = arg('--units')
const base = (arg('--base') || process.env.APP_BASE_URL || 'http://localhost:3000/ui').replace(/\/$/, '')
const out = arg('--out')
const [defW, defH] = arg('--viewport', '1440x900').split('x').map(Number)

if (!unitsPath || !out) {
  console.error('usage: node shoot_app.mjs --units <json> --base <url> --out <dir> [--viewport WxH]')
  process.exit(2)
}

const allUnits = JSON.parse(readFileSync(unitsPath, 'utf8'))
const units = allUnits.filter((u) => u.route) // no route -> not capturable (e.g. wizard draft-only)
const dir = path.join(out, 'app-shots')
mkdirSync(dir, { recursive: true })

const browser = await chromium.launch()
const rows = []

for (const u of units) {
  const idx = String(u.idx)
  const route = u.route.startsWith('/') ? u.route : '/' + u.route
  const url = base + route
  const [vw, vh] = (u.viewport || '').split('x').map(Number)
  const ctx = await browser.newContext({ viewport: { width: vw || defW, height: vh || defH } })
  const page = await ctx.newPage()
  let status = 'ok'
  let file = `app-shots/${idx}.png`

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })
  } catch (e) {
    const m = String(e)
    status = /ERR_CONNECTION|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS/.test(m)
      ? 'UNREACHABLE (app down?)'
      : 'NAV-TIMEOUT'
    file = '—'
    rows.push([idx, route, file, status])
    console.error(`  - ${idx} ${route}: ${status}`)
    await ctx.close()
    continue
  }

  // login redirect => auth not valid (token expired/missing)
  const finalUrl = page.url()
  if (/selfcare|\/login|\/auth(\b|\/)/i.test(finalUrl) && !finalUrl.startsWith(base)) {
    status = 'LOGIN-REDIRECT (auth invalid)'
    file = '—'
    rows.push([idx, route, file, status])
    console.error(`  - ${idx} ${route}: ${status} (${finalUrl})`)
    await ctx.close()
    continue
  }

  // Expired/missing auth on this app renders a blank shell (spinner) with NO login redirect,
  // so guard on empty content before attempting steps (token expiry is the common cause).
  await page.waitForTimeout(1200)
  const bodyLen = (await page.locator('body').innerText().catch(() => '')).trim().length
  if (bodyLen < 40) {
    status = 'EMPTY (no content — auth/token expired?)'
    file = '—'
    rows.push([idx, route, file, status])
    console.error(`  - ${idx} ${route}: ${status} (bodyTextLen=${bodyLen})`)
    await ctx.close()
    continue
  }

  try {
    if (u.waitFor && u.waitFor !== 'networkidle') {
      await page.waitForSelector(u.waitFor, { timeout: 15000 })
    }
    for (const s of u.steps || []) {
      const loc =
        s.click && typeof s.click === 'object'
          ? page.getByRole(s.click.role || 'button', { name: new RegExp(s.click.name, 'i') })
          : page.getByText(new RegExp(String(s.click), 'i'))
      await loc.first().click({ timeout: 15000 })
    }
    await page.waitForTimeout(Number(u.settle ?? 2500))
    await page.screenshot({ path: path.join(out, 'app-shots', `${idx}.png`), fullPage: true })
  } catch (e) {
    const m = String(e)
    status = /waitForSelector|getByRole|getByText|click/i.test(m)
      ? `STEP-FAILED (${(u.waitFor || 'step')})`
      : `FAILED: ${m.slice(0, 80)}`
    file = '—'
  }

  rows.push([idx, route, file, status])
  console.error(`  - ${idx} ${route}: ${status}`)
  await ctx.close()
}

await browser.close()

const indexPath = path.join(out, 'app-shots-index.md')
writeFileSync(
  indexPath,
  `# App-shots index — ${base}\n\nviewport: ${defW}x${defH} · catturati: ${rows.filter((r) => r[3] === 'ok').length}/${units.length}\n\n` +
    `| idx | route | file | status |\n|-----|-------|------|--------|\n` +
    rows.map(([i, r, f, s]) => `| ${i} | ${r} | ${f} | ${s} |`).join('\n') +
    '\n'
)
console.error(`app-shots-index.md written -> ${indexPath}`)
process.exit(0)
