# Re-sync notes

## Two real bugs fixed in `mobile/design-system` itself (not `.ds-sync/`) — permanent, no reapplying needed

**1. Duplicated npm package instances broke React Context (`useSafeAreaInsets` threw
"No safe area value available" for every component that used it — ScreenHeader,
FloatingBackHeader, StatusBarScrim, GlassBackdrop, FloatingTabBar).** Root cause:
`mobile/design-system/src/index.ts` re-exports source that lives OUTSIDE the package
(`../../src/components/ui/*.tsx`, in `mobile/src/`). Node/esbuild module resolution
walks up from the *importing file's own directory* — so `ScreenHeader.tsx` (physically
in `mobile/src/components/ui/`) resolved `'react-native-safe-area-context'` from
`mobile/node_modules`, while `design-system/src/index.ts`'s own
`export { SafeAreaProvider } from '...'` resolved the SAME package name from
`design-system/node_modules` (a separate copy, since it was listed as its own
dependency there). Two physically different copies of the module = two different
`React.createContext()` objects = a `SafeAreaProvider` from one is invisible to a
`useSafeAreaInsets()` consumer reading the other. Confirmed by diffing `realpath` of
both installs, and by reproducing/fixing it outside the design-sync harness entirely
(a minimal two-script Playwright page, no `.ds-sync/` involved).

**Fix**: removed `react-native-safe-area-context`, `react-native-svg`,
`lucide-react-native`, `@react-native-async-storage/async-storage`, and the (unused —
fully aliased away) `react-native-reanimated` from `design-system/package.json`'s own
`dependencies`. All of them are real `mobile/package.json` dependencies already:
removing the local copies makes every resolution — from files in `mobile/src/` *and*
from `design-system/src/index.ts` — land on the exact same `mobile/node_modules` copy.
Kept `react-native-web` as a real dependency (mobile/src never imports it, no
duplication risk). **If any future component pulled in via `src/index.ts` needs a new
RN-ecosystem package with React Context, add it to `mobile/package.json`, not
`design-system/package.json`** — the design-system package now deliberately relies on
being a subdirectory of `mobile/` for this class of dependency.

**2. `@react-native-async-storage/async-storage` real web build backs onto
`window.localStorage`, which persists across every navigation to the same origin —
so one preview cell's `ThemeProvider` state (accent/font/`containerStyle`) leaked into
a totally unrelated cell that never touched it.** Confirmed concretely: a
`GlassBackdrop` "Matte" cell (which never calls `setContainerStyle`) rendered in full
glass mode, because an earlier "Glass" cell on the same page had already persisted
`containerStyle: 'glass'` to `localStorage`, and the "Matte" cell's own fresh
`ThemeProvider` read that persisted value back on mount.

**Fix**: added `src/web-shims/async-storage.ts` (in-memory `Map`-backed, no real
persistence — cleared on every page load) and aliased
`@react-native-async-storage/async-storage` to it in `tsup.config.ts`, same pattern as
the other web shims. Every preview cell's `ThemeProvider` now reliably starts at the
real `DEFAULT_APPEARANCE` regardless of what any other cell/component did earlier in
the same browser session.

**3. `SafeAreaProvider` re-export added.** `src/index.ts` now also
`export { SafeAreaProvider } from 'react-native-safe-area-context'`
(free — already inlined into `dist/` via `tsup.config.ts`'s `noExternal`), and
`.design-sync/config.json`'s `provider` chain wraps it around `ThemeProvider` with a
fixed `initialMetrics` (`{top:47,bottom:34,left:0,right:0}`, simulating a real
notch/home-indicator device) so every component that calls `useSafeAreaInsets()`
internally has a value to read. `componentSrcMap` excludes `SafeAreaProvider` from the
component list (`null`) since it's plumbing, not a browsable UI component.

## Known render warns (triaged as legitimate)

- **`AppModal`, `ConfirmModalBody`, `ChecklistModalBody`, `ModeSelectModal`** —
  `[RENDER_THIN]` "DOM content present but rendered height is 0px". These use
  `cfg.overrides.<Name>: {cardMode: "single", viewport: "420x640"}` because
  they're RN `Modal`-portal components (fixed-position full-viewport overlay
  under `react-native-web`). The height-measurement heuristic reads the
  mount-cell wrapper's own height (0, since the real content is portalled
  elsewhere in the DOM), not the portal content. Screenshots confirm correct
  rendering (dialog card, backdrop, icon, buttons all present and styled).
  Non-blocking; expected to keep warning on every re-sync.

