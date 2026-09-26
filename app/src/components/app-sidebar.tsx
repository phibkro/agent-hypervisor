import { useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, FolderPlus, HardDriveDownload, LoaderCircle, Plus, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { getJson, postJson } from '@/lib/api'
import type { ExternalSession, Project, SessionStatus, ThreadSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function StatusDot({ status }: { status: SessionStatus }) {
  const cls: Record<SessionStatus, string> = {
    'needs-you': 'bg-amber-500',
    running: 'bg-emerald-500 animate-pulse',
    active: 'bg-emerald-500/60',
    inactive: 'bg-transparent',
    archived: 'bg-transparent',
  }
  return <span className={cn('size-2 shrink-0 rounded-full', cls[status])} aria-label={status} title={status} />
}

function useNewSession() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { setOpenMobile } = useSidebar()
  return async (projectId?: string) => {
    const r = await postJson('/api/threads', projectId ? { projectId } : {})
    if (!r.ok) throw new Error(await r.text())
    const t = (await r.json()) as { id: string }
    await qc.invalidateQueries({ queryKey: ['threads'] })
    setOpenMobile(false)
    await navigate({ to: '/t/$threadId', params: { threadId: t.id } })
  }
}

export function NewSessionButton({ variant = 'outline', projectId }: { variant?: 'default' | 'outline'; projectId?: string }) {
  const start = useNewSession()
  return (
    <Button variant={variant} className={variant === 'outline' ? 'w-full justify-start' : undefined} onClick={() => start(projectId)}>
      <Plus /> New session
    </Button>
  )
}

export function AddProjectForm({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient()
  const [root, setRoot] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="space-y-1.5"
      onSubmit={async (e) => {
        e.preventDefault()
        const r = await postJson('/api/projects', { root })
        if (!r.ok) return setError(await r.text())
        setRoot('')
        setError(null)
        await qc.invalidateQueries()
        onDone?.()
      }}
    >
      <div className="flex gap-1.5">
        <Input
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          placeholder="/path/to/repo on the host"
          aria-label="Project directory"
          className="h-8 font-mono text-xs"
        />
        <Button size="sm" type="submit" disabled={!root.trim()}>
          Add
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  )
}

function ThreadItem({ t, activeId, showProject }: { t: ThreadSummary; activeId?: string; showProject?: string }) {
  const { setOpenMobile } = useSidebar()
  const dim = t.status === 'inactive' || t.status === 'archived'
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={activeId === t.id} className="pr-11">
        <Link to="/t/$threadId" params={{ threadId: t.id }} onClick={() => setOpenMobile(false)}>
          <StatusDot status={t.status} />
          <span className={cn('truncate', dim && 'text-muted-foreground')}>
            {t.title ?? 'New session'}
            {showProject && <span className="ml-1 text-xs opacity-60">· {showProject}</span>}
          </span>
        </Link>
      </SidebarMenuButton>
      {t.pending > 0 ? (
        <SidebarMenuBadge className="bg-amber-500/20 text-foreground" aria-label="needs your decision">
          {t.pending}
        </SidebarMenuBadge>
      ) : (
        <SidebarMenuBadge className="font-normal text-muted-foreground">{ago(t.lastActivityAt)}</SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
}

/** Sessions on disk under the project (e.g. started in the omp TUI) that can be imported. */
function OnDisk({ project }: { project: Project }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { setOpenMobile } = useSidebar()
  const [importing, setImporting] = useState<string | null>(null)
  const { data, isLoading, error } = useQuery({
    queryKey: ['external', project.id],
    queryFn: () => getJson<Array<ExternalSession>>(`/api/external?projectId=${project.id}`),
    staleTime: 10_000,
  })
  const doImport = async (s: ExternalSession) => {
    if (s.maybeLive && !confirm('This session changed in the last 15 minutes and may still be open in another omp. Import anyway?')) return
    setImporting(s.sessionId)
    try {
      const r = await postJson('/api/external', { projectId: project.id, ...s })
      if (!r.ok) return alert(await r.text())
      const { thread } = (await r.json()) as { thread: { id: string } }
      await qc.invalidateQueries()
      setOpenMobile(false)
      await navigate({ to: '/t/$threadId', params: { threadId: thread.id } })
    } finally {
      setImporting(null)
    }
  }
  return (
    <div className="mx-2 mb-2 rounded-md border bg-sidebar-accent/40 p-2 text-xs" aria-label={`On disk in ${project.name}`}>
      <div className="mb-1 font-medium text-muted-foreground">On disk, not imported</div>
      {isLoading && <LoaderCircle className="size-3.5 animate-spin" />}
      {error && <p className="text-destructive">{(error as Error).message}</p>}
      {data?.length === 0 && <p className="text-muted-foreground">Nothing new.</p>}
      <ul className="space-y-1">
        {data?.map((s) => (
          <li key={s.sessionId} className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate" title={`${s.cwd}\n${s.sessionId}`}>
              {s.title ?? s.sessionId}
              {s.cwd !== project.root && <span className="ml-1 opacity-60">{s.cwd.slice(project.root.length) || '/'}</span>}
            </span>
            {s.maybeLive && <TriangleAlert className="size-3.5 shrink-0 text-amber-500" aria-label="may be live" />}
            <span className="shrink-0 text-muted-foreground">{s.updatedAt ? ago(Date.parse(s.updatedAt)) : ''}</span>
            <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={importing !== null} onClick={() => doImport(s)}>
              {importing === s.sessionId ? <LoaderCircle className="animate-spin" /> : 'Import'}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ProjectGroup({
  project,
  threads,
  activeId,
}: {
  project: Project
  threads: Array<ThreadSummary>
  activeId?: string
}) {
  const start = useNewSession()
  const [disk, setDisk] = useState(false)
  return (
    <SidebarGroup>
      <SidebarGroupLabel title={project.root}>{project.name}</SidebarGroupLabel>
      <SidebarGroupAction className="right-9" onClick={() => setDisk((v) => !v)} title="Sessions on disk" aria-label={`Sessions on disk in ${project.name}`}>
        <HardDriveDownload />
      </SidebarGroupAction>
      <SidebarGroupAction onClick={() => start(project.id)} title="New session" aria-label={`New session in ${project.name}`}>
        <Plus />
      </SidebarGroupAction>
      {disk && <OnDisk project={project} />}
      <SidebarMenu>
        {threads.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No sessions.</p>}
        {threads.map((t) => (
          <ThreadItem key={t.id} t={t} activeId={activeId} />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}

export function AppSidebar() {
  const params = useParams({ strict: false }) as { threadId?: string }
  const [showArchived, setShowArchived] = useState(false)
  const [adding, setAdding] = useState(false)
  const { data: threads = [] } = useQuery({
    queryKey: ['threads'],
    queryFn: () => getJson<Array<ThreadSummary>>('/api/threads'),
  })
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => getJson<Array<Project>>('/api/projects'),
  })

  const names = new Map(projects.map((p) => [p.id, p.name]))
  const needsYou = threads.filter((t) => t.status === 'needs-you')
  const archivedCount = threads.filter((t) => t.status === 'archived').length
  const listed = threads.filter((t) => t.status !== 'needs-you' && (showArchived || t.status !== 'archived'))
  const byProject = (id: string | null) => listed.filter((t) => t.projectId === id)
  const loose = byProject(null)

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="px-2 py-1 text-sm font-semibold">Agent Control Plane</div>
      </SidebarHeader>
      <SidebarContent>
        {needsYou.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-amber-600 dark:text-amber-400">Needs you</SidebarGroupLabel>
            <SidebarMenu>
              {needsYou.map((t) => (
                <ThreadItem key={t.id} t={t} activeId={params.threadId} showProject={t.projectId ? names.get(t.projectId) : undefined} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
        {projects.map((p) => (
          <ProjectGroup key={p.id} project={p} threads={byProject(p.id)} activeId={params.threadId} />
        ))}
        {loose.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>No project</SidebarGroupLabel>
            <SidebarMenu>
              {loose.map((t) => (
                <ThreadItem key={t.id} t={t} activeId={params.threadId} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
        {projects.length === 0 && threads.length === 0 && (
          <p className="px-4 py-2 text-sm text-muted-foreground">Add a project directory to start.</p>
        )}
      </SidebarContent>
      <SidebarFooter className="gap-2">
        {adding ? (
          <AddProjectForm onDone={() => setAdding(false)} />
        ) : (
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => setAdding(true)}>
            <FolderPlus /> Add project
          </Button>
        )}
        {archivedCount > 0 && (
          <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={() => setShowArchived((v) => !v)}>
            <Archive /> {showArchived ? 'Hide' : 'Show'} archived ({archivedCount})
          </Button>
        )}
      </SidebarFooter>
    </Sidebar>
  )
}
