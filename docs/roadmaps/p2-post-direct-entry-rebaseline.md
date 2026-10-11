# P2 post-direct-entry rebaseline

| Attribute | Value |
|---|---|
| Audit ID | P2-R00 |
| Status | `P2-R00_READY_FOR_OWNER_REBASELINE_REVIEW` |
| Baseline | `origin/main@262e9c16ccc2a1f2797c665bfd3d7c2d219ceb20` |
| P1.6 release verdict | `P1.6-J01_PASS_WITH_OWNER_ACCEPTED_DEFERRED_FIXES` |
| P1.7 gate | Owner Production J01 remains the gate before P2 execution |
| Scope | Read-only audit and roadmap rebaseline; no implementation authorization |

This rebaseline treats Direct Entry as the canonical transactional source for new
recruitment records. It does **not** assume that the existing P1 dashboard read
model has already been migrated from its Sheet-derived aggregate facts to those
records. Reconciliation and an explicit reporting cutover remain P2 work.

## Decision summary

1. New recruitment detail is authored in the P1.6 Direct Entry application and
   persisted in Supabase. Submitted entries and approved/privileged revisions
   are canonical; drafts, review-pending changes and unapproved requests are
   not published business facts.
2. The current P1 reporting path is a separate aggregate read model:
   `data_sources` plus `daily_recruitment_breakdown` and reporting views. Its
   current production evidence predates Direct Entry data. Do not sum it with
   Direct Entry records or label it a second live system of record.
3. Routine Google Sheets ingestion through n8n is no longer the operating
   workflow after P1.6. The checked-in WF01 runbook describes a Draft/manual
   workflow with no active schedule and DEV-only write credentials.
4. Preserve the existing Sheet-derived report snapshots and their source
   lineage until W01/N01 establish coverage, mapping and a PO-approved
   reconciliation cutoff. They remain legacy evidence, not a reason to restart
   scheduled Sheet ingestion.
5. P2 keeps reporting reconciliation, safe recovery, data-quality monitoring
   and the master/history handoff. Source dispatch, recurring Sheet sync and
   generic replay/alert workflows are conditional on a separately approved
   external source inventory.

## Canonical data and retained sources

| Data surface | Current authority or role | P2 treatment |
|---|---|---|
| Recruitment detail | P1.6 Direct Entry tables and APIs: `direct_entry_submissions`, `direct_entries`, `direct_entry_candidates`, related revisions, status events and audit events. A `SUBMITTED` submission is published; draft/review state is not. | Keep this as the canonical transaction source. Do not create a parallel Sheet-backed detail store. |
| Master identity and attribution | Stable `recruiters`, `teams`, `direct_entry_projects`, recruiter aliases, provider/team effective memberships, app-user links and capability/scope grants. | Reuse the P1.6 IDs and effective-date semantics. P2 closes only data/attribution gaps needed for reporting; P3 owns full organization and access history. |
| P1 dashboard reporting | `src/lib/reporting/p1-reporting-server.ts` reads active, non-test `data_sources`, the reporting views, and `daily_recruitment_breakdown`. These are aggregate source facts, not the P1.6 candidate detail tables. | Keep the read model until W04 proves a consistent Direct Entry projection and a controlled cutoff. Reconcile before retiring or deactivating any source. |
| Historical Google Sheets | Legacy source material and the provenance behind existing aggregate facts. The P1.6 handoff does not establish that all historical rows were imported into Direct Entry. | Retain read-only/archived copies and existing `source_id` lineage through reconciliation and retention approval. No routine double-write or blind re-import. |
| Google Drive / R2 documents | P1.6 document metadata and controlled object storage; not a recruitment ingestion feed. | Keep document lineage and object recovery in the P1.6/P2 recovery boundary. Do not route candidate-document bytes through a new n8n Sheet pipeline. |
| n8n WF01 | P0 `daily-recruitment-breakdown/0.2` Sheet aggregate ingestion. Repo runbook says Draft/manual, no schedule, DEV-only service role and no active version. | No production daily ingestion after P1.6. Retain sanitized runbook and workflow identity as legacy operational evidence; any future use requires an explicit source decision. |

### Reporting cutover finding

P1.6 I06 records a read-only Production observation of **30 active,
non-test reporting sources, 8 project keys, 10 recruiter keys**, with an
unchanged reporting fingerprint; it also records **0 direct entries, 0
submissions and 0 candidates** at that checkpoint. The P1.6-J01 close handoff
confirms release and Owner acceptance, but does not turn that earlier sample
into evidence of subsequent production volume or prove that the P1 read model
has been reconciled to Direct Entry.

Therefore:

- `daily_recruitment_breakdown` is still the observed P1 dashboard read source
  at the baseline, not proof that newly submitted Direct Entry records are
  already included.
- W01 must re-check current counts and source state through an owner-approved,
  read-only Production evidence path after P1.7 J01.
