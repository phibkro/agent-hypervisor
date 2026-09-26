/**
 * Build-time artifacts for the docs site, generated from the sources of truth:
 *
 *   domain/agent-hypervisor.cml  --Context Mapper-->  context map SVG + PlantUML --PlantUML--> SVG
 *   spec/capabilities.als        --Alloy---------->  check results + counterexample traces
 *
 * Outputs (both gitignored):
 *   public/generated/domain/*.svg   served as static files
 *   src/generated/domain.json       diagram manifest, read by <ContextMap/>, <Aggregate/>, ...
 *   src/generated/alloy.json        results table and traces, read by <AlloyResults/>, <AlloyTrace/>
 *
 * A model that fails `cm validate` fails the build. Requires Java 17+ and Graphviz (`dot`).
 * Usage: bun scripts/artifacts.ts [--skip-alloy]
 */
import { $ } from 'bun';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verticalLayout } from './puml-layout';

const docs = resolve(import.meta.dir, '..');
const repo = resolve(docs, '..');
const cml = join(repo, 'domain', 'agent-hypervisor.cml');
const als = join(repo, 'spec', 'capabilities.als');
const traceScript = join(repo, 'spec', 'trace.py');

const tools = join(docs, '.cache', 'tools');
const work = join(docs, '.cache', 'work');
const svgOut = join(docs, 'public', 'generated', 'domain');
const jsonOut = join(docs, 'src', 'generated');

/* Pinned tool versions (official distributions). */
const CM_VERSION = '6.12.0';
const PLANTUML_VERSION = '1.2026.8';
const ALLOY_VERSION = '6.2.0';

const skipAlloy = process.argv.includes('--skip-alloy');

async function download(url: string, dest: string) {
  if (existsSync(dest)) return;
  console.log(`[artifacts] downloading ${url}`);
  // curl rather than fetch: it honours proxy settings and CA bundles the same way everywhere.
  await $`curl -fsSL --retry 3 -o ${dest}.part ${url}`;
  await $`mv ${dest}.part ${dest}`;
}

async function ensureTools() {
  mkdirSync(tools, { recursive: true });
  const cmDir = join(tools, `context-mapper-cli-${CM_VERSION}`);
  if (!existsSync(cmDir)) {
    const tar = join(tools, 'cm.tar');
    await download(
      `https://repo1.maven.org/maven2/org/contextmapper/context-mapper-cli/${CM_VERSION}/context-mapper-cli-${CM_VERSION}.tar`,
      tar,
    );
    await $`tar xf ${tar} -C ${tools}`.quiet();
    rmSync(tar);
  }
  const plantuml = join(tools, `plantuml-${PLANTUML_VERSION}.jar`);
  await download(
    `https://repo1.maven.org/maven2/net/sourceforge/plantuml/plantuml/${PLANTUML_VERSION}/plantuml-${PLANTUML_VERSION}.jar`,
    plantuml,
  );
  const alloy = join(tools, `alloy-${ALLOY_VERSION}.jar`);
  await download(
    `https://github.com/AlloyTools/org.alloytools.alloy/releases/download/v${ALLOY_VERSION}/org.alloytools.alloy.dist.jar`,
    alloy,
  );
  return { cm: join(cmDir, 'bin', 'cm'), plantuml, alloy };
}

/* ------------------------------------------------------------------ Context Mapper */

export type DiagramKind = 'context-map' | 'context-map-components' | 'bounded-context' | 'aggregate' | 'lifecycle' | 'subdomain' | 'use-cases';

export interface Diagram {
  file: string;
  /** Dark-theme variant, relative to the same directory. */
  dark?: string;
  /** Natural width in CSS pixels, so the page can keep small text legible on narrow screens. */
  width?: number;
  kind: DiagramKind;
  context?: string;
  name: string;
}

/** Width of an SVG in CSS pixels (PlantUML writes px, Graphviz pt). */
function svgWidth(file: string): number | undefined {
  const m = /<svg[^>]*?\swidth="([\d.]+)(px|pt)?"/.exec(readFileSync(file, 'utf8'));
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (m[2] === 'pt' ? 4 / 3 : 1));
}

