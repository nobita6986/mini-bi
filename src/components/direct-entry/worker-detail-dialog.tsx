"use client";

/**
 * W2S1 - Hop thoai chi tiet NLĐ dung chung, mo tu danh sach NLĐ.
 *
 * - MOT Radix Dialog duy nhat cho moi danh sach (recruited/managed/all); khong tao
 *   route/page chi tiet thu hai. Mobile: `styles.documentsDialog` chuyen toan chieu rong.
 * - Du lieu lay tu dung hai nguon server da phan quyen: row cua worker directory
 *   (`WorkerDirectoryRow`) va projection entry detail (`worker_portrait`). UI KHONG suy
 *   quyen tu tab/role, khong tu ghep du lieu, khong tu tinh lai so lieu.
 * - PII/payment/document duoc redaction doc lap boi server; o day chi hien thi dung
 *   nhung gi server tra ve (redacted => ghi ro "an theo quyen").
 * - Anh ho so: upload/xem qua pipeline WORKER_PORTRAIT + private preview route.
 * - CCCD/hop dong: chi hien thi tinh trang va dung luong quan ly tai lieu hien co;
 *   KHONG dung portrait preview cho CCCD, khong tu tao endpoint. Phan xem truoc CCCD
 *   chua kha dung cho den khi contract preview rieng duoc duyet.
 */

import { Fragment, useEffect, useState } from "react";
import { Dialog } from "radix-ui";

import type { WorkerDirectoryRow } from "@/lib/direct-entry/worker-directory-contract";
import {
  fetchWorkerDetail,
  workerDocumentReady,
  workerDocumentStatusLabel,
  type WorkerDetailDocument,
  type WorkerDetailDocumentType,
  type WorkerDetailProjection,
} from "@/lib/direct-entry/worker-detail-projection";
import {
  DOCUMENT_TYPE_LABELS,
  PAYMENT_STATE_LABELS,
} from "@/lib/direct-entry/change-request-read-projection";
import { genderUiLabel } from "@/lib/direct-entry/display-labels";
import {
  bankAccountSummary,
  lastDecisionLabel,
  pendingRequestLabel,
  workerStatusLabel,
} from "@/lib/direct-entry/worker-operations-model";
import { WorkerPortraitPanel } from "./worker-portrait-panel";
import styles from "./direct-entry-shell.module.css";

const DOCUMENT_ORDER: readonly WorkerDetailDocumentType[] = [
  "CCCD_FRONT", "CCCD_BACK", "EMPLOYMENT_CONTRACT",
];

export const WORKER_DETAIL_PREVIEW_PENDING_NOTE =
  "Xem ảnh CCCD và hợp đồng chưa khả dụng: đang chờ contract xem trước riêng do T1B rà soát và T0 duyệt. " +
  "Khi cần thay tài liệu, dùng luồng quản lý tài liệu hiện có.";

export const WORKER_DETAIL_LOAD_FAILED_MESSAGE = "Không tải được chi tiết người lao động.";

const PAYMENT_STATE_FALLBACK = "Không xác định";

function paymentStateLabel(state: string): string {
  return (PAYMENT_STATE_LABELS as Readonly<Record<string, string>>)[state] ?? PAYMENT_STATE_FALLBACK;
}

function fieldValue(value: string | null): string {
  return value === null || value.trim() === "" ? "Chưa khai báo" : value;
}

function latestByType(
  documents: readonly WorkerDetailDocument[],
  type: WorkerDetailDocumentType,
): WorkerDetailDocument | null {
  let latest: WorkerDetailDocument | null = null;
  for (const document of documents) {
    if (document.document_type !== type) continue;
    if (latest === null || document.version > latest.version) latest = document;
  }
  return latest;
}

export type WorkerDetailDialogProps = {
  row: WorkerDirectoryRow | null;
  onOpenChange(open: boolean): void;
  /** Capability `document_upload` cua actor server-resolved. */
  canUploadDocuments: boolean;
  /** Tra focus ve nut da mo dialog khi dong (Radix khong tu lam khi khong dung Trigger). */
  openerRef?: { current: HTMLElement | null };
};