## `AppModal`-family previews need an in-flow spacer

`AppModal` renders react-native-web's `Modal` (`position: fixed`). The
`cardMode: "single"` review wrapper (`.ds-single { transform: translateZ(0) }`)
becomes the CSS containing block for fixed descendants (transform on an
ancestor does that per spec); with no other in-flow content, the wrapper
collapses to 0 height, collapsing the fixed modal along with it —
`package-capture.mjs`'s per-story screenshot (`page.screenshot({fullPage:
false})`, clipped to the viewport) then captures nothing, even though
`package-validate.mjs`'s `fullPage: true` screenshot looks fine (it captures
the whole document regardless of any element's box). Every preview using
`AppModal`, `ConfirmModalBody`, `ChecklistModalBody`, or `ModeSelectModal`
needs a same-size invisible in-flow spacer alongside the modal (see the
`Spacer` component in `AppModal.tsx`/`ConfirmModalBody.tsx`) — don't drop it
when authoring `ChecklistModalBody.tsx` / `ModeSelectModal.tsx` later.

## Fixed a real capture bug (`.ds-sync/package-capture.mjs`)

`package-capture.mjs` froze the page clock
(`page.clock.setFixedTime(new Date('2024-05-15...'))`) for "deterministic"
screenshots — but that also freezes whatever `Date.now()`/`performance.now()`
reads an animation driver takes internally, so any JS-timer/rAF-driven mount
animation (RN's `Animated.timing`/`.spring` under react-native-web) computes
zero elapsed time forever and never advances past its INITIAL (often
invisible) state. `AppModal`'s fade/scale entrance (`Animated.timing(progress,
{toValue:1, duration:200, useNativeDriver:true})` in a mount `useEffect`)
animates in exactly that way — every per-story capture came back permanently
blank with the clock frozen, and rendered correctly instantly once it wasn't
(confirmed directly: same navigation, same everything, only the
`setFixedTime` call differed). `page.clock.runFor(...)` does NOT fix this —
`setFixedTime` alone doesn't install the fake-timer queue `runFor` advances
(that needs `page.clock.install()`), so `runFor` silently no-ops after
`setFixedTime`.

**Fix applied**: removed the `page.clock.setFixedTime(...)` call entirely (no
replacement) — nothing in this DS depends on a fixed "now" for rendering, and
real wall-clock time works correctly for every component tested. Also added
a flat `page.waitForTimeout(400)` after `settle()` in the per-story
screenshot loop, as a real-time margin for mount animations to finish
(`settle()` itself only waits on fonts/images, not animations).

**Needs reapplying on every re-sync** (same reason as the
`package-validate.mjs` fix below — `.ds-sync/` is gitignored and restaged
fresh each run): in a freshly-restaged `.ds-sync/package-capture.mjs`, delete
the `page.clock.setFixedTime(...)` line near the top (search
`page.clock.setFixedTime`) and add `await page.waitForTimeout(400);` right
after `await settle();` in the per-cell screenshot loop.

## Fixed a real render-check bug (`.ds-sync/package-validate.mjs`)

`document.querySelectorAll('#root, [id^="r"]')` (the render-check's root
detection) also matches `react-native-web`'s injected
`<style id="react-native-stylesheet">` tag in `<head>` — which sorts first in
DOM order and has empty `innerHTML` (RNW fills it via CSSOM `insertRule`, not
text), so `roots[0]` was that style tag, not the actual mount div. This
produced a false `[RENDER] root empty` for every component whose *first*
preview export mounted successfully into `#r0` (StatTile, SegmentedControl,
CityroamMark, CityroamWordmark all hit this before the fix).

**Fix applied**: scoped the selector to `document.body.querySelectorAll(...)`
instead of `document.querySelectorAll(...)` — the style tag lives in `<head>`,
so this excludes it without changing which body-level mounts count as roots.

