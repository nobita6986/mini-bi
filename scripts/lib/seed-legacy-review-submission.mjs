export async function seedLegacyReviewSubmission(db, submissionId) {
  let restoreDeferredConstraints = false;
  try {
    await db.exec("set constraints all immediate");
    restoreDeferredConstraints = true;
  } catch (error) {
    if (error?.code !== "25P01") throw error;
  }
  let triggerDisabled = false;
  try {
    await db.exec(
      "alter table public.direct_entry_submissions disable trigger direct_entry_submission_transition",
    );
    triggerDisabled = true;
    await db.query(
      "update public.direct_entry_submissions set state='REVIEW', version=version+1" +
      " where submission_id=$1 and state='DRAFT'",
      [submissionId],
    );
  } finally {
    if (triggerDisabled) {
      await db.exec(
        "alter table public.direct_entry_submissions enable trigger direct_entry_submission_transition",
      );
    }
    if (restoreDeferredConstraints) await db.exec("set constraints all deferred");
  }
}
