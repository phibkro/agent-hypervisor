import { createFileRoute, Link } from '@tanstack/react-router';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="flex flex-col items-center justify-center text-center flex-1">
        <h1 className="font-semibold text-2xl mb-2">agent-hypervisor</h1>
        <p className="max-w-xl text-fd-muted-foreground mb-6">
          A self-hosted control plane that runs coding agents with exactly the authority their task needs, and lets you
          supervise them from anywhere. Domain model, formal checks and implementation notes.
        </p>
        <Link
          to="/docs/$"
          params={{
            _splat: '',
          }}
          className="px-3 py-2 rounded-lg bg-fd-primary text-fd-primary-foreground font-medium text-sm mx-auto"
        >
          Open Docs
        </Link>
      </div>
    </HomeLayout>
  );
}