- W04 must specify and test the bridge/cutover from Direct Entry to reporting,
  with exact expected totals, source coverage, correction semantics and a
  no-double-count rule.
- Do not deactivate or delete legacy report facts solely because P1.6 is
  Production. Source retirement follows successful reconciliation and Owner
  acceptance.

## P2 capability decisions

| Capability | Decision | Rebased boundary |
|---|---|---|
| Reconciliation | **KEEP** | Reconcile submitted Direct Entry facts, effective-dated attribution and P1 report totals against the retained legacy aggregate. Include correction/revision effects and source coverage. Stop recurring Sheet-vs-web comparisons only after an accepted cutoff and archived evidence. |
| Monitoring | **KEEP / MODIFY** | Observe Direct Entry publication, report freshness/reconciliation, document upload recovery and operational failures. Defer alerts about scheduled Sheet runs while WF01 is inactive; thresholds and recipients still require Owner approval. |
| Replay | **MODIFY / CONDITIONAL** | Keep idempotent, auditable recovery for an explicitly approved one-time import or surviving external worker. Do not build replay of daily Sheet ingestion or replay the P1.6 transaction lifecycle in n8n. Reuse P1.6 idempotency, OCC and change-request boundaries. |
| Backup and recovery | **KEEP** | Prove DB restore and separately cover R2 objects, metadata, deployment configuration and any retained workflow/credential recovery. No assumed RPO/RTO; obtain Owner targets and test against them. |
| Source registry | **MODIFY** | Preserve existing `data_sources` IDs and reporting lineage. Add/extend registry behavior only for sources proven by N01 to remain active; do not register Direct Entry as a second Sheet-style connector. |
| Organization history | **KEEP / MODIFY** | Reuse recruiter/team IDs and effective-dated memberships already in P1.6. P2 validates reporting attribution and fills approved gaps; P3 extends the same identity/history into full organization, leader-team access and RBAC. |
| External ingestion | **DEFER** | Daily Sheet ingestion is out. A one-time historical migration or new connector is allowed only after inventory, authority, privacy, deduplication and cutoff are approved. No additional active external ingestion source is evidenced in the repository baseline. |

## Classification of existing P2 tasks

The classification applies to the task as currently written. When a task is
conditional, the condition is a gate, not permission to build a speculative
framework.

| Existing task | Classification | Rebaseline |
|---|---|---|
| P2-W01 — Baseline and gap assessment | **MODIFY** | After P1.7 J01, inventory the actual Direct Entry/reporting split, production counts, source state, history, deferred P1.6 items and recovery coverage. No assumed Sheet-ingestion rollout. |
| P2-N01 — Source inventory and sync conditions | **MODIFY** | Inventory legacy source IDs, archived Sheets, report facts and any explicitly retained external source. Record that no schedule/active WF01 is evidenced. Do not access real sources without authorization. |
| P2-C01 — Data reliability contract | **MODIFY** | Contract the canonical Direct Entry → report projection, revisions, coverage, source cutoff, reconciliation and restore. Define generic ingestion clauses only for a source accepted by N01/Owner. |
| P2-W02 — Master data and organization history | **MODIFY** | Reuse P1.6 `recruiters`, `teams`, project IDs, aliases and effective memberships. Reconcile historical attribution; do not create a second recruiter/team model or take on P3 role/scope policy. |
| P2-W03 — Registry, staging, audit and DB boundary | **MODIFY** | P1.6 already has transaction, audit, revisions, idempotency and authorization boundaries. Add only the minimum reporting lineage/reconciliation or approved external-source boundary; avoid parallel audit or a generic raw store without need. |
| P2-N02 — Dynamic-source dispatcher and worker | **NOT_APPLICABLE** | The scheduled/dynamic dispatcher for Sheets as the ongoing recruitment authority is no longer applicable. Re-open only if N01 and the Owner identify a supported non-legacy external feed. |
| P2-N03 — Full/incremental sync and reconciliation | **MODIFY** | Sheet full/incremental ingestion is not applicable. Keep reconciliation and controlled cutover as core P2 work; source-specific sync code is conditional on an approved retained external feed. |
| P2-N04 — Retry, quarantine and replay | **DEFER** | Defer generic n8n ingestion retry/quarantine/replay until N01 finds an approved ingestion source. Do not duplicate P1.6 upload recovery, idempotency, OCC or change-request flows. |
| P2-W04 — Reporting consistency and aggregation | **KEEP** | Critical: the P1 reporting service still reads `daily_recruitment_breakdown`, while P1.6 writes detailed Direct Entry entities. Prove one revision-consistent reporting surface and a no-double-count cutover. |
| P2-W05 — Minimum operations UI | **MODIFY** | Prioritize Direct Entry/report freshness, reconciliation and sanitized upload/job state. Show source/run/error controls only for retained pipelines; preserve capability-gated access and PII minimization. |
| P2-N05 — Monitoring and alerts | **DEFER** | Defer n8n scheduled-ingestion monitors while WF01 is Draft/manual and unscheduled. W05/W06 still define appropriate application/report-health signals; add n8n alerting only for a retained, approved workflow and authorized recipients. |
| P2-W06 — Access and capacity checks | **KEEP** | Validate existing Direct Entry and reporting boundaries, rates, pagination, throughput and storage against Owner-approved workloads. Do not rebuild P1.6 Auth/RLS or implement full P3 RBAC. |
| P2-W07 — DB backup/restore and P1→P2 transition | **KEEP** | Required for live Direct Entry data. Include database plus separate object-storage recovery and a no-PROD-write restore drill; define measured RPO/RTO with the Owner. |
| P2-N06 — Workflow and credential recovery | **MODIFY** | Recover only n8n workflows retained for an approved use. WF01 JSON is not a Git artifact and workflow export is not credential backup. If no P2 n8n workflow remains, close this as not needed after inventory rather than creating workflow infrastructure. |
| P2-J01 — Reliability and regression acceptance | **KEEP** | Test canonical/report reconciliation, corrections, duplicate prevention, access controls, failure recovery and restore for the selected P2 scope. |
| P2-W08 / P2-N07 — Final handoff and P3 inputs | **MODIFY** | WEB hands off canonical IDs/history, report revisions, coverage/freshness, grants and known gaps. N8N contributes only if a retained workflow/source exists; otherwise record that no ingestion handoff is required. |

