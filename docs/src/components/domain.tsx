/**
 * MDX components for build-time artifacts (see scripts/artifacts.ts).
 *
 *   <ContextMap />                                   graphical context map (Context Mapper)
 *   <ContextMap variant="components" />              the PlantUML component view of the same map
 *   <BoundedContextDiagram name="Authority" />       class diagram of one bounded context
 *   <Aggregate context="Authority" name="Capability" />
 *   <Lifecycle context="Authority" flow="CapabilityRequestLifecycle" />
 *   <SubdomainDiagram name="Authority" />
 *   <UseCases />
 *   <DiagramIndex />                                 every generated diagram, grouped
 *   <AlloyResults />                                 results table from the Alloy checks
 *   <AlloyTrace command="MountsAreBacked" />         counterexample / instance trace
 *
 * A reference to a diagram that does not exist renders a visible error, so a renamed
 * aggregate or flow in the model shows up on the page rather than as a silent gap.
 */
import type { ReactNode } from 'react';
import domain from '@/generated/domain.json';
import alloy from '@/generated/alloy.json';

type DiagramKind = 'context-map' | 'context-map-components' | 'bounded-context' | 'aggregate' | 'lifecycle' | 'subdomain' | 'use-cases';
interface Diagram {
  file: string;
  kind: DiagramKind;
  context?: string;
  name: string;
}
interface AlloyResult {
  index: number;
  kind: 'check' | 'run';
  name: string;
  scope: string;
  outcome: 'holds' | 'counterexample' | 'instance' | 'no instance';
  expected: boolean;
  doc: string;
  trace?: string;
}

const diagrams = domain.diagrams as Diagram[];
const results = alloy.results as AlloyResult[];
const repoUrl = 'https://github.com/phibkro/agent-hypervisor/blob/main';

function assetUrl(file: string) {
  return `${import.meta.env.BASE_URL}generated/domain/${file}`;
}

/**
 * Opens a generated SVG in a new tab. A button rather than a link on purpose: the prerender
 * crawler follows every href and would try to render the SVGs as pages.
 */
function OpenSvg({ src, className, title, children }: { src: string; className?: string; title?: string; children: ReactNode }) {
  return (
    <button type="button" className={className} title={title} onClick={() => window.open(src, '_blank', 'noopener')}>
      {children}
    </button>
  );
}

function Missing({ what }: { what: string }) {
  return (
    <div className="my-4 rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm">
      Diagram not found in the generated artifacts: <code>{what}</code>. Run <code>bun run artifacts</code>, or check the
      name against <code>domain/agent-hypervisor.cml</code>.
    </div>
  );
}

function Figure({ diagram, caption, alt }: { diagram: Diagram; caption?: ReactNode; alt: string }) {
  const src = assetUrl(diagram.file);
  return (
    <figure className="not-prose my-6">
      {/* Generated diagrams have a white canvas; keep it in dark mode for legibility. */}
      <OpenSvg src={src} className="block w-full cursor-zoom-in overflow-x-auto rounded-xl border bg-white p-4" title="Open full size">
        <img src={src} alt={alt} loading="lazy" className="mx-auto h-auto max-w-full" />
      </OpenSvg>
      <figcaption className="mt-2 text-center text-sm text-fd-muted-foreground">
        {caption ?? alt} <span className="opacity-70">· generated from <a className="underline" href={`${repoUrl}/${domain.model}`}>{domain.model}</a></span>
      </figcaption>
    </figure>
  );
}

function find(predicate: (d: Diagram) => boolean) {
  return diagrams.find(predicate);
}

export function ContextMap({ variant = 'graphical', caption }: { variant?: 'graphical' | 'components'; caption?: ReactNode }) {
  const d = find((x) => x.kind === (variant === 'graphical' ? 'context-map' : 'context-map-components'));
  if (!d) return <Missing what={`context map (${variant})`} />;
  return <Figure diagram={d} alt="Context map" caption={caption} />;
}

export function BoundedContextDiagram({ name, caption }: { name: string; caption?: ReactNode }) {
  const d = find((x) => x.kind === 'bounded-context' && x.context === name);
  if (!d) return <Missing what={`bounded context ${name}`} />;
  return <Figure diagram={d} alt={`Bounded context ${name}`} caption={caption} />;
}

export function Aggregate({ context, name, caption }: { context: string; name: string; caption?: ReactNode }) {
  const d = find((x) => x.kind === 'aggregate' && x.context === context && x.name === name);
  if (!d) return <Missing what={`aggregate ${context}::${name}`} />;
  return <Figure diagram={d} alt={`Aggregate ${name} (${context})`} caption={caption} />;
}

