# Issue tracker: GitHub

Issues and specs live in https://github.com/nineofoursyrup/pi-durio/issues.
Use the `gh` CLI with `--repo nineofoursyrup/pi-durio` for issue and PR commands.

## Conventions

- Create: `gh issue create --repo nineofoursyrup/pi-durio --title "..." --body-file <path>`.
- Read: `gh issue view <number> --repo nineofoursyrup/pi-durio --comments`; fetch labels with `--json number,title,body,labels,comments`.
- List: `gh issue list --repo nineofoursyrup/pi-durio --state open --json number,title,body,labels,comments`; apply appropriate filters and retrieve all relevant results.
- Edit: `gh issue edit <number> --repo nineofoursyrup/pi-durio --body-file <path>`.
- Comment: `gh issue comment <number> --repo nineofoursyrup/pi-durio --body-file <path>`.
- Labels: `gh issue edit <number> --repo nineofoursyrup/pi-durio --add-label "..."` or `--remove-label "..."`; use the mapping in `triage-labels.md`.
- Close: `gh issue close <number> --repo nineofoursyrup/pi-durio --reason completed` (or `--reason "not planned"` when appropriate).

For multiline bodies and comments, write the exact text to a temporary file and use `--body-file`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill operations

- "Publish to the issue tracker": create a GitHub issue.
- "Fetch the relevant ticket": read the issue and its comments.
- GitHub issues and PRs share numbers; resolve an ambiguous reference with `gh pr view`, falling back to `gh issue view`.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog.
- Child: create with `gh issue create --repo nineofoursyrup/pi-durio --parent <map-number> ...`; label it `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`). If sub-issues are unavailable, link it in the map's task list and add `Part of #<map-number>` to the child body.
- Blocking: use native dependencies, e.g. `gh issue edit <child> --repo nineofoursyrup/pi-durio --add-blocked-by <blocker>`. If unavailable, record `Blocked by: #<number>, #<number>` in the child body. A ticket is unblocked when every blocker is closed.
- Frontier: inspect all map children in map order; choose the first open, unblocked, unassigned ticket.
- Claim: assign `@me` before starting work.
- Resolve: comment with the answer, close the child, then append a concise finding and issue link to the map's Decisions-so-far.
