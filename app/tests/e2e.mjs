// End-to-end: the web client against the server + fake ACP agent.
// Start from empty state: DATA_DIR and the fake agent's state file removed,
// server listening on BASE (default http://127.0.0.1:3000).
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000'
const OUT = process.env.OUT ?? '/tmp/e2e-shots'
const PROJECT = process.env.E2E_PROJECT ?? '/tmp/demo-project'
const STATE = process.env.FAKE_AGENT_STATE ?? '/tmp/fake-acp-agent-state.json'
mkdirSync(OUT, { recursive: true })
mkdirSync(`${PROJECT}/packages/api`, { recursive: true })

// A session "started in the omp TUI" an hour ago, in a subdirectory of the project.
const state = (() => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return {}
  }
})()
state['tui-session-1'] = {
  turns: 1,
  cwd: `${PROJECT}/packages/api`,
  title: 'Fix flaky retry test',
  updatedAt: new Date(Date.now() - 3600_000).toISOString(),
  history: [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Fix the flaky retry test' } },
    { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read test/retry.test.ts', kind: 'read', status: 'in_progress', rawInput: { path: 'test/retry.test.ts' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed', rawOutput: { bytes: 120 } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The test used real timers. I switched it to fake timers.' } },
  ],
}
writeFileSync(STATE, JSON.stringify(state))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
const threadStatus = async (id) => (await (await fetch(`${BASE}/api/threads`)).json()).find((t) => t.id === id)?.status
const idOf = (url) => url.split('/t/')[1]

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' })
let promptUrl
try {
  // ---------------------------------------------------------------- desktop
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

  // Projects: empty state asks for a directory.
  await page.goto(BASE)
  await page.getByRole('heading', { name: 'Add a project' }).waitFor()
  await page.screenshot({ path: `${OUT}/00-add-project.png` })
  await page.getByLabel('Project directory').first().fill(PROJECT)
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  const projectName = PROJECT.split('/').pop()
  await page.getByText(projectName, { exact: true }).first().waitFor()
  check('project added from a host directory', true)

  await page.getByRole('main').getByRole('button', { name: 'New session' }).click()
  await page.waitForURL(/\/t\//)
  const threadUrl = page.url()

  // ------------------------------------------------ approvals (as before)
  await page.getByLabel('Message').fill('set retries to 3')
  await page.keyboard.press('Enter')
  const card = page.getByRole('alert').filter({ hasText: 'omp wants to' })
  await card.waitFor({ timeout: 15_000 })
  check('approval card appears while omp waits', await card.isVisible())
  check('sidebar pins the session under Needs you', (await page.getByText('Needs you').count()) > 0)
  await page.screenshot({ path: `${OUT}/01-approval.png` })

  await page.reload()
  await card.waitFor({ timeout: 15_000 })
  check('after reload: transcript and pending approval restored', (await page.getByText('set retries to 3', { exact: true }).count()) > 0)

  await card.getByRole('button', { name: 'Allow for session' }).click()
  await page.getByText('This is turn 1 of this session').waitFor({ timeout: 15_000 })
  check('reply streams in after approving', (await card.count()) === 0)
  check('tool activity folds into a steps row', (await page.getByRole('button', { name: /steps/ }).count()) > 0)

  await page.getByLabel('Message').fill('now add a test')
  await page.keyboard.press('Enter')
  await page.getByText('This is turn 2 of this session').waitFor({ timeout: 20_000 })
  check('turn 2: session resumed, session grant skips approval', (await card.count()) === 0)
  const raw = await (await fetch(`${BASE}/api/transcript?threadId=${idOf(threadUrl)}`)).text()
  const toolStarts = raw.split('\n').filter((l) => l.includes('"TOOL_CALL_START"')).length
  check('raw record keeps every tool call of every turn', toolStarts === 4, `${toolStarts}`)

  // ------------------------------------------------ prompts (omp `ask` via ACP elicitation)
  await page.getByRole('button', { name: `New session in ${projectName}` }).click()
  await page.waitForURL((u) => u.href !== threadUrl && /\/t\//.test(u.href))
  promptUrl = page.url()
  await page.getByLabel('Message').fill('please ask me about the cache')
  await page.keyboard.press('Enter')
  const ask = page.getByRole('group', { name: 'omp is asking' })
  await ask.waitFor({ timeout: 15_000 })
  check('prompt card shows both questions', (await ask.getByText('Which database should the cache use?').count()) === 1 && (await ask.getByText('Which checks should run before merge?').count()) === 1)
  check('single-select preselects the recommended option', await ask.getByRole('radio', { name: /SQLite/ }).isChecked())
  check('status is needs-you while omp waits for an answer', (await threadStatus(idOf(promptUrl))) === 'needs-you')
  await page.screenshot({ path: `${OUT}/02-prompt.png` })

  await page.reload()
  await ask.waitFor({ timeout: 15_000 })
  check('after reload: the open question is still there', true)

  await ask.getByRole('radio', { name: /Redis/ }).click()
  await ask.getByRole('checkbox', { name: 'lint' }).click()
  await ask.getByRole('checkbox', { name: 'tests' }).click()
  await ask.getByLabel('Which checks should run before merge?: other').fill('e2e')
  await page.screenshot({ path: `${OUT}/03-prompt-filled.png` })
  await ask.getByRole('button', { name: 'Submit' }).click()

  const confirmCard = page.getByRole('group', { name: 'omp is asking' }).filter({ hasText: 'Apply: Redis cache, checks lint, tests, e2e?' })
  await confirmCard.waitFor({ timeout: 15_000 })
  check('multi-select + Other answer reaches omp, confirm follows', true)
  await page.screenshot({ path: `${OUT}/04-confirm.png` })
  await confirmCard.getByRole('button', { name: 'Yes' }).click()
  await page.getByText('Confirmed. Cache: Redis. Checks: lint, tests, e2e. Turn 1.').waitFor({ timeout: 15_000 })
  check('confirm Yes completes the turn', (await ask.count()) === 0)

  // Other in place of a single-select choice.
  await page.getByLabel('Message').fill('ask me once more')
  await page.keyboard.press('Enter')
  await ask.waitFor({ timeout: 15_000 })
  await ask.getByLabel('Which database should the cache use?: other').fill('Postgres')
  await ask.getByRole('button', { name: 'Submit' }).click()
  const confirm2 = page.getByRole('group', { name: 'omp is asking' }).filter({ hasText: 'Apply: Postgres cache' })
  await confirm2.waitFor({ timeout: 15_000 })
  await confirm2.getByRole('button', { name: 'No' }).click()
  await page.getByText('Not confirmed, nothing changed. Turn 2.').waitFor({ timeout: 15_000 })
  check('Other replaces the single choice; confirm No is respected', true)

  // ------------------------------------------------ archive
  const promptId = idOf(promptUrl)
  await page.getByRole('button', { name: 'Archive' }).click()
  await page.getByRole('button', { name: /Show archived \(1\)/ }).waitFor()
  check('archived session leaves the list, status archived', (await threadStatus(promptId)) === 'archived')
  await page.getByRole('button', { name: /Show archived/ }).click()
  await page.screenshot({ path: `${OUT}/05-archived.png` })

  await page.getByLabel('Message').fill('ask again')
  await page.keyboard.press('Enter')
  await ask.waitFor({ timeout: 15_000 })
  check('new activity outranks archive (needs-you)', (await threadStatus(promptId)) === 'needs-you')
  await ask.getByRole('button', { name: 'Decline' }).click()
  await page.getByText('You declined the questions. Turn 3.').waitFor({ timeout: 15_000 })
  check('decline reaches omp; session is active again', (await threadStatus(promptId)) === 'active')

  // ------------------------------------------------ import from disk
  await page.getByRole('button', { name: `Sessions on disk in ${projectName}` }).click()
  const disk = page.getByLabel(`On disk in ${projectName}`)
  await disk.getByText('Fix flaky retry test').waitFor({ timeout: 15_000 })
  check('on-disk session in a subdirectory is listed', (await disk.getByText('/packages/api').count()) === 1)
  await page.screenshot({ path: `${OUT}/06-on-disk.png` })
  await disk.getByRole('button', { name: 'Import' }).click()
  await page.getByText('I switched it to fake timers.').waitFor({ timeout: 15_000 })
  check('import replays the transcript', (await page.getByText('imported', { exact: true }).count()) === 1)
  await page.getByLabel('Message').fill('also add a regression note')
  await page.keyboard.press('Enter')
  await card.waitFor({ timeout: 15_000 })
  await card.getByRole('button', { name: 'Allow once' }).click()
  await page.getByText('This is turn 2 of this session').waitFor({ timeout: 15_000 })
  check('imported session continues the harness session (turn 2)', true)
  await page.screenshot({ path: `${OUT}/07-imported.png` })

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
  await m.goto(promptUrl)
  await m.getByText('You declined the questions. Turn 3.').waitFor({ timeout: 15_000 })
  await m.getByLabel('Message').fill('one last ask')
  await m.keyboard.press('Enter')
  await m.getByRole('group', { name: 'omp is asking' }).waitFor({ timeout: 15_000 })
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check('phone: prompt card fits, no horizontal overflow', overflow <= 0, `${overflow}px`)
  await m.screenshot({ path: `${OUT}/08-phone-prompt.png` })
  await m.getByRole('group', { name: 'omp is asking' }).getByRole('button', { name: 'Decline' }).click()
  await m.getByText('Turn 4.').waitFor({ timeout: 15_000 })
  await m.getByRole('button', { name: 'Toggle Sidebar' }).click()
  await m.waitForTimeout(400)
  await m.screenshot({ path: `${OUT}/09-phone-sidebar.png` })
  await phone.close()
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
