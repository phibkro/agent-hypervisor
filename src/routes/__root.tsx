import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import appCss from '../styles.css?url'

// Follow the OS theme without a flash: set the class before first paint.
const THEME_SCRIPT = `(function(){try{var d=window.matchMedia('(prefers-color-scheme: dark)');var s=function(){document.documentElement.classList.toggle('dark',d.matches)};s();d.addEventListener('change',s)}catch(e){}})()`

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23171717'/%3E%3Cpath d='M9 11h14M9 16h10M9 21h6' stroke='%23fafafa' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { name: 'theme-color', content: '#0a0a0a' },
      { title: 'Agent Control Plane' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: ICON },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
})

function RootComponent() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } }))
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
