// End-to-end: the web client against the server + fake ACP agent.
// Run with the server already listening on BASE (default http://127.0.0.1:3000).
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000'
const OUT = process.env.OUT ?? '/tmp/e2e-shots'
mkdirSync(OUT, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' })
try {
  // ---------------------------------------------------------------- desktop
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

  await page.goto(BASE)
  await page.getByRole('button', { name: 'New session' }).last().click()
  await page.waitForURL(/\/t\//)
  const threadUrl = page.url()
  await page.screenshot({ path: `${OUT}/01-new-session.png` })

  await page.getByLabel('Message').fill('set retries to 3')
  await page.keyboard.press('Enter')

  const card = page.getByRole('alert').filter({ hasText: 'omp wants to' })
  await card.waitFor({ timeout: 15_000 })
  check('approval card appears while omp waits', await card.isVisible(), await card.innerText().then((t) => t.split('\n')[0]))
  const badge = page.locator('[aria-label="needs your decision"]')
  check('sidebar shows a pending-decision badge', (await badge.count()) > 0)
  await page.screenshot({ path: `${OUT}/02-approval.png` })

  // Walk away and come back: reload while omp is paused on the approval.
  await page.reload()
  await card.waitFor({ timeout: 15_000 })
  const userMsgAfterReload = await page.getByText('set retries to 3', { exact: true }).count()
  check('after reload: transcript and pending approval restored', userMsgAfterReload > 0 && (await card.isVisible()))

  await card.getByRole('button', { name: 'Allow for session' }).click()
  await page.getByText('This is turn 1 of this session').waitFor({ timeout: 15_000 })
  check('reply streams in after approving', true)
  check('approval card is gone', (await card.count()) === 0)
  await page.screenshot({ path: `${OUT}/03-reply.png` })

  const stepsToggle = page.getByRole('button', { name: /steps/ }).first()
  check('tool activity folds into a steps row', (await stepsToggle.count()) > 0, await stepsToggle.innerText().catch(() => ''))
  await stepsToggle.click()
  await page.screenshot({ path: `${OUT}/04-steps-open.png` })

  // Turn 2: the session grant covers the edit, and omp resumes its session.
  await page.getByLabel('Message').fill('now add a test')
  await page.keyboard.press('Enter')
  await page.getByText('This is turn 2 of this session').waitFor({ timeout: 20_000 })
  check('turn 2: harness session resumed', true)
  check('turn 2: no approval needed (session grant)', (await card.count()) === 0)
  await page.screenshot({ path: `${OUT}/05-turn2.png` })

  const raw = await (await fetch(`${BASE}/api/transcript?threadId=${threadUrl.split('/t/')[1]}`)).text()
  const toolStarts = raw.split('\n').filter((l) => l.includes('"TOOL_CALL_START"')).length
  check('raw record keeps every tool call of every turn', toolStarts === 4, `${toolStarts} TOOL_CALL_START events`)
  check('no page or console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()

  // ---------------------------------------------------------------- phone
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  })
  const m = await phone.newPage()
  await m.goto(threadUrl)
  await m.getByText('This is turn 2 of this session').waitFor({ timeout: 15_000 })
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check('phone: no horizontal overflow', overflow <= 0, `${overflow}px`)
  const stepRows = await m.getByRole('button', { name: /steps?/ }).allInnerTexts()
  // Only the latest turn still has steps in TanStack's saved transcript (earlier
  // turns' tool rows are dropped upstream; the raw record above keeps them).
  check('after reload: the latest turn renders as one steps row', stepRows.length === 1 && stepRows[0].includes('2 steps'), stepRows.map((t) => t.replace(/\s+/g, ' ')).join(' / '))
  await m.screenshot({ path: `${OUT}/06-phone-thread.png` })
  await m.getByRole('button', { name: 'Toggle Sidebar' }).click()
  await m.getByText('set retries to 3').last().waitFor()
  await m.waitForTimeout(400) // let the sheet finish sliding in
  await m.screenshot({ path: `${OUT}/07-phone-sidebar.png` })
  await phone.close()
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
