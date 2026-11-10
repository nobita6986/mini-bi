import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { RecruitmentPostCardViewModel } from "@/lib/recruitment-posts/recruitment-post-ui-model";

export function RecruitmentPostCard({
  card,
  onViewDetail,
  onExport,
  isExporting = false,
  onWithdraw,
}: {
  card: RecruitmentPostCardViewModel;
  onViewDetail: (briefId: string) => void;
  onExport?: (briefId: string) => void;
  isExporting?: boolean;
  onWithdraw?: (card: RecruitmentPostCardViewModel) => void;
}) {
  return (
    <Card className="flex flex-col gap-4 rounded-xl p-4 sm:p-5">
      <div
        data-testid={`recruitment-post-card-${card.briefId}`}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="text-base font-semibold text-foreground sm:text-lg break-words">
              {card.projectName}
            </h2>
            <p className="text-xs sm:text-sm text-muted break-words">
              <span className="font-medium text-foreground">Khách hàng:</span>{" "}
              {card.customerNameDisplay}
            </p>
            <p className="text-xs sm:text-sm text-muted break-words">
              <span className="font-medium text-foreground">Địa điểm:</span>{" "}
              {card.locationDisplay}
            </p>
          </div>
          <div
            data-testid="recruitment-post-card-actions"
            className="flex shrink-0 flex-wrap items-center gap-2 pt-1 sm:pt-0"
          >
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid={`recruitment-post-view-detail-${card.briefId}`}
              onClick={() => onViewDetail(card.briefId)}
            >
              Xem chi tiết
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="recruitment-post-export"
              data-brief-id={card.briefId}
              disabled={isExporting}
              onClick={() => onExport?.(card.briefId)}
            >
              {isExporting ? "Đang xuất…" : "Xuất bản tin"}
            </Button>
            {card.allowedActions.canEdit ? (
              <Link
                href={`/recruitment-posts/${encodeURIComponent(card.briefId)}/edit`}
                data-testid={`recruitment-post-edit-${card.briefId}`}
                className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Sửa
              </Link>
            ) : null}
            {card.allowedActions.canWithdraw && onWithdraw ? (
              <Button
                type="button"
                variant="danger"
                size="sm"
                data-testid={`recruitment-post-withdraw-${card.briefId}`}
                onClick={() => onWithdraw(card)}
              >
                Rút tin
              </Button>
            ) : null}
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium text-muted">Công việc</p>
          <p className="text-sm text-foreground whitespace-pre-line break-words line-clamp-3">
            {card.jobDescriptionDisplay}
          </p>
        </div>

        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div className="min-w-0 space-y-0.5">
            <dt className="text-xs font-medium text-muted">Hình thức tuyển</dt>
            <dd className="text-foreground break-words">
              {card.laborTypesDisplay}
            </dd>
          </div>

          <div className="min-w-0 space-y-0.5">
            <dt className="text-xs font-medium text-muted">
              Số lượng dự kiến
            </dt>
            <dd className="font-mono tabular-nums text-foreground">
              {card.expectedHeadcountDisplay}
            </dd>
          </div>

          <div className="min-w-0 space-y-0.5">
            <dt className="text-xs font-medium text-muted">
              Giới tính &amp; độ tuổi
            </dt>
            <dd className="text-foreground break-words">
              {card.genderAndAgeDisplay}
            </dd>
          </div>

          <div className="min-w-0 space-y-0.5 sm:col-span-2">
            <dt className="text-xs font-medium text-muted">
              Lương cơ bản &amp; thu nhập dự kiến
            </dt>
            <dd className="font-mono tabular-nums text-foreground break-words">
              {card.baseSalaryAndIncomeDisplay}
            </dd>
          </div>

          <div className="min-w-0 space-y-0.5">
            <dt className="text-xs font-medium text-muted">
              Người phụ trách &amp; điện thoại
            </dt>
            <dd className="text-foreground break-words">
              {card.managerContactDisplay}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5 text-xs text-muted">
          <span>
            Người đăng &amp; cập nhật gần nhất: {card.createdByAndUpdatedAtDisplay}
          </span>
        </div>
      </div>
    </Card>
  );
}
