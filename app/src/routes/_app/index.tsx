import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { FolderGit2 } from 'lucide-react'
import { ChatHeader } from '@/components/chat-header'
import { AddProjectForm, NewSessionButton } from '@/components/app-sidebar'
import { getJson } from '@/lib/api'
import type { Project } from '@/lib/api'

export const Route = createFileRoute('/_app/')({ component: Home })

function Home() {
  const { data: projects, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: () => getJson<Array<Project>>('/api/projects'),
  })
  return (
    <div className="flex h-full flex-col">
      <ChatHeader title="Agent Control Plane" />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <FolderGit2 className="size-10 text-muted-foreground" />
        {isLoading ? null : projects && projects.length > 0 ? (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">No session open</h1>
              <p className="max-w-sm text-sm text-muted-foreground">
                Sessions keep running when you close the tab; come back from any device.
              </p>
            </div>
            <div className="flex w-full max-w-sm flex-col gap-2">
              {projects.map((p) => (
                <div key={p.id} className="flex items-center gap-2 rounded-lg border p-2 text-left">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{p.name}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{p.root}</div>
                  </div>
                  <NewSessionButton variant="default" projectId={p.id} />
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">Add a project</h1>
              <p className="max-w-sm text-sm text-muted-foreground">
                A project is a directory on the host. Sessions started anywhere inside it belong to it, including ones you
                started in the omp TUI, which you can import.
              </p>
            </div>
            <div className="w-full max-w-sm">
              <AddProjectForm />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
