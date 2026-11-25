---
name: fullstack-vite-react-ts
description: Clean full-stack Vite + React + TypeScript architecture, routing, state management, Tailwind CSS styling, and zero-broken-import build discipline.
---

# Full-Stack Vite + React + TypeScript Craft

1. **Architecture & Folder Structure**:
   - Keep entry clean: `index.html` -> `src/main.tsx` -> `src/App.tsx`.
   - Separate domain types (`src/types/`), data/API layer (`src/services/` or `src/data/`), hooks/state (`src/hooks/` or `src/context/`), reusable UI (`src/components/`), and pages (`src/pages/`).
   - Never import test files (`*.test.ts`, `*.spec.ts`) from production code or leave unused test mocks in `tsconfig.json` build scope unless `vitest` types match cleanly.

2. **Styling & Tailwind / CSS**:
   - Prefer semantic design tokens in `src/index.css` (`:root` variables, clean typography, consistent radii, high-contrast palettes).
   - Ensure mobile-first responsiveness (`sm:`, `md:`, `lg:` grids, no horizontal overflow on `375px`, accessible focus rings and contrast >= 4.5:1).
   - Avoid broken external CDN assumptions; use installed `lucide-react` icons or clean inline SVG icons.

3. **Routing & Data Realism**:
   - Wrap interactive flows cleanly with realistic domain data (no "Lorem ipsum", "Company X", or placeholder URLs).
   - Every form, filter, modal, cart/table, and action button visible in the UI must actually work or show an explicit clear feedback banner/toast.
   - Guard against `undefined` array/map reads, stale localStorage schemas (`try { JSON.parse(...) } catch { return fallback; }`), and blank initial screens.

4. **Verification Gate**:
   - Before declaring done, verify imports, dependencies in `package.json`, TypeScript `<studio-diagnostics />`, and production build `<studio-run action="npm_build" />`.
