import { llms, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { defineDocs } from 'fumadocs-mdx/macro';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins/rehype-code';
import { cmlGrammar } from './cml-grammar';
import { docsRoute } from './shared';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    async: true,
    // applyMdxPreset keeps Fumadocs' default plugins; we add Mermaid fences and CML highlighting.
    mdxOptions: applyMdxPreset({
      remarkPlugins: (v) => [remarkMdxMermaid, ...v],
      rehypeCodeOptions: {
        ...rehypeCodeDefaultOptions,
        langs: [...(rehypeCodeDefaultOptions.langs ?? []), cmlGrammar as never],
      },
    }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: docsRoute,
  plugins: [lucideIconsPlugin()],
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText('processed')}`,
});
