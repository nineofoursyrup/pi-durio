# Tests

`npm test` runs test files one at a time. Run focused files the same way: `node --test --test-concurrency=1 dist/test/<name>.test.js …`.

Tests share machine-wide state, so files running in parallel interfere:

- Workspace ownership writes to the real registry `~/Library/Application Support/pi-durio/workspace-owners` (`workspaceOwnerRegistry` in `src/workspace-ownership.ts`, fixed from `homedir()`). Parallel files that acquire owners fail with `OWNER_CONFLICT` or time out.
- improve tests share the host `container` runtime.
- UI and improve tests poll against fixed deadlines (for example 15 s); under load a wait expires without any product defect.

The registry is per machine, not per worktree, so two worktrees testing at once conflict the same way. Run one full check per machine at a time: concurrent full checks have also filled the disk (ENOSPC).

When an owner, container or timeout failure appears in a full check, rerun that file alone and report both results before treating it as a product defect.
