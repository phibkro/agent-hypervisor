# docs

The agent-hypervisor docs site: Fumadocs on TanStack Start (SPA with prerendering), deployed to GitHub Pages by
`.github/workflows/docs.yml` on every push to `main`.

Diagrams and model-checking results are generated at build time from the models in the repository, not committed:

| Source | Tool | Output |
|---|---|---|
| `../domain/agent-hypervisor.cml` | Context Mapper CLI 6.12.0, PlantUML 1.2026.8 | `public/generated/domain/*.svg`, `src/generated/domain.json` |
| `../spec/capabilities.als` | Alloy 6.2.0 | `src/generated/alloy.json` |

A model that fails `cm validate`, or an Alloy check with an unexpected outcome, fails the build.

Every diagram is rendered twice, light and `dark/` (PlantUML `--dark-mode`, Graphviz with dark defaults), and the
page shows the one matching the theme. Before rendering, `scripts/puml-layout.ts` re-flows Context Mapper's
PlantUML top to bottom (sections stacked, members in two columns, Smetana layout) so diagrams stay narrow; on a
phone a diagram is never shrunk below 70% of its natural size, and its card scrolls sideways instead.

```sh
bun install
bun run dev          # generates diagrams on first run (skips Alloy), then vite dev on :3000/docs
bun run artifacts    # regenerate diagrams and Alloy results
bun run build        # artifacts + static build into .output/public
BASE_PATH=/agent-hypervisor/ bun run build   # as on GitHub Pages
```

Needs Java 17+, Graphviz (`dot`) and Python 3. Tools download into `.cache/tools` on first use.

## Writing pages

Pages are MDX in `content/docs`. Besides Fumadocs' components:

- Context Mapper: `<ContextMap />`, `<BoundedContextDiagram name="Authority" />`,
  `<Aggregate context="Authority" name="Capability" />`, `<Lifecycle context="Authority" flow="CapabilityRequestLifecycle" />`,
  `<SubdomainDiagram name="Authority" />`, `<UseCases />`, `<DiagramIndex />`
- CML source by region: `<include cwd lang="cml">../domain/agent-hypervisor.cml#authority</include>`
  (regions are `//#region name` markers in the model)
- Alloy: `<AlloyResults />`, `<AlloyTrace command="MountsAreBacked" />`
- Mermaid: fenced ```` ```mermaid ```` blocks
- mdxcn (installed with the shadcn CLI): `GraphFlow`, `GraphCheck`, `GraphTimeline`, `GraphTree`, `GraphTable`,
  `GraphCompare`, `Terminal`

`src/lib/static-function-middleware.ts` is a base-path-aware copy of TanStack's static server-function middleware,
needed because upstream fetches its cache from the site root.