/** Context Mapper names its outputs <model>_<part>.puml; turn that into something addressable. */
function classify(stem: string, ext: string): Diagram | null {
  const part = stem.replace(/^agent-hypervisor_/, '');
  const file = `${stem}.${ext}`;
  if (part === 'ContextMap') return ext === 'svg' && !stem.endsWith('_puml')
    ? { file, kind: 'context-map', name: 'ContextMap' }
    : null;
  if (part === 'ContextMap_puml') return { file, kind: 'context-map-components', name: 'ContextMap' };
  if (part === 'UseCases') return { file, kind: 'use-cases', name: 'UseCases' };
  let m = /^SD_(\w+)$/.exec(part);
  if (m) return { file, kind: 'subdomain', name: m[1]! };
  m = /^BC_([A-Za-z0-9]+)_([A-Za-z0-9]+)_StateDiagram$/.exec(part);
  if (m) return { file, kind: 'lifecycle', context: m[1], name: m[2]! };
  m = /^BC_([A-Za-z0-9]+)_([A-Za-z0-9]+)$/.exec(part);
  if (m) return { file, kind: 'aggregate', context: m[1], name: m[2]! };
  m = /^BC_([A-Za-z0-9]+)$/.exec(part);
  if (m) return { file, kind: 'bounded-context', context: m[1], name: m[1]! };
  return null;
}