## Gate and execution order

P1.7 remains responsible for the spreadsheet-like input UX; it does not alter
data authority. Per the P1.7 scope, no P2 implementation starts before
`P1.7-J01` Owner Production acceptance.

Immediately after that gate, start:

1. **P2-W01** — verify the post-release production baseline and compare actual
   canonical/detail counts with report/read-model counts.
2. **P2-N01** — inventory retained legacy source IDs and identify whether any
   non-Sheet source truly needs continued ingestion.
3. **P2-C01** — draft in parallel; freeze its source-specific contract after
   W01/N01 and Owner decisions.

Then pass G1 before W02/W03 change the data boundary. W04 follows the agreed
contract and must own the reporting cutover. N02–N06 are not an assumed
parallel build lane: start only the rows whose source/workflow is accepted.
W06/W07 and J01 close the chosen platform scope.

## Inputs P2 must hand to P3

- Stable `app_user_id`, recruiter/team/project identifiers and verified
  employee/account links; do not re-key P1.6 users.
- Effective-dated recruiter-provider and recruiter-team memberships, valid
  intervals, attribution rules and any unresolved legacy crosswalk/quarantine.
- Existing capability/scope-grant and audit vocabulary, with clear boundaries
  between business report access and operator/source/raw access.
- Canonical Direct Entry lifecycle/revision semantics and report projection
  contract, including publish revision, cutoff, coverage and freshness.
- Current RLS/grants/server boundaries, migrations, regression evidence,
  recovery procedures, measured operating limits and accepted known gaps.
- No P2-created BoD/Leader/Staff role model. P3 decides role/scope policy on
  the reused identity and effective-history foundation.

## Owner decisions required before G1

1. Confirm the current `data_sources` state and which of the 30 sources
   observed at I06 represent retained legacy report facts versus active input.
2. Set the exact historical cutoff and approve the independent expected-total
   reconciliation before any source is retired.
3. Decide whether post-P1.6 Direct Entry records exist now and authorize only
   a read-only count/sample sufficient to plan reporting cutover.
4. Confirm whether any non-Sheet external ingestion is still required.
5. Set retention, RPO/RTO, monitoring thresholds, alert channel and recipient
   permissions before enabling operational workflows.

Until those decisions are evidenced, classify source coverage as unknown;
do not invent a completed import, deactivate sources, or treat old aggregate
facts as duplicate-free Direct Entry records.

## Evidence basis

- [P1.6 J01 final closure](../handoffs/p1.6-j01-final-closure.md) — phase verdict, release provenance and Owner-accepted deferred items.
- [P1.6 I06 Production acceptance](../handoffs/p1.6-i04c3-i06-production-ui-r2-acceptance.md) — owner-attested flow, reporting fingerprint and point-in-time counts.
- [P1.7 scope at commit `0f3487d`](../P1.7.md) — grid work and the J01 prerequisite for P2.
- [P2 original task plan](../P2.md) and [master plan](../master-plan.md) — source task definitions and architecture.
- [Direct Entry foundation migration](../../supabase/migrations/20261002170000_p1_6_direct_entry_foundation.sql) and the P1.6 migration chain — current transactional tables/boundaries.
- [P1 reporting service](../../src/lib/reporting/p1-reporting-server.ts) — current aggregate read path.
- [Daily recruitment breakdown contract](../contracts/daily-recruitment-breakdown-v0.2.md) — legacy Sheet aggregate grain and source semantics.
- [n8n WF01 runbook](../../automation/n8n/docs/p0-t2-wf01-runbook.md) and [n8n README](../../automation/n8n/README.md) — workflow state and export boundary.
