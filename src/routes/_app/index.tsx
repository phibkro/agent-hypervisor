import { createFileRoute } from '@tanstack/react-router'
import { MessageSquarePlus } from 'lucide-react'
import { ChatHeader } from '@/components/chat-header'
import { NewSessionButton } from '@/components/app-sidebar'

export const Route = createFileRoute('/_app/')({ component: Home })

function Home() {
  return (
    <div className="flex h-full flex-col">
      <ChatHeader title="Agent Control Plane" />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <MessageSquarePlus className="size-10 text-muted-foreground" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">No session open</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Start a session to run omp on this host. It keeps working when you close the tab; come back from any device.
          </p>
        </div>
        <NewSessionButton variant="default" />
      </div>
    </div>
  )
}