async function contextMapper(t: { cm: string; plantuml: string }) {
  const out = join(work, 'cml');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const validation = await $`${t.cm} validate -i ${cml}`.nothrow().quiet();
  const text = validation.stdout.toString() + validation.stderr.toString();
  if (validation.exitCode !== 0 || /ERROR/.test(text)) {
    throw new Error(`Context Mapper validation failed:\n${text}`);
  }
  await $`${t.cm} generate -i ${cml} -g context-map -o ${out}`.quiet();
  await $`${t.cm} generate -i ${cml} -g plantuml -o ${out}`.quiet();

  // PlantUML sources become SVGs twice: light into svgOut, dark (PlantUML's --dark-mode) into svgOut/dark.
  // Re-flowed top to bottom for narrow screens first (see puml-layout.ts); the originals stay in `out`.
  const laidOut = join(out, 'vertical');
  mkdirSync(laidOut, { recursive: true });
  const pumls = readdirSync(out)
    .filter((f) => f.endsWith('.puml'))
    .map((f) => {
      const target = join(laidOut, f);
      writeFileSync(target, verticalLayout(readFileSync(join(out, f), 'utf8')));
      return target;
    });
  const darkOut = join(svgOut, 'dark');
  mkdirSync(darkOut, { recursive: true });
  await $`java -jar ${t.plantuml} -tsvg -charset UTF-8 -o ${svgOut} ${pumls}`.quiet();
  await $`java -jar ${t.plantuml} -tsvg -charset UTF-8 --dark-mode -o ${darkOut} ${pumls}`.quiet();

  // The PlantUML version of the context map would collide with the graphical one.
  for (const dir of [svgOut, darkOut]) {
    const cmPuml = join(dir, 'agent-hypervisor_ContextMap.svg');
    if (existsSync(cmPuml)) renameSync(cmPuml, join(dir, 'agent-hypervisor_ContextMap_puml.svg'));
  }
  // The graphical context map is a Graphviz graph without colours of its own, so both variants
  // come from the same .gv with Graphviz defaults set per theme (same layout in both).
  let gv = readFileSync(join(out, 'agent-hypervisor_ContextMap.gv'), 'utf8');
  // Layout hint for narrow screens: rank Secrets above AgentWork, so the map reads as one column
  // (Authority, then Isolation and Secrets, then AgentWork) instead of three contexts side by side.
  if (gv.includes('"Secrets"') && gv.includes('"AgentWork"')) {
    gv = gv.replace(/\}\s*$/, '"Secrets" -> "AgentWork" ["style"="invis"]\n}\n');
  }
  const cmName = 'agent-hypervisor_ContextMap.svg';
  await $`dot -Tsvg -o ${join(svgOut, cmName)} < ${new Response(gv)}`.quiet();
  const fg = '#E5E5E5';
  const bg = '#1B1B1B'; // PlantUML's --dark-mode background
  const darkGv = gv.replaceAll('bgcolor="white"', `bgcolor="${bg}"`).replaceAll('<table ', `<table color="${fg}" `);
  await $`dot -Tsvg -Gbgcolor=${bg} -Ncolor=${fg} -Nfontcolor=${fg} -Ecolor=${fg} -Efontcolor=${fg} -o ${join(darkOut, cmName)} < ${new Response(darkGv)}`.quiet();

  const diagrams = readdirSync(svgOut)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => classify(f.replace(/\.svg$/, ''), 'svg'))
    .filter((d): d is Diagram => d !== null)
    .map((d) => ({
      ...d,
      width: svgWidth(join(svgOut, d.file)),
      ...(existsSync(join(darkOut, d.file)) ? { dark: `dark/${d.file}` } : {}),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return diagrams;
}

/* ------------------------------------------------------------------ Alloy */

export interface AlloyResult {
  index: number;
  kind: 'check' | 'run';
  name: string;
  scope: string;
  outcome: 'holds' | 'counterexample' | 'instance' | 'no instance';
  expected: boolean;
  doc: string;
  trace?: string;
}

/** The comment block right above `assert Name` (or `run Name`), as plain text. */
function docFor(source: string, name: string): string {
  // The comment must not contain `*/`, so it is the one directly above.
  const re = new RegExp(`/\\*((?:(?!\\*/)[^])*)\\*/\\s*(?:assert|run)\\s+${name}\\b`);
  const m = re.exec(source);
  if (!m) return '';
  return m[1]!.split('\n').map((l) => l.replace(/^\s*\*?\s?/, '')).join(' ').replace(/\s+/g, ' ').trim();
}

async function alloyChecks(t: { alloy: string }): Promise<AlloyResult[]> {
  const source = readFileSync(als, 'utf8');
  const listing = (await $`java -jar ${t.alloy} commands ${als}`.quiet()).stdout.toString();
  const commands = [...listing.matchAll(/^(\d+)\s*\.\s*(Check|Run)\s+(\w+)\s+(for .+)$/gm)].map((m) => ({
    index: Number(m[1]),
    kind: m[2]!.toLowerCase() as 'check' | 'run',
    name: m[3]!,
    scope: m[4]!.trim(),
  }));
  // CI runs the base scope; larger scopes are for local, longer runs.
  const base = commands[0]?.scope;
  const selected = commands.filter((c) => c.scope === base);

  const results: AlloyResult[] = [];
  for (const c of selected) {
    const out = join(work, 'alloy', String(c.index));
    rmSync(out, { recursive: true, force: true });
    const run = await $`java -jar ${t.alloy} exec -f -c ${c.index} -t xml -o ${out} ${als}`.nothrow().quiet();
    // Alloy writes its result lines to stderr.
    const line = (run.stdout.toString() + run.stderr.toString()).split('\n').find((l) => /^\d+\.\s+(check|run)\b/.test(l)) ?? '';
    const sat = /\bSAT\b/.test(line) && !/\bUNSAT\b/.test(line);
    if (!line) throw new Error(`Alloy produced no result for ${c.name}:\n${run.stderr.toString()}`);
    const expectedCounterexample = new RegExp(`check\\s+${c.name}\\s+for[^\\n]*--\\s*expected:\\s*counterexample`).test(source);
    const outcome: AlloyResult['outcome'] = c.kind === 'check' ? (sat ? 'counterexample' : 'holds') : sat ? 'instance' : 'no instance';
    const expected = c.kind === 'check' ? sat === expectedCounterexample : sat;
    let trace: string | undefined;
    if (sat) {
      const xml = readdirSync(out).find((f) => f.endsWith('.xml'));
      if (xml) trace = (await $`python3 ${traceScript} ${join(out, xml)}`.quiet()).stdout.toString();
    }
    results.push({ ...c, outcome, expected, doc: docFor(source, c.name), trace });
    console.log(`[artifacts] alloy ${c.kind} ${c.name}: ${outcome}${expected ? '' : ' (UNEXPECTED)'}`);
  }
  return results;
}

/* ------------------------------------------------------------------ main */

async function main() {
  rmSync(svgOut, { recursive: true, force: true });
  mkdirSync(svgOut, { recursive: true });
  mkdirSync(jsonOut, { recursive: true });
  mkdirSync(work, { recursive: true });

  const t = await ensureTools();
  const diagrams = await contextMapper(t);
  writeFileSync(join(jsonOut, 'domain.json'), JSON.stringify({ model: 'domain/agent-hypervisor.cml', diagrams }, null, 2));
  console.log(`[artifacts] context mapper: ${diagrams.length} diagrams`);

  const alloyPath = join(jsonOut, 'alloy.json');
  if (skipAlloy && existsSync(alloyPath)) {
    console.log('[artifacts] alloy skipped (keeping previous results)');
  } else if (skipAlloy) {
    writeFileSync(alloyPath, JSON.stringify({ model: 'spec/capabilities.als', skipped: true, results: [] }, null, 2));
  } else {
    const results = await alloyChecks(t);
    writeFileSync(alloyPath, JSON.stringify({ model: 'spec/capabilities.als', skipped: false, results }, null, 2));
    const unexpected = results.filter((r) => !r.expected);
    if (unexpected.length > 0) {
      throw new Error(`Alloy: unexpected outcome for ${unexpected.map((r) => r.name).join(', ')}`);
    }
  }
}

await main();
