# P2-R00 readiness audit handoff

| Attribute | Value |
|---|---|
| Status | `P2-R00_READY_FOR_OWNER_REBASELINE_REVIEW` |
| Audit mode | Read-only; no P2 implementation started |
| Base requested | `origin/main@262e9c16ccc2a1f2797c665bfd3d7c2d219ceb20` |
| P1.6 close evidence | `P1.6-J01_PASS_WITH_OWNER_ACCEPTED_DEFERRED_FIXES` |
| Next gate | P1.7-J01 Owner Production acceptance |

## Outcome

The P2 rebaseline is ready for Owner review. Direct Entry is the canonical
transactional source for new recruitment detail. The legacy P1 report table is
still a distinct read model at the audited baseline; its reconciliation and
cutover are not proven complete. Daily Sheet ingestion is no longer an
applicable production workflow, while legacy source facts must remain
available until P2 establishes coverage and an accepted cutoff.

This handoff is **not** a declaration that P2 has started, that P1.7 is
accepted, that Production data was re-read after the I06 checkpoint, or that
historical Sheets were fully imported.

## Evidence and finding register

| ID | Evidence | Finding |
|---|---|---|
| E-01 | P1.6 J01 closure handoff at commit `7a468ea`: Production release at `main@262e9c1`, Owner accepted the declared deferred register, and the phase verdict is PASS. | F-01: Direct Entry is a shipped/accepted Production boundary, not a future P2 feature. |
| E-02 | P1.6 I06 records 37 applied migrations, zero pending/checksum mismatches, a Ready Production deployment and Owner-attested authenticated UI acceptance. | F-02: P2 should harden and reconcile the existing system, not recreate its DB/auth/document/submission lifecycle. |
| E-03 | I06 reports an unchanged reporting fingerprint, 30 active non-test reporting sources, 8 project keys, 10 recruiter keys, and 0 direct entries/submissions/candidates at that point-in-time read-only observation. | F-03: The baseline had legacy reporting data but no Direct Entry records at measurement time; current post-release volume and source state must be rechecked after P1.7 J01. |
| E-04 | The P1 reporting service reads `data_sources`, `reporting_latest_sync_runs_v01`, `reporting_sources_with_current_facts_v01` and `daily_recruitment_breakdown`. | F-04: Existing dashboard reporting remains an aggregate read path; Direct Entry publication is not proven by that query path. |
| E-05 | P1.6 migrations define Direct Entry submissions, entries/candidates, revisions, status/document/change-request events, audit, app users, capabilities and effective recruiter/team memberships. | F-05: Canonical transactional data, identity and attribution already have a P1.6 model; reuse it. |
| E-06 | The n8n README and WF01 runbook identify WF01 as Draft/manual, unscheduled, with DEV-only write credentials; workflow JSON is not tracked in Git. | F-06: Do not implement a scheduled Sheet pipeline or assume an active n8n Production workflow. |
| E-07 | P1.7 scope at commit `0f3487d` requires Owner Production J01 before P2 starts and excludes P2 data-platform work. | F-07: Only this read-only audit/rebaseline is permitted now; P2 execution waits for P1.7 J01. |

### Reconciliation caveat

P1.6 J01 acceptance confirms the Direct Entry release and the Owner-approved
deferred register. It does not prove historical source migration or subsequent
production usage. I06's 30 active non-test reporting sources and the P1.6
source-retirement expectation must be reconciled by source ID after P1.7 J01.
Treat this as an explicit W01/W04 question, not as evidence that Sheet
ingestion is still running.

## Existing P2 task classification

Classification describes the old task as a whole. An N8N task can be deferred
or marked not applicable for routine Sheets while a narrower, Owner-approved
external-source variant remains possible.

