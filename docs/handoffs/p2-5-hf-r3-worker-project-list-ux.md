# P2.5-HF-R3 — Worker/Project list UX (UI-only)

**Status:** `P2.5-HF-R3_WORKER_PROJECT_LIST_UX_LOCAL_PASS_AWAITING_T0_REVIEW`

Base `origin/main@1b7fc983d974b6706ce9c14b526d039fc2addf87`. UI-only, song song backend T1B: khong
sua migration/API/RPC/authorization/dependency. Ledger van 56; slot #57 de trong cho T0.

## Delta

**1 — "Yeu cau thay doi" len TRUOC danh sach NLD.** `worker-operations.tsx` render
`DirectEntryChangeRequestList` dung MOT lan, truoc `<section role="tabpanel">`, chi khi `canReview`.
Khong tao hang doi "yeu cau thay doi du an" gia: backend chua co contract do.

**2 — Regression tuong tac (nut du an + Lam viec/Nghi viec).** Them
`p2-5-hf-r3-worker-project-interaction.test.mjs` (9 test): cuc tinh nut tren dong
(`project.active ? "Ngừng" : "Kích hoạt"` -> `openDialog({active: !project_active})` ->
`submitSetActive(dialog.active)` -> body dung 4 key `{active, reason, expected_version,
idempotency_key}`); ly do + OCC bat buoc; option o chon = `allowedWorkStatusTargets`
(UNCONFIRMED->ON|OFF, ON->OFF, OFF->ON); Nghi viec bat buoc `leave_reason`, Lam viec KHONG gui
`leave_reason`; proposal qua dung validator create contract; mutation-check FAIL 1/9 ca hai chieu.

**3 — Bo cau hua ve quyen.** Hint tab `all` khong con "chi admin va BoD/Ke toan co quyen pham vi
toan bo"; khong thay bang loi hua quyen khac — quyen do server quyet dinh.

**4 — Mau trang thai.** `infoClass` (sky) = loading/empty, `successClass` (emerald) = thanh cong,
`errorClass` (do) = error/denied/unavailable; empty khong con doc thanh "thanh cong".

**5 — Phan trang + loc (giu nguyen, deu server-side that).** Danh sach NLD: keyset cursor "Tai them"
+ loc `employment_status` do server thuc thi, reset cursor khi doi tab/loc. Danh sach du an: loc chi
de trinh bay tren TOAN BO danh sach (RPC tra het, khong cursor); metric header khong bi loc.

**Contract backend con thieu (bao cao, khong doan):** phan trang danh sach du an —
`direct_entry_list_projects_admin(...)` khong co cursor/page_size. Loc `project_id`/`recruiter_id`
tren worker directory: contract nhan nhung reviewer khong co nguon option —
`direct_entry_input_catalog` doi `entry_create|entry_own`; `direct_entry_list_projects_admin` va
`manager-candidates` doi `entry_admin + all`.

## Gates — `p2.5-w06` 55/55 · `p2.5-w03` 22/22 · `p2.5-w02` 23/23 · `s04c-s02a` 26/26 ·
`s04c-s02b` 27/27 · `app-nav-02a` 92/92 · `test:server` 209/209 — 0 fail; `pnpm typecheck` 0 ·
`pnpm lint` 0 error (12 warning co san) · `pnpm build` PASS · `git diff --check` PASS; khong merge/deploy.
