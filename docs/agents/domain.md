# Domain docs

Layout: **single-context**.

## Before exploring

- Read `GLOSSARY.md` at the repo root when it exists.
- Read relevant architectural decisions under `docs/adr/`.
- If these files are absent, proceed silently. The `domain-modeling` skill creates them lazily when terms or decisions are resolved.

## Layout

- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/NNNN-<decision-slug>.md`: architectural decision records.

Paths are relative to the repo root.

## Use the vocabulary

Use glossary terms consistently in issues, proposals, code, and tests. When a necessary concept is missing, reconsider the wording or note the gap for `domain-modeling`.

## Surface ADR conflicts

If a proposal contradicts an ADR, identify that ADR and explain why the decision should be reopened before proceeding.
