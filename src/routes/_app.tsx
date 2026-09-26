import { Outlet, createFileRoute } from '@tanstack/react-router'
import { AppSidebar } from '@/components/app-sidebar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { useLiveEvents } from '@/lib/api'

export const Route = createFileRoute('/_app')({ component: AppLayout })

function AppLayout() {
  useLiveEvents()
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-dvh overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  )
}
