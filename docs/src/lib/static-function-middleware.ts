/**
 * Base-path-aware copy of `staticFunctionMiddleware` from @tanstack/start-static-server-functions.
 *
 * Why a copy: upstream fetches the prerendered cache from `/__tsr/staticServerFnCache/...`, a root-absolute
 * URL that ignores Vite's `base`. On GitHub Pages this site lives under `/agent-hypervisor/`, so the files are
 * at `/agent-hypervisor/__tsr/...` and client-side navigation 404s. The only change here is prefixing the
 * client fetch with `import.meta.env.BASE_URL`; the cache files are still written to the output root, which is
 * served at the base. Drop this file when upstream honours the base path.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createMiddleware,
  defaultSerovalDeserializerPlugins,
  getDefaultSerovalPlugins,
  getSerovalPlugins,
} from '@tanstack/start-client-core';
import { fromJSON, toJSONAsync } from 'seroval';

async function sha1Hash(message: string) {
  const hashBuffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(message));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Path of the cache file, relative to the output root (same naming as upstream). */
async function cachePath(functionId: string, data: unknown) {
  return `__tsr/staticServerFnCache/${await sha1Hash(`${functionId}__${filenameSafe(data)}`)}.json`;
}

function filenameSafe(json: unknown) {
  const sortedKeys = (_key: string, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = (value as Record<string, unknown>)[k];
            return acc;
          }, {})
      : value;
  return JSON.stringify(json ?? '', sortedKeys)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '_');
}

export const staticFunctionMiddleware = createMiddleware({ type: 'function' })
  .client(async (ctx) => {
    if (process.env.NODE_ENV === 'production' && typeof document !== 'undefined') {
      const url = import.meta.env.BASE_URL + (await cachePath(ctx.serverFnMeta.id, ctx.data));
      const response = await fetch(url)
        .then((r) => r.json())
        .then((d) => fromJSON(d, { plugins: getSerovalPlugins(defaultSerovalDeserializerPlugins) }) as {
          result: unknown;
          context: Record<string, unknown>;
        });
      if (response) return { result: response.result, context: { ...(ctx.context as unknown as object), ...response.context } } as never;
    }
    return ctx.next();
  })
  .server(async (ctx) => {
    const response = await ctx.next();
    const outDir = process.env.TSS_CLIENT_OUTPUT_DIR;
    if (process.env.NODE_ENV === 'production' && outDir) {
      const filePath = path.join(outDir, await cachePath(ctx.serverFnMeta.id, ctx.data));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const serialized = JSON.stringify(
        await toJSONAsync(
          { result: (response as unknown as { result: unknown }).result, context: (ctx as { sendContext?: unknown }).sendContext },
          { plugins: getDefaultSerovalPlugins() },
        ),
      );
      await fs.writeFile(filePath, serialized, 'utf-8');
    }
    return response;
  });
