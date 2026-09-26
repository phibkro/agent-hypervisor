/**
 * Re-flows Context Mapper's PlantUML so diagrams read top to bottom, one section under the next, and stay
 * narrow enough for a phone.
 *
 * Context Mapper puts every class of a package on the same rank (one wide row) and packages side by side.
 * Hidden edges change only the layout, never the content:
 *
 *   - class diagrams: the members of each package form a grid of `columns` columns, and every package sits
 *     below the previous one (each member of a package points at the first row of the next);
 *   - state diagrams: a state's targets are spread over rows of `columns`, and separate machines (several
 *     transitions out of [*]) are stacked instead of placed side by side;
 *   - the component context map: notes go under their component, and relationship labels use the usual
 *     DDD abbreviations (OHS, PL) that the graphical context map uses too;
 *   - legends are wrapped so a long sentence does not set the width of the whole diagram.
 *
 * Class and state diagrams are laid out with Smetana (see `smetana` below).
 */

const memberRe = /^\s*(?:class|enum|interface|abstract class)\s+("?)([\w.]+)\1/;
const packageRe = /^\s*package\s+.*\{\s*$/;

/** An invisible downward edge; `gap` is the minimum number of ranks between the two ends. */
const hidden = (from: string, to: string, gap = 1) => `${from} -[hidden]${'-'.repeat(gap)}> ${to}`;

/** Groups of member names: one per top-level package, plus one for members outside any package. */
function memberGroups(lines: string[]): string[][] {
  const groups: string[][] = [];
  const loose: string[] = [];
  const stack: ('package' | 'body' | 'other')[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (packageRe.test(line)) {
      if (!stack.includes('package')) groups.push((current = []));
      stack.push('package');
      continue;
    }
    const m = memberRe.exec(line);
    if (m && !stack.includes('body')) (current ?? loose).push(m[2]!);
    if (line.trimEnd().endsWith('{')) stack.push(m ? 'body' : 'other');
    else if (/^\s*\}\s*$/.test(line)) {
      stack.pop();
      if (!stack.includes('package')) current = null;
    }
  }
  return [loose, ...groups].filter((g) => g.length > 0);
}

function classGrid(src: string, columns: number): string[] {
  const extra: string[] = [];
  let previous: string[] = [];
  for (const group of memberGroups(src.split('\n'))) {
    for (let i = 0; i + columns < group.length; i++) extra.push(hidden(group[i]!, group[i + columns]!));
    for (const p of previous) extra.push(hidden(p, group[0]!, 2));
    previous = group;
  }
  return extra;
}

function stateRows(src: string, columns: number): string[] {
  const targets = new Map<string, string[]>();
  for (const m of src.matchAll(/^(\S+)\s+-->\s+(\S+)/gm)) {
    const list = targets.get(m[1]!) ?? [];
    if (!list.includes(m[2]!)) list.push(m[2]!);
    targets.set(m[1]!, list);
  }
  const extra: string[] = [];
  for (const [from, list] of targets) {
    if (from === '[*]') continue;
    for (let i = 0; i + columns < list.length; i++) extra.push(hidden(list[i]!, list[i + columns]!));
  }
  // Stack separate machines: everything reachable from one root goes above the next root.
  const reachable = (root: string) => {
    const seen = new Set<string>([root]);
    const todo = [root];
    while (todo.length) for (const t of targets.get(todo.pop()!) ?? []) if (!seen.has(t) && t !== '[*]') seen.add(t), todo.push(t);
    return seen;
  };
  const roots = targets.get('[*]') ?? [];
  for (let i = 0; i + 1 < roots.length; i++) {
    const leaves = [...reachable(roots[i]!)].filter((s) => !(targets.get(s)?.length));
    for (const leaf of leaves) extra.push(hidden(leaf, roots[i + 1]!));
  }
  return extra;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) out.push(line), (line = '');
    line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  // A line starting with ' is a comment in PlantUML: pull that word up onto the line before.
  for (let i = 1; i < out.length; i++) {
    if (!out[i]!.startsWith("'")) continue;
    const [word, ...rest] = out[i]!.split(' ');
    out[i - 1] += ` ${word}`;
    out[i] = rest.join(' ');
  }
  return out.filter((l) => l.length > 0);
}

/** Wraps long legend lines, keeping their indentation and list markers. */
function wrapLegends(src: string, width: number): string {
  let inLegend = false;
  return src
    .split('\n')
    .flatMap((line) => {
      if (/^\s*legend\b/.test(line)) inLegend = true;
      else if (/^\s*end ?legend\b/.test(line)) inLegend = false;
      else if (inLegend && line.trim().length > width) {
        const indent = /^\s*/.exec(line)![0];
        return wrap(line.trim(), width).map((l, i) => (i === 0 ? indent + l : `${indent}  ${l}`));
      }
      return [line];
    })
    .join('\n');
}

/**
 * Smetana (PlantUML's built-in Java port of Graphviz dot) keeps stacked packages in one column where dot
 * staggers them to the right, and comes out narrower for every class and state diagram here. The component
 * context map stays on dot: Smetana overlaps its interface labels.
 */
function smetana(src: string): string {
  return src.replace(/^@startuml\s*$/m, '@startuml\n!pragma layout smetana');
}

function withHints(src: string, extra: string[]): string {
  if (extra.length === 0) return src;
  return src.replace(/@enduml\s*$/, `' layout hints added by docs/scripts/puml-layout.ts\n${extra.join('\n')}\n@enduml\n`);
}

export function verticalLayout(src: string, columns = 2): string {
  let out = wrapLegends(src, 48);
  if (/^\s*note right of /m.test(out)) {
    // The component view of the context map.
    return out
      .replace(/^(\s*)note right of /gm, '$1note bottom of ')
      .replaceAll('OPEN_HOST_SERVICE', 'OHS')
      .replaceAll('PUBLISHED_LANGUAGE', 'PL')
      .replaceAll('ANTICORRUPTION_LAYER', 'ACL')
      .replaceAll('CONFORMIST', 'CF');
  }
  if (/^\s*\[\*\]\s+-->/m.test(out)) return smetana(withHints(out, stateRows(out, columns)));
  if (out.split('\n').some((l) => memberRe.test(l))) return smetana(withHints(out, classGrid(out, columns)));
  return out;
}
