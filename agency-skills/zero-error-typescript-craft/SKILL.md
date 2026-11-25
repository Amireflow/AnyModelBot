---
name: zero-error-typescript-craft
description: Strict TypeScript discipline preventing unused locals (TS6133), implicit any, missing module declarations, and broken build/test configs.
---

# Zero-Error TypeScript Craft

1. **No Unused Declarations (TS6133 / TS6196)**:
   - Remove every unused import, variable, type parameter, or function parameter before finishing.
   - If a callback parameter is intentionally unused, omit it or prefix clearly when required by signatures.

2. **Strict Null Safety & Explicit Contracts**:
   - Never assume `.find()` or `Record<string, T>[key]` returns a defined value; narrow with `??` or `if (!item) return`.
   - Always declare explicit interfaces for component props, store state, and API responses instead of `any`.
   - When adding icons (`lucide-react`), import only symbols actually rendered in JSX.

3. **Dependencies & Config Integrity**:
   - Every third-party import must be listed in `package.json` (install via `<studio-add-dep packages="..." />` when missing).
   - Keep `tsconfig.json` `include` / `types` accurate: if `vite/client` or `@testing-library` is referenced, verify the package/types exist in `package.json`.

4. **Fast Fix Loop**:
   - Always run `<studio-diagnostics />` first on edits, read exact line numbers around any reported `file(line,col): error TS...`, patch minimally with `<studio-patch>`, and confirm 0 errors before `<studio-run action="npm_build" />`.
