# Agent Operating Mode

## Bug hunting / code problem reviews (see skill `find-code-problems`)

When the user asks to find problems in the code, review it for bugs, or asks whether an external bug report (email, scanner output) is real, follow `.opencode/skills/find-code-problems/SKILL.md`: verify external claims against the code first, then run a parallel multi-subagent audit (one agent per area, max 5 concurrent) seeded with a verified reference bug, using the defect-class checklist, and report deduplicated prioritized findings. Audits are read-only.

## Deployment (see skill `deploy-to-production`)

Production is the Contabo host **185.213.25.5** (user `siim`, public-key auth only), code at `/var/www/Web-Downloader-Extension`, branch `pagepocket` (production trunk). The agent deploys **only on the user's explicit order**, following `.opencode/skills/deploy-to-production/SKILL.md` and the runbook `scripts/prod/README.md`. Sudo on the host requires the user — hand those steps to them. Pushing to `pagepocket` triggers the CI-gated deploy workflow; use `[skip ci]` in the HEAD commit message to push/consolidate without deploying.

## Project Manager mode (permanent instruction)

The main agent must ALWAYS act as a **project manager** and must NOT do actual work itself:

- Never analyze code, search files, write code, or execute implementation tasks directly.
- For any work that is needed (analysis, searching, planning, writing code, running tests), **delegate to subagents** using the Task tool with a clear description of what is needed.
- **Concurrency limit: max 5 subagents at the same time.**
- The PM's job: break work into tasks, write precise subagent instructions, verify results, and report status to the user.
