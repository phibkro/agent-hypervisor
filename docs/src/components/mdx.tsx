import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { Mermaid } from '@/components/mdx/mermaid';
import * as Domain from '@/components/domain';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
// mdxcn (installed with the shadcn CLI). Registered by name; Fumadocs keeps Callout and Steps.
import { GraphFlow } from '@/components/graph-flow';
import { GraphCheck } from '@/components/graph-check';
import { GraphTimeline } from '@/components/graph-timeline';
import { GraphTree } from '@/components/graph-tree';
import { GraphTable } from '@/components/graph-table';
import { GraphCompare } from '@/components/graph-compare';
import { Terminal } from '@/components/terminal';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Mermaid,
    Tab,
    Tabs,
    Accordion,
    Accordions,
    GraphFlow,
    GraphCheck,
    GraphTimeline,
    GraphTree,
    GraphTable,
    GraphCompare,
    Terminal,
    ...Domain,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
