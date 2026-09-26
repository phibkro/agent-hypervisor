import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'

export function ChatHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
      {children}
    </header>
  )
}
