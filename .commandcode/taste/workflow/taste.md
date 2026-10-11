# Workflow & Collaboration Preferences

- When assigned a role/context but no concrete task yet, explicitly confirm acceptance of the role and then wait — do not start surveying, creating branches/worktrees, editing files, or running gates until given a specific task. Confidence: 0.85
- Mandatory preflight before any task: verify the correct repo, worktree, branch, base SHA, clean state, and migration ledger. Confidence: 0.9
- Strongly prefers reuse of existing code, components, helpers, test patterns, and libraries; minimize new code and avoid creating frameworks or unnecessary abstractions. Confidence: 0.9
- Strict scope discipline: do exactly the one assigned task — do not expand scope, do not do other tasks, and do not change locked/already-agreed contracts. Confidence: 0.9
- Reads requirements, AGENTS.md, and related handoff/docs carefully before starting work. Confidence: 0.8
- On blockers or factual contradictions: only investigate and report evidence — never speculate or unilaterally change a contract. Confidence: 0.85
- Final report format should include: base → final SHA, branch/worktree, key files, what was done, all gates run, mutation evidence, what was NOT done, and a clear status. Confidence: 0.85
- Do not query/write Production, apply migrations, deploy, run browser UAT, or touch real data unless explicitly assigned. Confidence: 0.85
- Communicates in Vietnamese. Confidence: 0.8
