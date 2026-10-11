# Git Preferences

- Never amend, rebase, force-push, merge `main`, or modify the main checkout. Confidence: 0.9
- Preserve other people's changes; if the worktree contains changes outside the task scope, stop and report rather than touching them. Confidence: 0.85
- Before reporting a task complete: commit, push fast-forward to the correct branch, and verify local HEAD equals remote HEAD with a clean worktree. Confidence: 0.85