**This will need reapplying on every re-sync** — `.ds-sync/` is gitignored
and restaged fresh from the skill's bundled scripts each run (`cp -r ...`).
The upstream `package-validate.mjs` selector at
`.ds-sync/package-validate.mjs` (search `document.querySelectorAll('#root,`)
needs the same one-line `document.body.querySelectorAll(...)` change before
running validate — otherwise every react-native-web-based DS synced with this
skill will see spurious `[RENDER] root empty` failures on its first-exported
story per component.

- `SegmentedControl`'s highlight pill (`thumbX`) always animates in from
  index 0 on mount (`useAnimatedValue(0)` + a spring in `useEffect`), even
  when `value` starts elsewhere — a static capture of a demo whose initial
  `value` isn't the first option catches it mid-spring, showing the pill
  under the wrong option. Previews pick demo `value`s that start at index 0
  to avoid this; don't "fix" it by picking a later index again.

- `MarqueeText`'s whole point (single-line clip + horizontal marquee scroll) can't be
  demonstrated in a static screenshot — the capture is one frame, and without a running
  animation the underlying text wraps across lines instead of clipping to one. Graded
  `good` anyway (tokens/fonts/layout are correct and complete) — a static-capture
  limitation of the component, not a preview bug. Revisit if an animated capture path
  ever exists.
- `NumberFieldRow`/`SliderRow`/`EnumFieldRow` all take a `rawDps`/`drafts`/`schema` (or
  `range`/`value`/`draft`) shape from the app's real device-settings data-point system.
  `BoardDpSchema` isn't exported by the package and the component `.d.ts` files
  reference it without importing it — effectively untyped/ambient at the preview layer.
  Previews just use plain object literals shaped like it; esbuild strips types without
  checking them, so this compiles fine.
- Mode keys/colors (`ModeText`/`ModeChip`): `eco`/`ride`/`speed`/`turbo`, confirmed
  against `mobile/src/lib/mode.ts` (`#22a55a`/`#2f95dc`/`#f5793a`/`#e5484d`) — components
  resolve their own color internally from the mode key, no need to hardcode hex in a
  preview.
- `WeatherBadge`'s `weatherCodes` are real WMO codes from `mobile/src/lib/weather.ts`'s
  `weatherMeta()` table (0=clear, 1=partly cloudy, 3=overcast, 61=rain, 95=thunderstorm).
- `FloatingTabBar` takes real `@react-navigation`-shaped `state`/`descriptors`/
  `navigation` props (expo-router's `BottomTabBarProps`) — its `.d.ts`-listed `insets`
  prop is dead (leftover from type generation; the component actually calls
  `useSafeAreaInsets()` itself, now fixed via the provider chain above). The preview
  builds a minimal mock: `state = {index, routes:[{key,name}]}`, `descriptors` keyed by
  route key with `options.tabBarIcon`/`options.title`, `navigation = {emit, navigate}`.

## Re-sync risks

- The above `package-validate.mjs` patch is local-only (gitignored `.ds-sync/`)
  and must be reapplied every re-sync until it's fixed upstream in the skill
  itself.
- Icons: `ScreenHeader`, `ModuleTitle`, `SectionLabel`, `FloatingBackHeader`
  take a `LucideIcon` component reference; `ConfirmModalBody`/
  `ChecklistModalBody` take a rendered `React.ReactNode` icon. Previews use
  `.design-sync/previews/_icons.tsx` (plain inline-SVG stand-ins matching
  lucide's `{size,color}` signature) instead of importing `lucide-react-native`
  directly — that package itself imports from `react-native`, which the
  preview compiler's plain esbuild pass can't resolve (no alias/`.web.js`
  priority like the package build has). Don't import `react-native` or
  `lucide-react-native` directly in any preview file; use the DS's own
  `View`/`Text` exports and `_icons.tsx` instead.
- `FloatingTabBar` needs real `@react-navigation`-shaped `state`/`descriptors`/
  `navigation` props — its preview (when authored) will need a hand-built mock
  of those, not real navigation state.
- Glass-mode variants (`Card`, `GlassFill`, `GlassBackdrop`) depend on
  `ThemeProvider`'s internal `containerStyle` state ('matte' default), which
  has no prop to set initially — previews needing glass mode must call
  `useAppTheme().setContainerStyle('glass')` in a `useEffect`.
