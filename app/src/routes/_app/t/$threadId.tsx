import { createFileRoute } from '@tanstack/react-router'
import { ChatView } from '@/components/chat-view'

export const Route = createFileRoute('/_app/t/$threadId')({
  component: ThreadPage,
  ssr: false,
})

function ThreadPage() {
  const { threadId } = Route.useParams()
  // Keyed so switching threads mounts a fresh chat client with its own hydrate.
  return <ChatView key={threadId} threadId={threadId} />
}
