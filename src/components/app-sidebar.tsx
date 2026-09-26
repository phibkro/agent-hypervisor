import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { getJson, postJson } from '@/lib/api'
import type { ThreadSummary } from '@/lib/api'

function groupLabel(ts: number): string {
  const day = 86_400_000
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  if (ts >= startOfToday) return 'Today'
  if (ts >= startOfToday - day) return 'Yesterday'
  if (ts >= startOfToday - 7 * day) return 'Previous 7 days'
  return 'Older'
}

export function NewSessionButton({ variant = 'outline' }: { variant?: 'default' | 'outline' }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { setOpenMobile } = useSidebar()
  return (
    <Button
      variant={variant}
      className={variant === 'outline' ? 'w-full justify-start' : undefined}
      onClick={async () => {
        const r = await postJson('/api/threads', {})
        const t = (await r.json()) as { id: string }
        await qc.invalidateQueries({ queryKey: ['threads'] })
        setOpenMobile(false)
        await navigate({ to: '/t/$threadId', params: { threadId: t.id } })
      }}
    >
      <Plus /> New session
    </Button>
  )
}

export function AppSidebar() {
  const params = useParams({ strict: false }) as { threadId?: string }
  const { setOpenMobile } = useSidebar()
  const { data: threads = [] } = useQuery({
    queryKey: ['threads'],
    queryFn: () => getJson<Array<ThreadSummary>>('/api/threads'),
  })

  const groups = new Map<string, Array<ThreadSummary>>()
  for (const t of threads) {
    const g = groupLabel(t.updatedAt)
    groups.set(g, [...(groups.get(g) ?? []), t])
  }

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="px-2 py-1 text-sm font-semibold">Agent Control Plane</div>
        <NewSessionButton />
      </SidebarHeader>
      <SidebarContent>
        {threads.length === 0 && <p className="px-4 py-2 text-sm text-muted-foreground">No sessions yet.</p>}
        {[...groups].map(([label, items]) => (
          <SidebarGroup key={label}>
            <SidebarGroupLabel>{label}</SidebarGroupLabel>
            <SidebarMenu>
              {items.map((t) => (
                <SidebarMenuItem key={t.id}>
                  <SidebarMenuButton asChild isActive={params.threadId === t.id}>
                    <Link to="/t/$threadId" params={{ threadId: t.id }} onClick={() => setOpenMobile(false)}>
                      {t.running && (
                        <span className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-label="running" />
                      )}
                      <span className="truncate">{t.title ?? 'New session'}</span>
                    </Link>
                  </SidebarMenuButton>
                  {t.pendingApprovals > 0 && (
                    <SidebarMenuBadge className="bg-warning/20 text-foreground" aria-label="needs your decision">
                      {t.pendingApprovals}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  )
}
