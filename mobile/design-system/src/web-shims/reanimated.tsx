import { useEffect, useRef, useState, forwardRef, type ComponentType } from 'react';
import { View } from 'react-native';

// Web stand-in for react-native-reanimated. Reanimated's real engine needs its
// Babel worklet plugin to run components on the UI thread; without it (a plain
// esbuild bundle has no such plugin) its web fallback crashes inside
// _updatePropsJS. This reimplements only the small hook/helper surface that
// src/components/ui/{PressableScale,FloatingTabBar,StaggerReveal}.tsx actually
// use — a rAF-driven tween engine that re-renders on the JS thread instead of
// running worklets, which is plenty for brief press/pulse/reveal feedback.

type EasingFn = (t: number) => number;
type TimingConfig = { duration?: number; easing?: EasingFn };
type Descriptor =
  | { kind: 'timing'; toValue: number; duration: number; easing: EasingFn }
  | { kind: 'sequence'; steps: Descriptor[] }
  | { kind: 'delay'; ms: number; inner: Descriptor }
  | { kind: 'repeat'; inner: Descriptor; count: number; reverse: boolean };

const DEFAULT_DURATION = 300;
const linear: EasingFn = (t) => t;

export const Easing = {
  linear,
  ease: (t: number) => t * t * (3 - 2 * t),
  cubic: (t: number) => t * t * t,
  out: (fn: EasingFn): EasingFn => (t) => 1 - fn(1 - t),
  in: (fn: EasingFn): EasingFn => fn,
  inOut: (fn: EasingFn): EasingFn => (t) => (t < 0.5 ? fn(2 * t) / 2 : 1 - fn(2 * (1 - t)) / 2),
};

export function withTiming(toValue: number, config?: TimingConfig): Descriptor {
  return { kind: 'timing', toValue, duration: config?.duration ?? DEFAULT_DURATION, easing: config?.easing ?? linear };
}

export function withSequence(...steps: Descriptor[]): Descriptor {
  return { kind: 'sequence', steps };
}

export function withDelay(ms: number, inner: Descriptor): Descriptor {
  return { kind: 'delay', ms, inner };
}

export function withRepeat(inner: Descriptor, count = -1, reverse = false): Descriptor {
  return { kind: 'repeat', inner, count, reverse };
}

export function useReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

class SharedValue<T extends number> {
  private current: T;
  private raf: number | null = null;
  private listeners = new Set<() => void>();

  constructor(initial: T) {
    this.current = initial;
  }

  get value(): T {
    return this.current;
  }

  set value(next: T | Descriptor) {
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (typeof next === 'object' && next != null && 'kind' in next) {
      this.run(next as Descriptor);
    } else {
      this.current = next as T;
      this.notify();
    }
  }

  // Reanimated 3+'s .get()/.set() API — thin aliases over .value so both call
  // styles (used across src/components/ui) hit the same tween engine.
  get(): T {
    return this.value;
  }

  set(next: T | Descriptor) {
    this.value = next;
  }

  private run(descriptor: Descriptor, onDone?: () => void) {
    if (descriptor.kind === 'delay') {
      const timeout = setTimeout(() => this.run(descriptor.inner, onDone), descriptor.ms);
      this.raf = timeout as unknown as number;
      return;
    }
    if (descriptor.kind === 'sequence') {
      const [first, ...rest] = descriptor.steps;
      if (!first) {
        onDone?.();
        return;
      }
      this.run(first, () => {
        if (rest.length) this.run({ kind: 'sequence', steps: rest }, onDone);
        else onDone?.();
      });
      return;
    }
    if (descriptor.kind === 'repeat') {
      const startValue = this.current;
      const runOnce = (remaining: number, forward: boolean) => {
        // Only 'timing' inner steps support the reverse ping-pong (the only
        // shape actually used here); anything else just repeats forward.
        const step: Descriptor =
          descriptor.reverse && !forward && descriptor.inner.kind === 'timing' ? { ...descriptor.inner, toValue: startValue } : descriptor.inner;
        this.run(step, () => {
          const next = remaining < 0 ? -1 : remaining - 1;
          if (next !== 0) runOnce(next, !forward);
          else onDone?.();
        });
      };
      runOnce(descriptor.count, true);
      return;
    }
    const from = this.current;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / descriptor.duration);
      this.current = (from + (descriptor.toValue - from) * descriptor.easing(t)) as T;
      this.notify();
      if (t < 1) {
        this.raf = requestAnimationFrame(step);
      } else {
        onDone?.();
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }
}

export function useSharedValue<T extends number>(initial: T): SharedValue<T> {
  const ref = useRef<SharedValue<T> | null>(null);
  if (ref.current === null) ref.current = new SharedValue(initial);
  return ref.current;
}

// Re-runs `factory` (and re-renders) whenever any shared value it read last
// time changes — a JS-thread stand-in for reanimated's UI-thread mapper.
export function useAnimatedStyle<T extends object>(factory: () => T): T {
  const [, forceRender] = useState(0);
  const sharedValuesRef = useRef<Set<SharedValue<number>>>(new Set());
  const style = trackReads(factory, sharedValuesRef.current);

  useEffect(() => {
    const unsubscribers = Array.from(sharedValuesRef.current).map((sv) => sv.subscribe(() => forceRender((n) => n + 1)));
    return () => unsubscribers.forEach((u) => u());
  });

  return style;
}

// Same tracking mechanism as useAnimatedStyle, for the props (not style) case —
// e.g. RouteDot in CityroamMark.tsx animating an SVG Circle's cx/cy.
export function useAnimatedProps<T extends object>(factory: () => T): T {
  const [, forceRender] = useState(0);
  const sharedValuesRef = useRef<Set<SharedValue<number>>>(new Set());
  const props = trackReads(factory, sharedValuesRef.current);

  useEffect(() => {
    const unsubscribers = Array.from(sharedValuesRef.current).map((sv) => sv.subscribe(() => forceRender((n) => n + 1)));
    return () => unsubscribers.forEach((u) => u());
  });

  return props;
}

function trackReads<T>(factory: () => T, into: Set<SharedValue<number>>): T {
  // SharedValue instances created via useSharedValue above are the only ones
  // ever passed into an animated-style factory in this codebase, so reading
  // `.value` on any of them during this call is what determines the
  // subscription set (no attempt at a generic worklet dependency scan).
  into.clear();
  const originalDescriptor = Object.getOwnPropertyDescriptor(SharedValue.prototype, 'value')!;
  Object.defineProperty(SharedValue.prototype, 'value', {
    configurable: true,
    get(this: SharedValue<number>) {
      into.add(this);
      return originalDescriptor.get!.call(this);
    },
    set: originalDescriptor.set,
  });
  try {
    return factory();
  } finally {
    Object.defineProperty(SharedValue.prototype, 'value', originalDescriptor);
  }
}

const Animated = {
  View,
  createAnimatedComponent<P extends object>(Component: ComponentType<P>) {
    return forwardRef<unknown, P & { animatedProps?: Partial<P> }>(({ animatedProps, ...props }, ref) => (
      <Component ref={ref as never} {...(props as P)} {...animatedProps} />
    ));
  },
};

export default Animated;
