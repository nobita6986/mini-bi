import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("./personnel-team-membership-manager.tsx", import.meta.url), "utf8");
const personnelManager = readFileSync(new URL("./personnel-catalog-manager.tsx", import.meta.url), "utf8");

test("membership API reads only after opening one selected personnel and never preloads per row", () => {
  assert.match(component, /if \(!personnel\) return;/);
  assert.match(component, /Promise\.all\(STATES\.map\(\(state\) => readMembershipList\(recruiterId, state, 1\)\)\)/);
  assert.match(personnelManager, /setMembershipPersonnel\(personnel\)/);
  assert.doesNotMatch(personnelManager, /api\/admin\/catalog\/team-memberships/);
  assert.doesNotMatch(personnelManager, /list\.personnel\.map[\s\S]{0,700}team-memberships/);
  assert.match(component, /\/api\/admin\/catalog\/team-memberships\?\$\{query\.toString\(\)\}/);
});

test("current, scheduled and history use separate strict bounded reads and pagers", () => {
  assert.match(component, /const STATES: readonly MembershipState\[\] = \["CURRENT", "SCHEDULED", "HISTORY"\]/);
  assert.match(component, /stateLabel\(state\)/);
  assert.match(component, /projectMembershipList\(await response\.json\(\)/);
  assert.match(component, /onPage=\{\(page\) => void loadOneState\(state, page\)\}/);
  assert.match(component, /MEMBERSHIP_PAGE_SIZE/);
  assert.match(component, /readState\.kind === "unauthenticated" \|\| readState\.kind === "denied"/);
  assert.match(component, /readState\.kind === "not-found" \|\| readState\.kind === "unavailable"/);
  assert.match(component, /readState\.kind === "error"/);
  assert.match(component, /list\.memberships\.length === 0/);
});

test("team catalog is strict, active-only and reserved teams are not reconstructed", () => {
  assert.match(component, /\/api\/admin\/catalog\/teams\?\$\{query\.toString\(\)\}/);
  assert.match(component, /projectActiveTeams\(await response\.json\(\), page\)/);
  assert.match(component, /teamState\.teams/);
  assert.match(component, /team\.display_name\} \(\{team\.code\}\)/);
  assert.doesNotMatch(component, /__system_vendor__|Vendor team/i);
});

test("mutations use canonical methods, headers, versioned strict requests and no direct database access", () => {
  assert.match(component, /buildAssignMembershipRequest/);
  assert.match(component, /buildUnassignMembershipRequest/);
  assert.match(component, /method: "POST"/);
  assert.match(component, /"Idempotency-Key": intent\.idempotencyKey/);
  assert.match(component, /const idempotencyKey = newMembershipIntentKey\(\)/);
  assert.match(component, /onClick=\{\(\) => void sendIntent\(pendingIntent\)\}/);
  assert.match(component, /body: JSON\.stringify\(intent\.body\)/);
  assert.match(component, /classifyMembershipMutation/);
  assert.match(component, /expectedVersion: operation\.kind === "move" \? operation\.expectedVersion : personnel\.version/);
  assert.match(component, /expectedVersion: operation\.membership\.recruiter_version/);
  assert.match(component, /if \(outcome\.kind === "conflict"\)/);
  assert.match(component, /if \(locks\.has\(personnel\.recruiter_id\)\)/);
  assert.doesNotMatch(component, /supabase|\.rpc\(|createClient\(|from\(["']recruiter_team_memberships/i);
});

test("successful mutation reloads authoritative detail and each separate list; failed OCC reload retains lock", () => {
  assert.match(component, /refreshAuthoritative\(intent\.recruiterId, requestGeneration\)/);
  assert.match(component, /projectPersonnelItem\(await response\.json\(\)\)/);
  assert.match(component, /Promise\.all\(STATES\.map\(\(state\) => readMembershipList\(recruiterId, state, 1\)\)\)/);
  assert.match(component, /if \(!result\.complete\) throw new Error/);
  assert.match(component, /Không tải đủ dữ liệu có thẩm quyền\. Khóa vẫn được giữ/);
  assert.match(component, /lockEntity\(recruiterId, false\)/);
  assert.match(component, /onCloseAutoFocus=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(personnelManager, /membershipTrigger\.current\?\.focus\(\)/);
});

test("inactive personnel can still close membership, while assign and move require active personnel", () => {
  assert.match(component, /onMove=\{personnel\.active && \(state === "CURRENT" \|\| state === "SCHEDULED"\)/);
  assert.match(component, /onClose=\{state === "CURRENT"/);
  assert.match(component, /onCancelScheduled=\{state === "SCHEDULED"/);
  assert.match(component, /startClose\(membership, false\)/);
  assert.match(component, /startClose\(membership, true\)/);
});

test("UI never displays technical UUIDs and retains accessible state and personnel-create form scope", () => {
  assert.match(component, /<table/);
  assert.match(component, /role="status"/);
  assert.match(component, /role="alert"/);
  assert.doesNotMatch(component, /<td[^>]*>\s*\{membership\.(membership_id|team_id)\}/);
  assert.match(personnelManager, /Quản lý nhóm/);
  assert.doesNotMatch(personnelManager, /label="Mật khẩu"|label="Tài khoản đăng nhập"|label="Nhóm"/i);
});
