/**
 * P1.5-W02 — Barrel cho identity/membership projection contract.
 * Không chứa logic; chỉ re-export.
 */

export * from "./contracts";
export {
  buildIdentityQualityIssues,
  buildIdentityRefMap,
  buildTeamCoverage,
  projectIdentity,
  resolveIdentityFacts,
  resolveRefForDisplay,
} from "./projection";
