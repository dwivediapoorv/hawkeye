import { authenticate } from "../shopify.server";
import db from "../db.server";
import { failStaleScans, getLatestScan, startScan } from "./seo-scan.server";
import type { Finding } from "./storefront-checks.server";
import { ITEMS_PAGE_SIZE, SCAN_STALE_AFTER_MS } from "../seo/limits";
import {
  ISSUE_GROUPS,
  isIssueCode,
  type IssueCode,
  type IssueCounts,
  type IssueGroupKey,
} from "../seo/issues";

// Shared by every dashboard layout (classic, simple, tabs, visual).

export type ResourceFilter = "all" | "PRODUCT" | "COLLECTION";
export type IssueFilter = "all" | IssueCode;
// "meta" covers both title and description issues.
export type GroupFilter = "all" | IssueGroupKey | "meta";

// These issues have their own boolean columns, which scans made before the
// `issues` list existed also have, so filtering on them works for every scan.
const LEGACY_ISSUE_WHERE: Partial<Record<IssueCode, Record<string, boolean>>> = {
  TITLE_LONG: { titleTooLong: true },
  TITLE_DUPLICATE: { titleDuplicate: true },
  DESCRIPTION_LONG: { descriptionTooLong: true },
  DESCRIPTION_MISSING: { descriptionMissing: true },
};

const issueWhere = (code: IssueCode) => LEGACY_ISSUE_WHERE[code] ?? { issues: { has: code } };

export const groupCodes = (group: GroupFilter): IssueCode[] =>
  group === "all"
    ? []
    : group === "meta"
      ? ISSUE_GROUPS.filter((g) => g.key === "titles" || g.key === "descriptions").flatMap((g) => g.codes)
      : (ISSUE_GROUPS.find((g) => g.key === group)?.codes ?? []);

const PAGE_TYPE_ORDER = { SITE: 0, HOME: 1, PRODUCT: 2, COLLECTION: 3 } as const;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;
const GROUP_FILTERS: GroupFilter[] = ["titles", "descriptions", "content", "images", "structure", "meta"];

export async function loadDashboard(request: Request) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let scan = await getLatestScan(shop);
  // Only clean up when the latest scan has stopped reporting progress, rather than on every poll.
  if (
    scan?.status === "RUNNING" &&
    Date.now() - new Date(scan.updatedAt).getTime() > SCAN_STALE_AFTER_MS
  ) {
    await failStaleScans(shop);
    scan = await getLatestScan(shop);
  }

  const url = new URL(request.url);
  const typeParam = url.searchParams.get("type");
  const type: ResourceFilter =
    typeParam === "PRODUCT" || typeParam === "COLLECTION" ? typeParam : "all";
  const issueParam = url.searchParams.get("issue") ?? "";
  const issue: IssueFilter = isIssueCode(issueParam) ? issueParam : "all";
  const groupParam = url.searchParams.get("group") as GroupFilter;
  const group: GroupFilter = GROUP_FILTERS.includes(groupParam) ? groupParam : "all";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  if (!scan) {
    return {
      scan: null,
      items: [],
      total: 0,
      flaggedTotal: 0,
      schemaChecks: [],
      groupCounts: null,
      page,
      type,
      issue,
      group,
    };
  }

  const issueFilter =
    issue !== "all"
      ? issueWhere(issue)
      : group !== "all"
        ? { OR: groupCodes(group).map(issueWhere) }
        : {};
  const where = {
    scanId: scan.id,
    ...(type !== "all" ? { resourceType: type } : {}),
    ...issueFilter,
  };

  const [total, flaggedTotal, items, schemaChecks] = await Promise.all([
    db.scanItem.count({ where }),
    db.scanItem.count({ where: { scanId: scan.id } }),
    db.scanItem.findMany({
      where,
      orderBy: [{ resourceType: "asc" }, { name: "asc" }],
      skip: (page - 1) * ITEMS_PAGE_SIZE,
      take: ITEMS_PAGE_SIZE,
    }),
    db.schemaCheck.findMany({ where: { scanId: scan.id } }),
  ]);

  schemaChecks.sort(
    (a, b) =>
      PAGE_TYPE_ORDER[a.pageType as keyof typeof PAGE_TYPE_ORDER] -
        PAGE_TYPE_ORDER[b.pageType as keyof typeof PAGE_TYPE_ORDER] ||
      a.label.localeCompare(b.label),
  );

  return {
    scan,
    items: items.map((item) => ({ ...item, issues: item.issues.filter(isIssueCode) })),
    total,
    flaggedTotal,
    schemaChecks: schemaChecks.map((c) => ({
      ...c,
      schemaTypes: c.schemaTypes as string[],
      findings: (c.findings as Finding[])
        .slice()
        .sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]),
    })),
    groupCounts: await groupCountsFor(scan, scan.issueCounts as Partial<IssueCounts>),
    page,
    type,
    issue,
    group,
  };
}

export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;

// Items per issue group and per issue code. Scans made before the image,
// content and URL checks existed only have the meta tag counts; their other
// groups are absent (shown as "not checked").
async function groupCountsFor(
  scan: {
    id: string;
    longTitleCount: number;
    longDescriptionCount: number;
    missingDescriptionCount: number;
    duplicateTitleCount: number;
  },
  counts: Partial<IssueCounts>,
) {
  if (counts.groups && counts.codes) {
    // A group with no issues may be absent on scans saved before every group was recorded.
    const groups = Object.fromEntries(
      ISSUE_GROUPS.map((g) => [g.key, counts.groups?.[g.key] ?? 0]),
    ) as Partial<Record<IssueGroupKey, number>>;
    return { legacy: false, groups, codes: counts.codes };
  }
  const [titles, descriptions] = await Promise.all([
    db.scanItem.count({ where: { scanId: scan.id, OR: [{ titleTooLong: true }, { titleDuplicate: true }] } }),
    db.scanItem.count({ where: { scanId: scan.id, OR: [{ descriptionTooLong: true }, { descriptionMissing: true }] } }),
  ]);
  return {
    legacy: true,
    groups: { titles, descriptions } as Partial<Record<IssueGroupKey, number>>,
    codes: {
      TITLE_LONG: scan.longTitleCount,
      TITLE_DUPLICATE: scan.duplicateTitleCount,
      DESCRIPTION_LONG: scan.longDescriptionCount,
      DESCRIPTION_MISSING: scan.missingDescriptionCount,
    } as Partial<Record<IssueCode, number>>,
  };
}

export async function scanAction(request: Request) {
  const { admin, session } = await authenticate.admin(request);
  const scan = await startScan(session.shop, admin.graphql);
  return scan
    ? { started: true as const }
    : { started: false as const, error: "A scan is already running." };
}
