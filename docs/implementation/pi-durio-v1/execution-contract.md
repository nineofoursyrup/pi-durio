# PI-DURIO-V1-SPEC-r1 execution

Coordinator workspace: /Users/nineofour/Durio. Integration: codex/pi-durio-v1.
Spec: docs/specs/pi-durio-v1-spec.md. Refresh: /Users/nineofour/pi-durio-v1-run/remote/issue-N.json contains full body/comments/native dependencies for #2–#32. Graph: remote/refresh-summary.json. Remote matched published 22 tickets / 34 edges and #10 exactly on 2026-10-09.
All original files: originals.json. Never rewrite originals or published historical artifacts.

Authority: implement, necessary dependency installs, tests, per-ticket worktrees and commits, local merges, push work branches, one integration Draft PR, claim active issues / necessary evidence comments. Empty-main bootstrap authorized once only. No product merge to main, release, issue closure, design scope change or paid provider use without a concrete batch grant. All issues stay OPEN; dependencies satisfy only after applicable acceptance and integration, not GitHub closure.

Model request: gpt-6-astra / xhigh for fresh-context child agents. Coordinator actual model is not attestable through current tools. At most 2 implementers + one merger/reviewer, coordinator counts in 4 total concurrency slots.

Agent handoff: read applicable AGENTS.md, docs/agents/*, GLOSSARY, spec, ticket and referenced design/ADR. Use public exact Pi APIs, never copy/rebuild loop/recovery engine or import private demo. Read current primary upstream docs when using dependency APIs and pin actual versions. No paid model call. TDD skill for regression/test-design guidance. Save first failures and corrected evidence separately. Return commit, checks, limitations; no separate full review loop. Do not modify issue body/close issues or push without coordinator instruction.

Initial ownership: #11 owns package.json/package-lock/tsconfig, src/runtime + CLI + evidence core and tests thereof. #12 owns standalone isolation/probe files only (src/eval-isolation or scripts/isolation and corresponding fixtures/tests/docs); initially self-contained Node scripts, no package manifest or shared runtime mutation. Coordinate public integration seam through a documented interface, later #21 wires actual runtime. Both fork from documentation integration commit. All durable orchestration belongs upstream.

Resume ledger: state.json; append-only journal.jsonl. Per-ticket agent reports and evidence at evidence/issue-N/. Treat partial, blocked and NOT RUN honestly; do not unblock dependants on mocks/partial acceptance. Real Terminal and paid DeepSeek separate gates; #32 only human acceptance.
