import { defineConfig } from 'tsup';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  // Stamped into the indexer client's `x-client-info` header. Injected here rather
  // than written as a literal in source, which drifted from package.json the first
  // time a release bumped one and not the other.
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
  entry: {
    index: 'src/index.ts',
    'abi/index': 'src/abi/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  external: [
    'quais',
    '@supabase/postgrest-js',
    '@supabase/realtime-js',
    'zod',
    'node:worker_threads',
  ],
});
