import type { TransformResult } from '@astrojs/compiler';
import type { SourceMapInput } from 'rollup';
import type vite from '../core/vite';
import type { AstroConfig } from '../@types/astro';

import esbuild from 'esbuild';
import fs from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import { transform } from '@astrojs/compiler';
import { AstroDevServer } from '../core/dev/index.js';
import { getViteTransform, TransformHook, transformWithVite } from './styles.js';

interface AstroPluginOptions {
  config: AstroConfig;
  devServer?: AstroDevServer;
}

// https://github.com/vitejs/vite/discussions/5109#discussioncomment-1450726
function isSSR(options: undefined | boolean | { ssr: boolean }): boolean {
  if (options === undefined) {
    return false;
  }
  if (typeof options === 'boolean') {
    return options;
  }
  if (typeof options == 'object') {
    return !!options.ssr;
  }
  return false;
}

/** Transform .astro files for Vite */
export default function astro({ config, devServer }: AstroPluginOptions): vite.Plugin {
  let platform: NodeJS.Platform;
  let viteTransform: TransformHook;
  return {
    name: '@astrojs/vite-plugin-astro',
    enforce: 'pre', // run transforms before other plugins can
    configResolved(resolvedConfig) {
      platform = os.platform(); // TODO: remove macOS hack
      viteTransform = getViteTransform(resolvedConfig);
    },
    // note: don’t claim .astro files with resolveId() — it prevents Vite from transpiling the final JS (import.meta.globEager, etc.)
    async load(id, opts) {
      if (!id.endsWith('.astro')) {
        return null;
      }
      // pages and layouts should be transformed as full documents (implicit <head> <body> etc)
      // everything else is treated as a fragment
      const normalizedID = fileURLToPath(new URL(`file://${id}`));
      const isPage = normalizedID.startsWith(fileURLToPath(config.pages)) || normalizedID.startsWith(fileURLToPath(config.layouts));
      let source = await fs.promises.readFile(id, 'utf8');
      let tsResult: TransformResult | undefined;

      try {
        // Transform from `.astro` to valid `.ts`
        // use `sourcemap: "both"` so that sourcemap is included in the code
        // result passed to esbuild, but also available in the catch handler.
        tsResult = await transform(source, {
          as: isPage ? 'document' : 'fragment',
          projectRoot: config.projectRoot.toString(),
          site: config.buildOptions.site,
          sourcefile: id,
          sourcemap: 'both',
          internalURL: 'astro/internal',
          preprocessStyle: async (value: string, attrs: Record<string, string>) => {
            const lang = `.${attrs?.lang || 'css'}`.toLowerCase();
            const result = await transformWithVite({ value, lang, id, transformHook: viteTransform, ssr: isSSR(opts) });
            if (!result) {
              // TODO: compiler supports `null`, but types don't yet
              return result as any;
            }
            let map: SourceMapInput | undefined;
            if (result.map) {
              if (typeof result.map === 'string') {
                map = result.map;
              } else if (result.map.mappings) {
                map = result.map.toString();
              }
            }
            return { code: result.code, map };
          },
        });

        // Compile `.ts` to `.js`
        const { code, map } = await esbuild.transform(tsResult.code, { loader: 'ts', sourcemap: 'external', sourcefile: id });

        return {
          code,
          map,
        };
      } catch (err: any) {
        // improve compiler errors
        if (err.stack.includes('wasm-function')) {
          const search = new URLSearchParams({
            labels: 'compiler',
            title: '🐛 BUG: `@astrojs/compiler` panic',
            body: `### Describe the Bug

\`@astrojs/compiler\` encountered an unrecoverable error when compiling the following file.

**${id.replace(fileURLToPath(config.projectRoot), '')}**
\`\`\`astro
${source}
\`\`\`
`,
          });
          err.url = `https://github.com/withastro/astro/issues/new?${search.toString()}`;
          err.message = `Error: Uh oh, the Astro compiler encountered an unrecoverable error!

Please open
a GitHub issue using the link below:
${err.url}`;
          // TODO: remove stack replacement when compiler throws better errors
          err.stack = `    at ${id}`;
        }

        throw err;
      }
    },
    // async handleHotUpdate(context) {
    //   if (devServer) {
    //     return devServer.handleHotUpdate(context);
    //   }
    // },
  };
}
