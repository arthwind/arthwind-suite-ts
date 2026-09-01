# AGENTS.md — arthwind-suite-ts

Context file for AI coding agents (Claude Code, Antigravity, Cursor, Codex, …).
This is the **single source of truth**; `CLAUDE.md` just imports it.

`arthwind-suite-ts` is the **Electron + React + TypeScript desktop application** of the Arthwind platform. It provides automation for wind turbine drone inspection workflows (S&R sorting, GPS/Z calibration, Horizon processing, SNOW ServiceNow damage entry automation, and Arthnex internal upload integrations).

---

## 🔴 Golden rules (Arthwind / Arthnex standard)

1. **Package manager: `pnpm` only.** Never `npm` / `yarn`. Never commit `package-lock.json` (`pnpm-lock.yaml` is the truth).
2. **Protected branches: `main`, `homolog`, `development`.** Never commit or push to them directly without explicit permission. Always create a work branch `feat/<id>`, `fix/<id>` or `refactor/<id>` **from `development`**.
3. **Before finishing any task, make these green:**
   - `pnpm exec tsc --noEmit -p tsconfig.node.json --composite false && pnpm exec tsc --noEmit -p tsconfig.web.json --composite false`
   - `pnpm exec biome check .`
   - `pnpm exec vitest run`
4. **No new dependencies without prior approval.** Reuse what already exists.
5. **Write unit tests for every new piece of logic / processing algorithm.**
6. **Everything in the code is in English** — messages, errors, comments, function/variable names, types.
7. **Senior-level code, minimal comments.** The code explains itself; comment only the non-obvious "why".
8. **Before creating anything new, search for an existing one** (component, hook, service, util) and reuse/extend it without breaking its current contract.
9. **Resource management & Lifecycle:** Always clean up event listeners, timers, file streams, child processes, Playwright browser instances, and Three.js scenes/geometries on unmount or process exit.

---

## Commands

```bash
pnpm install                       # install deps
pnpm dev                           # electron-vite dev
pnpm build                         # electron-vite build (with typecheck)
pnpm exec tsc --noEmit             # typecheck node + web
pnpm exec biome check .            # lint + format check (REQUIRED before done)
pnpm exec biome check --write .    # auto-fix lint/format
pnpm exec vitest run               # run unit tests once
pnpm test:watch                    # watch mode tests
pnpm build:win                     # build NSIS Windows installer
pnpm build:win:portable            # build standalone Windows Portable .exe (zero install)
pnpm build:linux                   # build Linux AppImage/binary
pnpm build:pacman                  # build Arch Linux pacman package (.pkg.tar.zst)
```

---

## Stack & Architecture

- **Runtime & Bundler:** Electron 39, `electron-vite` (Vite 7), Node 22, React 19, TypeScript (strict).
- **Architecture:**
  - `src/main/`: Electron main process, IPC handlers, background workers, filesystem operations, Excel/CSV parsers, Playwright automation (`src/main/services/`).
  - `src/preload/`: Secure Electron IPC bridge (`contextBridge.exposeInMainWorld`).
  - `src/renderer/`: React 19 UI, module forms, 360 viewer, state management.
- **Cross-Platform Native Binaries:**
  - `sharp`: Requires matching `@img/sharp-linux-x64` and `@img/sharp-win32-x64` in `dependencies` / `optionalDependencies` and `asarUnpack` to guarantee image cropping/polygon rendering on both Linux and Windows.
  - `playwright`: Configured with system browser fallbacks (Chrome/Edge) to run automation on target machines without requiring manual browser installations.
- **Formatter & Linter:** Biome `1.9.4`: 2-space indent, width 80, single quotes, **no semicolons**, `trailingCommas: es5`.
- **Testing:** Vitest + Happy-DOM + `@testing-library/react`.
