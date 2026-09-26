/**
 * Server entry points, re-exported for the API routes.
 *
 * db.ts          config, SQLite, TanStack persistence, our tables, event bus
 * status.ts      the session status algebra (pure)
 * attention.ts   approvals, grants and prompts: everything that needs a human
 * projects.ts    projects (roots) and threads, with derived status
 * runs.ts        the chat() assembly for a run
 * acp-shim.ts    ACP transport that adds elicitation (omp's `ask`)
 * importer.ts    list and import on-disk sessions over ACP
 */
export { bus, config, persistence, runs } from './db'
export { answerPrompt, listApprovals, listGrants, listPrompts, resolveApproval } from './attention'
export type { Decision, PromptAnswer } from './attention'
export { addProject, createThread, getThread, listProjects, listThreads, setArchived } from './projects'
export { driving, listRunEvents, newTurn, startRun } from './runs'
export { importSession, listExternal } from './importer'