export function Lifecycle({ context, flow, caption }: { context: string; flow: string; caption?: ReactNode }) {
  const d = find((x) => x.kind === 'lifecycle' && x.context === context && x.name === flow);
  if (!d) return <Missing what={`lifecycle ${context}::${flow}`} />;
  return <Figure diagram={d} alt={`Lifecycle ${flow} (${context})`} caption={caption} />;
}

export function SubdomainDiagram({ name, caption }: { name: string; caption?: ReactNode }) {
  const d = find((x) => x.kind === 'subdomain' && x.name === name);
  if (!d) return <Missing what={`subdomain ${name}`} />;
  return <Figure diagram={d} alt={`Subdomain ${name}`} caption={caption} />;
}

export function UseCases({ caption }: { caption?: ReactNode }) {
  const d = find((x) => x.kind === 'use-cases');
  if (!d) return <Missing what="use cases" />;
  return <Figure diagram={d} alt="User stories" caption={caption} />;
}

const kindLabel: Record<DiagramKind, string> = {
  'context-map': 'Context map',
  'context-map-components': 'Context map (components)',
  'bounded-context': 'Bounded contexts',
  aggregate: 'Aggregates',
  lifecycle: 'Lifecycles',
  subdomain: 'Subdomains',
  'use-cases': 'User stories',
};

export function DiagramIndex() {
  const groups = new Map<DiagramKind, Diagram[]>();
  for (const d of diagrams) groups.set(d.kind, [...(groups.get(d.kind) ?? []), d]);
  return (
    <div className="not-prose my-6 grid gap-4 sm:grid-cols-2">
      {[...groups].map(([kind, items]) => (
        <div key={kind} className="rounded-xl border p-4">
          <div className="mb-2 font-medium">{kindLabel[kind]}</div>
          <ul className="space-y-1 text-sm">
            {items.map((d) => (
              <li key={d.file}>
                <OpenSvg src={assetUrl(d.file)} className="text-left text-fd-primary underline-offset-2 hover:underline">
                  {d.context && d.context !== d.name ? `${d.context} · ` : ''}
                  {d.name}
                </OpenSvg>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Alloy */

const outcomeStyle: Record<AlloyResult['outcome'], string> = {
  holds: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  counterexample: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  instance: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'no instance': 'bg-red-500/15 text-red-700 dark:text-red-300',
};

export function AlloyResults() {
  if (alloy.skipped) {
    return <div className="my-4 rounded-lg border p-3 text-sm">Alloy was skipped in this build (<code>--skip-alloy</code>).</div>;
  }
  return (
    <div className="not-prose my-6 overflow-x-auto rounded-xl border">
      <table className="w-full text-sm">
        <thead className="bg-fd-muted text-left">
          <tr>
            <th className="p-2 font-medium">Command</th>
            <th className="p-2 font-medium">What it states</th>
            <th className="p-2 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.index} className="border-t align-top">
              <td className="p-2 font-mono text-xs">
                {r.kind} {r.name}
                <div className="mt-1 font-sans text-fd-muted-foreground">{r.scope}</div>
              </td>
              <td className="p-2">{r.doc || <span className="text-fd-muted-foreground">(no comment in model)</span>}</td>
              <td className="p-2 whitespace-nowrap">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${outcomeStyle[r.outcome]}`}>{r.outcome}</span>
                {!r.expected && <div className="mt-1 text-xs text-red-600">unexpected</div>}
                {r.kind === 'check' && r.outcome === 'counterexample' && r.expected && (
                  <div className="mt-1 text-xs text-fd-muted-foreground">expected (documented)</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t px-3 py-2 text-xs text-fd-muted-foreground">
        Bounded model checking with Alloy 6 at build time, from{' '}
        <a className="underline" href={`${repoUrl}/${alloy.model}`}>{alloy.model}</a>. "Holds" means no counterexample within the scope, not a proof.
      </div>
    </div>
  );
}

export function AlloyTrace({ command }: { command: string }) {
  const r = results.find((x) => x.name === command);
  if (!r) return <Missing what={`Alloy command ${command}`} />;
  if (!r.trace) return <div className="my-4 rounded-lg border p-3 text-sm"><code>{command}</code> {r.outcome}: no trace to show.</div>;
  return (
    <figure className="not-prose my-6">
      <pre className="overflow-x-auto rounded-xl border bg-fd-muted p-4 text-xs leading-relaxed">{r.trace}</pre>
      <figcaption className="mt-2 text-center text-sm text-fd-muted-foreground">
        Alloy {r.outcome} for <code>{command}</code> ({r.scope})
      </figcaption>
    </figure>
  );
}
