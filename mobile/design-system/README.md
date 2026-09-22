# cityroam-design-system

A web-buildable package that re-exports `mobile/`'s real UI component source
(`src/components/ui/*`, `Themed.tsx`, `lib/theme.tsx`, `constants/Colors.ts`)
so it can build with `tsup` into a browser-renderable ESM bundle. Nothing here
reimplements a component — see `src/index.ts` for the re-export list.

Built for a later `/design-sync` run (syncing this component library into
Claude Design). This package on its own only builds and smoke-tests; running
`/design-sync` against it is a separate step.

## Why this exists

`mobile/` is the Expo app itself: React Native components, no web target, no
build step. Claude Design renders in a real browser (no RN runtime), so this
package swaps out the handful of native-only leaf dependencies for web shims
(`src/web-shims/`) via `tsup.config.ts`'s esbuild `alias` map, and bundles
everything else (`react-native-web`, `react-native-svg`,
`react-native-safe-area-context`, `lucide-react-native`,
`@react-native-async-storage/async-storage`) into a self-contained
`dist/index.mjs`.

## Web shims (`src/web-shims/`)

| Shim | Replaces | Why |
|---|---|---|
| `BlurView.tsx` | `expo-blur` | No react-native-web build exists; approximates with CSS `backdrop-filter`. |
| `LinearGradient.tsx` | `expo-linear-gradient` | Same — no web build; renders a CSS `linear-gradient` background instead. |
| `Slider.tsx` | `@react-native-community/slider` | No reliable web build; wraps a plain `<input type="range">`. |
| `reanimated.tsx` | `react-native-reanimated` | Reanimated's web runtime needs its Babel worklet plugin, which a plain esbuild pass doesn't run — crashed inside `_updatePropsJS` at build/runtime otherwise. Implements the small hook surface actually used (`useSharedValue`, `useAnimatedStyle`, `useAnimatedProps`, `withTiming`, `withSequence`, `withDelay`, `withRepeat`, `Easing`, `useReducedMotion`, `Animated.createAnimatedComponent`) as a `requestAnimationFrame` tween engine that re-renders on the JS thread — fine for the brief press/pulse/reveal feedback these components use it for. |
| `react-native.ts` | `react-native` → `react-native-web` | Adds RN core's `useAnimatedValue` hook, which react-native-web doesn't export. |

## Known build quirks (for the next person / next `tsup.config.ts` edit)

- `react-native-svg` and `react-native-safe-area-context` ship `.web.js`
  platform variants that Metro resolves automatically; esbuild needs
  `resolveExtensions` to check `.web.*` first (`tsup.config.ts`'s
  `esbuildOptions.resolveExtensions`), or it tries to resolve their native
  Fabric codegen files and fails.
- `tsup` skips bundling anything in `package.json` `dependencies` by default
  (`skipNodeModulesBundle`) — the RN-web packages above are pulled in via
  `noExternal` so `dist/index.mjs` is actually self-contained.
- Browser globals RN library code assumes exist (`process`, `process.env.*`,
  `__DEV__`, `global`) are supplied via `tsup.config.ts`'s `define` map — a
  real browser has none of them.

## Fonts

`fonts/` holds the actual `.ttf` files (copied from `mobile/assets/fonts/` and
`node_modules/@expo-google-fonts/*`) plus `fonts.css` with matching
`@font-face` rules, named exactly as `src/lib/theme.tsx` expects.

## Smoke test

`smoke/` is a minimal manual check (not the full `/design-sync` render-check):
bundles `smoke/main.tsx` (imports a few components from `dist/index.mjs`,
wraps them in `ThemeProvider`) and screenshots it via Playwright.

```sh
npm run build
npx esbuild smoke/main.tsx --bundle --format=esm --platform=browser --outfile=smoke/main.bundle.js --jsx=automatic \
  --resolve-extensions=.web.tsx,.web.ts,.web.jsx,.web.js,.tsx,.ts,.jsx,.js,.mjs,.json \
  --define:process='{"env":{"NODE_ENV":"production"},"browser":true}' \
  --define:__DEV__=false \
  --define:global=globalThis
node smoke/screenshot.mjs   # writes smoke/screenshot.png
```