export function WorkerDetailDialog({
  row,
  onOpenChange,
  canUploadDocuments,
  openerRef,
}: WorkerDetailDialogProps) {
  const open = row !== null;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.drawerOverlay} />
        {open && row ? (
          <Dialog.Content
            className={styles.documentsDialog}
            data-testid="worker-detail-dialog"
            aria-describedby="worker-detail-description"
            onCloseAutoFocus={(event) => {
              if (openerRef?.current) {
                event.preventDefault();
                openerRef.current.focus();
              }
            }}>
            <div className={styles.documentsDialogHeader}>
              <Dialog.Title className={styles.drawerTitle}>
                Chi tiết người lao động — {row.display_name}
              </Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className={styles.secondaryButton}>Đóng</button>
              </Dialog.Close>
            </div>
            <Dialog.Description id="worker-detail-description" className={styles.drawerDescription}>
              Mã do máy chủ cấp: <strong>{row.employee_code}</strong>. Mọi nhóm dữ liệu bên dưới
              {" "}chỉ hiển thị theo quyền và phạm vi máy chủ xác nhận; khóa lưu trữ và liên kết
              {" "}ký dài hạn không bao giờ hiển thị trên UI hay log.
            </Dialog.Description>
            <WorkerDetailBody key={row.entry_id} row={row} canUploadDocuments={canUploadDocuments} />
            <div className={styles.drawerActions}>
              <Dialog.Close asChild>
                <button type="button" className={styles.secondaryButton}>Đóng</button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        ) : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function WorkerDetailBody({
  row,
  canUploadDocuments,
}: {
  row: WorkerDirectoryRow;
  canUploadDocuments: boolean;
}) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [detail, setDetail] = useState<WorkerDetailProjection | null>(null);
  const [entryVersion, setEntryVersion] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchWorkerDetail(row.entry_id, fetch).then((projection) => {
      if (cancelled) return;
      if (projection === null) {
        setState("error");
        return;
      }
      setDetail(projection);
      setEntryVersion(projection.entryVersion);
      setState("ready");
    });
    return () => { cancelled = true; };
  }, [row.entry_id, reloadKey]);

  if (state === "loading") {
    return <p role="status" className={styles.documentStatus}>Đang tải chi tiết người lao động…</p>;
  }
  if (state === "error" || detail === null) {
    return (
      <div role="alert" className={styles.documentError}>
        <p>{WORKER_DETAIL_LOAD_FAILED_MESSAGE}</p>
        <button type="button" className={styles.secondaryButton}
          onClick={() => { setState("loading"); setReloadKey((value) => value + 1); }}>
          Thử lại
        </button>
      </div>
    );
  }

  const bank = bankAccountSummary(row.payment);
  return (
    <div className={styles.drawerFields}>
      <section className={styles.documentSection} aria-labelledby="worker-detail-person">
        <h3 className={styles.documentTitle} id="worker-detail-person">Thông tin người lao động</h3>
        {detail.worker.kind === "redacted" ? (
          <p className={styles.documentStatus} role="status">
            Thông tin cá nhân (CCCD, ngày sinh, địa chỉ, điện thoại) được ẩn theo quyền
            {" "}truy cập PII.
          </p>
        ) : (
          <dl className={styles.profileFieldList}>
            <dt>Họ tên</dt>
            <dd>{detail.worker.display_name}</dd>
            <dt>Giới tính</dt>
            <dd>{genderUiLabel(detail.worker.gender) || "Chưa khai báo"}</dd>
            <dt>Ngày sinh</dt>
            <dd>{fieldValue(detail.worker.date_of_birth)}</dd>
            <dt>CCCD</dt>
            <dd>{fieldValue(detail.worker.national_id)}</dd>
            <dt>Ngày cấp</dt>
            <dd>{fieldValue(detail.worker.national_id_issued_at)}</dd>
            <dt>Nơi cấp</dt>
            <dd>{fieldValue(detail.worker.national_id_issued_place)}</dd>
            <dt>Địa chỉ</dt>
            <dd>{fieldValue(detail.worker.address)}</dd>
            <dt>Số điện thoại</dt>
            <dd>{fieldValue(detail.worker.phone)}</dd>
          </dl>
        )}
      </section>

      <section className={styles.documentSection} aria-labelledby="worker-detail-job">
        <h3 className={styles.documentTitle} id="worker-detail-job">Công việc và dự án</h3>
        <dl className={styles.profileFieldList}>
          <dt>Dự án</dt>
          <dd>{row.project_display}</dd>
          <dt>Ngày bắt đầu làm việc</dt>
          <dd>{row.first_work_date}</dd>
          <dt>Loại hình lao động</dt>
          <dd>{row.labor_type_display}</dd>
          <dt>Người tuyển / nhà cung cấp</dt>
          <dd>{row.recruiter_display + " · " + detail.providerLabel}</dd>
          <dt>Trạng thái làm việc</dt>
          <dd>{workerStatusLabel(detail.employment.status) +
            " (hiệu lực " + detail.employment.effective_date + ")"}</dd>
        </dl>
      </section>

      <section className={styles.documentSection} aria-labelledby="worker-detail-payment">
        <h3 className={styles.documentTitle} id="worker-detail-payment">Thanh toán</h3>
        {bank === null ? (
          <p className={styles.documentStatus} role="status">
            Không có thông tin thanh toán trong phạm vi được xem.
          </p>
        ) : (
          <dl className={styles.profileFieldList}>
            <dt>Trạng thái</dt>
            <dd>{paymentStateLabel(bank.state)}</dd>
            <dt>Số tài khoản</dt>
            <dd>{fieldValue(bank.accountNumber)}</dd>
            <dt>Ngân hàng</dt>
            <dd>{fieldValue(bank.bankId)}</dd>
            <dt>Chủ tài khoản</dt>
            <dd>{fieldValue(bank.accountHolder)}</dd>
          </dl>
        )}
      </section>

      <section className={styles.documentSection} aria-labelledby="worker-detail-changes">
        <h3 className={styles.documentTitle} id="worker-detail-changes">Thay đổi gần nhất</h3>
        {pendingRequestLabel(row) === null && lastDecisionLabel(row) === null ? (
          <p className={styles.documentStatus} role="status">
            Không có yêu cầu thay đổi đang chờ và chưa có quyết định nào.
          </p>
        ) : (
          <dl className={styles.profileFieldList}>
            <dt>Yêu cầu đang chờ</dt>
            <dd>{pendingRequestLabel(row) ?? "Không có"}</dd>
            <dt>Quyết định gần nhất</dt>
            <dd>{lastDecisionLabel(row) ?? "Chưa có"}</dd>
          </dl>
        )}
      </section>

      <WorkerPortraitPanel
        entryId={detail.entryId}
        entryVersion={entryVersion ?? detail.entryVersion}
        portrait={detail.portrait}
        canUpload={canUploadDocuments}
        requireReason
        onEntryVersionChange={(version) => setEntryVersion(version)}
        onPortraitChanged={() => setReloadKey((value) => value + 1)}
      />

      <section className={styles.documentSection} aria-labelledby="worker-detail-documents">
        <h3 className={styles.documentTitle} id="worker-detail-documents">
          Tình trạng từng loại hồ sơ
        </h3>
        <dl className={styles.profileFieldList}>
          {DOCUMENT_ORDER.map((type) => {
            const document = latestByType(detail.documents, type);
            return (
              <Fragment key={type}>
                <dt>{DOCUMENT_TYPE_LABELS[type]}</dt>
                <dd>
                  {document === null
                    ? "Chưa có hồ sơ"
                    : (workerDocumentReady(document) ? "Đã có · " : "Chưa sẵn sàng · ") +
                      workerDocumentStatusLabel(document.upload_status) +
                      " · v" + document.version}
                </dd>
              </Fragment>
            );
          })}
        </dl>
        <p className={styles.profileNote}>{WORKER_DETAIL_PREVIEW_PENDING_NOTE}</p>
      </section>
    </div>
  );
}