| Task | Status | Owner-review recommendation |
|---|---|---|
| P2-W01 | **MODIFY** | Rebaseline actual canonical/report state, deferred items, retained-source status and restore boundary. |
| P2-N01 | **MODIFY** | Inventory only the current legacy source set and any approved continuing external feeds; no new workflow. |
| P2-C01 | **MODIFY** | Define Direct Entry-to-report consistency, revision/cutoff, recovery and conditional external ingestion. |
| P2-W02 | **MODIFY** | Reuse P1.6 stable IDs and effective memberships; keep full organization/leader authorization policy in P3. |
| P2-W03 | **MODIFY** | Extend existing DB boundaries minimally for reporting lineage/reconciliation; do not duplicate P1.6 audit/idempotency. |
| P2-N02 | **NOT_APPLICABLE** | Daily Sheet dispatcher is out. A generic dispatcher requires an approved N01 source first. |
| P2-N03 | **MODIFY** | Sheet sync is out; reconciliation and report cutover remain. External sync is conditional. |
| P2-N04 | **DEFER** | Do not build generic n8n quarantine/replay until a retained source exists; reuse P1.6 workflow recovery otherwise. |
| P2-W04 | **KEEP** | Critical reporting aggregation/reconciliation work; the current P1 read model still uses legacy aggregate facts. |
| P2-W05 | **MODIFY** | Operations view should prioritize Direct Entry/report health; expose pipeline status only when a retained pipeline exists. |
| P2-N05 | **DEFER** | No active schedule is evidenced for WF01. Add workflow alerting only after source, threshold and recipients are approved. |
| P2-W06 | **KEEP** | Capacity/access checks for live Direct Entry, reporting and storage; no duplicate P3 RBAC. |
| P2-W07 | **KEEP** | Restore drill remains required for live database and separately stored document objects. |
| P2-N06 | **MODIFY** | Restore only workflows adopted by P2; workflow export is not credential backup. |
| P2-J01 | **KEEP** | Accept the actual reliability, no-double-count reporting and restore scope after the above gates. |
| P2-W08 / P2-N07 | **MODIFY** | Deliver identity/history/report/recovery inputs to P3; N8N handoff only if an approved workflow survives. |

The row-level rationale and capability decisions are in the
[post-direct-entry rebaseline](../roadmaps/p2-post-direct-entry-rebaseline.md).

## Gate and immediate next steps

### Must wait for P1.7 J01

All P2 implementation, source-state mutation, migration, reporting cutover,
n8n workflow change, Production query with candidate data, and operational
alert activation must wait for Owner acceptance of the P1.7 Production grid.
P2-R00 is read-only and does not waive that gate.

### First P2 wave after J01

1. **W01** — obtain approved read-only post-release counts/source status;
   document Direct Entry vs reporting totals and the accepted baseline.
2. **N01** — inventory source IDs and legacy Sheet records; identify any
   continuing non-Sheet external source and mark unsupported sources blocked.
3. **C01** — draft reliability/reporting/recovery contracts in parallel, then
   freeze source-dependent terms after W01/N01 and Owner decisions.

After G1, WEB may work on the bounded master/history and reporting boundary.
N8N tasks remain conditional; no workflow is to be created merely to preserve
the old task list.

## Capability disposition

- **Reconciliation — KEEP:** must compare Direct Entry published records to
  the existing report read model and archived legacy coverage before source
  retirement.
- **Monitoring — KEEP, MODIFY:** monitor report freshness/reconciliation and
  Direct Entry/document operations; no schedule-alert implementation for an
  inactive workflow.
- **Replay — MODIFY/CONDITIONAL:** allow only controlled, idempotent replay of
  an Owner-approved source or worker; do not add daily Sheet replay.
- **Backup/recovery — KEEP:** DB and object storage need separately tested
  restore. Recover n8n only if a workflow is retained.
- **Source registry — MODIFY:** retain source identity/lineage; generalize
  only for known and approved continuing sources.
- **Organization history — KEEP, MODIFY:** reuse P1.6 effective memberships;
  give P3 stable identity, date-valid relationships and audit history.
- **External ingestion — DEFER:** one-time legacy reconciliation may be
  needed; ongoing ingestion needs a specific source, authority and Owner
  approval.

## Inputs for P3

P2 must provide stable P1.6 IDs and identity mappings, effective-dated
recruiter/team history and attribution, existing capability/scope grants and
audit vocabulary, the canonical-to-report projection and revisions, source
coverage/freshness, and tested operational limits/recovery evidence. P3 owns
BoD/Leader/Staff policy, full organization membership/history, onboarding and
authorization expansion on the same IDs; P2 must not create a second model.

## Owner decisions at G1

- Which of the 30 I06 reporting sources are retained historical sources, and
  what is their current active/retired state?
- What cutoff and independent expected totals authorize reporting cutover and
  eventual legacy-source retirement?
- Are there post-I06 Direct Entry records, and what read-only production
  evidence may be used to reconcile them?
- Does any non-Sheet external ingestion remain in scope?
- What are the approved retention, RPO/RTO, alert thresholds, channel and
  recipients?

## Scope and checks

This audit changed documentation only. It did not edit runtime/source,
migrations/DB, n8n workflows, environment/deployment configuration,
`docs/P2.md`, `docs/master-plan.md` or P1.7 branches. The full proposed
rebaseline is [here](../roadmaps/p2-post-direct-entry-rebaseline.md).
