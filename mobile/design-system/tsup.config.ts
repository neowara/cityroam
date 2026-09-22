import { defineConfig } from 'tsup';
import path from 'node:path';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'browser',
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: false,
  define: {
    // A plain --define:process.env.NODE_ENV only catches that exact expression;
    // some bundled libs read other process.env.* keys or `process` itself, which
    // throws ReferenceError in a real browser (no Node process global) otherwise.
    process: JSON.stringify({ env: { NODE_ENV: 'production' }, browser: true }),
    __DEV__: 'false',
    global: 'globalThis',
  },
  external: ['react', 'react-dom'],
  // tsup skips bundling node_modules by default — these need to be inlined so
  // dist/index.mjs is self-contained (their .web.js variants need our
  // resolveExtensions/alias config below, which a downstream consumer won't have).
  noExternal: ['react-native-web', 'react-native-svg', 'lucide-react-native', 'react-native-reanimated', 'react-native-safe-area-context'],
  esbuildOptions(options) {
    // react-native-svg / react-native-safe-area-context ship .web.js platform
    // variants that Metro resolves automatically; esbuild needs this spelled out.
    options.resolveExtensions = ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'];
    options.alias = {
      ...options.alias,
      'react-native': path.resolve(__dirname, 'src/web-shims/react-native.ts'),
      'expo-blur': path.resolve(__dirname, 'src/web-shims/BlurView.tsx'),
      'expo-linear-gradient': path.resolve(__dirname, 'src/web-shims/LinearGradient.tsx'),
      '@react-native-community/slider': path.resolve(__dirname, 'src/web-shims/Slider.tsx'),
      'react-native-reanimated': path.resolve(__dirname, 'src/web-shims/reanimated.tsx'),
      '@react-native-async-storage/async-storage': path.resolve(__dirname, 'src/web-shims/async-storage.ts'),
    };
  },
});
