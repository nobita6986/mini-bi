# Communication

- Communicates in Vietnamese and expects responses in Vietnamese. Confidence: 0.9
- Expects a structured completion report: base → final SHA, branch/worktree, files changed, what was done, every gate run with pass/fail evidence, what was skipped/risks, and an explicit final status. Confidence: 0.9
- Expects acknowledgment of a role/instruction and then waiting for the next command without acting prematurely or starting unrequested work. Confidence: 0.7
- Wants required gates/checks (e.g. diff check, docs check, secrets check) run and reported with concrete evidence. Confidence: 0.7
- Gives review feedback in a structured format: "Must fix" / "Should fix" / "Verdict", each item framed as What / Problem / Fix / If skip, and cites specific file line references for each issue. Confidence: 0.6
- When reporting identity/account verification, keeps each identity separate (agent/task session, Git identity, GitHub CLI login, Vercel CLI account, Git author/committer metadata) rather than merging them into one "account", and presents a comparison table that distinguishes what was verified from what could not be verified, explicitly stating "không xác minh được" instead of guessing. Confidence: 0.75
- Does not infer that Git author/email proves which GitHub or Vercel account is in use: Git metadata, GitHub CLI login, and Vercel CLI account are separate identities each requiring its own evidence. Confidence: 0.75
- When the user attributes a harmful or unexpected action to the agent (e.g. "you pushed with account X and got us blocked"), does not accept blame or guess: re-checks with read-only evidence at hand (whoami, remote metadata, recent logs, identity state) and answers by stating factually what was and was not done, correcting the record when evidence contradicts the attribution. Confidence: 0.55
- When the user shares a screenshot/image, inspects it with the vision tool and grounds the answer in the image's actual content (commit SHA, message, branch, author, etc.) rather than guessing. Confidence: 0.7
- Impatient about wall-clock time on long tasks: while long-running gates/commands are in flight, pings with a terse "xong chưa?" and expects a concise current-state answer (what is done, what remains, what is blocked) rather than silence. Confidence: 0.55
- Writes in terse, informal Vietnamese (e.g. "xong chưa mày, lâu thế") when pressing for progress; replies should stay concise and direct rather than formal. Confidence: 0.5
