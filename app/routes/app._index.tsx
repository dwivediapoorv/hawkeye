import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ScanIntro, ScanProgress } from "../components/ScanHero";
import {
  failStaleScans,
  getLatestScan,
  startScan,
} from "../services/seo-scan.server";
import type { Category, Finding } from "../services/storefront-checks.server";
import {
  DESCRIPTION_MAX_LENGTH,
  ITEMS_PAGE_SIZE,
  SCAN_STALE_AFTER_MS,
  TITLE_MAX_LENGTH,
} from "../seo/limits";
import {
  ISSUE_GROUPS,
  ISSUE_INFO,
  isIssueCode,
  type IssueCode,
  type IssueCounts,
  type IssueGroupKey,
} from "../seo/issues";

type ResourceFilter = "all" | "PRODUCT" | "COLLECTION";
type IssueFilter = "all" | IssueCode;

// These issues have their own boolean columns, which scans made before the
// `issues` list existed also have, so filtering on them works for every scan.
const LEGACY_ISSUE_WHERE: Partial<Record<IssueCode, Record<string, boolean>>> = {
  TITLE_LONG: { titleTooLong: true },
  TITLE_DUPLICATE: { titleDuplicate: true },
  DESCRIPTION_LONG: { descriptionTooLong: true },
  DESCRIPTION_MISSING: { descriptionMissing: true },
};

const PAGE_TYPE_ORDER = { SITE: 0, HOME: 1, PRODUCT: 2, COLLECTION: 3 } as const;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
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
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  if (!scan) {
    return { scan: null, items: [], total: 0, schemaChecks: [], groupCounts: null, page, type, issue };
  }

  const where = {
    scanId: scan.id,
    ...(type !== "all" ? { resourceType: type } : {}),
    ...(issue !== "all" ? (LEGACY_ISSUE_WHERE[issue] ?? { issues: { has: issue } }) : {}),
  };

  const [total, items, schemaChecks] = await Promise.all([
    db.scanItem.count({ where }),
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
    schemaChecks: schemaChecks.map((c) => ({
      ...c,
      schemaTypes: c.schemaTypes as string[],
      findings: (c.findings as Finding[])
        .slice()
        .sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]),
    })),
    groupCounts: await groupCountsFor(scan.id, scan.issueCounts as Partial<IssueCounts>),
    page,
    type,
    issue,
  };
};

// Items per issue group for the summary tiles. Scans made before the image,
// content and URL checks existed only have the meta tag counts (null = not checked).
async function groupCountsFor(scanId: string, counts: Partial<IssueCounts>) {
  if (counts.groups && counts.codes) {
    // A group with no issues may be absent on scans saved before every group was recorded.
    const groups = Object.fromEntries(
      ISSUE_GROUPS.map((g) => [g.key, counts.groups?.[g.key] ?? 0]),
    ) as Partial<Record<IssueGroupKey, number>>;
    return { legacy: false, groups, codes: counts.codes };
  }
  const [titles, descriptions] = await Promise.all([
    db.scanItem.count({ where: { scanId, OR: [{ titleTooLong: true }, { titleDuplicate: true }] } }),
    db.scanItem.count({ where: { scanId, OR: [{ descriptionTooLong: true }, { descriptionMissing: true }] } }),
  ]);
  return {
    legacy: true,
    groups: { titles, descriptions } as Partial<Record<IssueGroupKey, number>>,
    codes: {} as Partial<Record<IssueCode, number>>,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const scan = await startScan(session.shop, admin.graphql);
  return scan
    ? { started: true as const }
    : { started: false as const, error: "A scan is already running." };
};

// gid://shopify/Product/123 -> 123
const numericId = (gid: string) => gid.split("/").pop();

const adminUrl = (resourceType: string, resourceId: string) =>
  `shopify://admin/${resourceType === "PRODUCT" ? "products" : "collections"}/${numericId(resourceId)}`;

const formatDate = (value: string | Date) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

const PAGE_TYPE_LABEL: Record<string, string> = {
  HOME: "Homepage",
  PRODUCT: "Product",
  COLLECTION: "Collection",
};

const CATEGORY_LABEL: Record<Category, string> = {
  schema: "Structured data",
  indexing: "Indexing",
  headings: "Headings",
  social: "Social sharing",
  images: "Images",
  links: "Links",
  site: "Site",
};

type ScanProgressFields = {
  productCount: number;
  collectionCount: number;
  productTotal: number | null;
  collectionTotal: number | null;
  pagesChecked: number;
  pagesTotal: number | null;
};

// Reading the catalog fills the bar to 80%; checking storefront pages fills the rest.
const CATALOG_SHARE = 0.8;

function scanProgress(
  scan: ScanProgressFields | null,
  finished: boolean,
): { value: number; label: string } {
  if (finished) return { value: 1, label: "Scan complete" };
  if (!scan || scan.productTotal === null || scan.collectionTotal === null) {
    return { value: 0, label: "Initializing…" };
  }
  if (scan.pagesTotal !== null) {
    return {
      value: CATALOG_SHARE + (1 - CATALOG_SHARE) * (scan.pagesChecked / Math.max(1, scan.pagesTotal)),
      label: `Checking storefront pages · ${scan.pagesChecked} of ${scan.pagesTotal}`,
    };
  }
  const read = scan.productCount + scan.collectionCount;
  const value = CATALOG_SHARE * Math.min(1, read / Math.max(1, scan.productTotal + scan.collectionTotal));
  if (scan.productCount < scan.productTotal) {
    return { value, label: `Reading products · ${scan.productCount} of ${scan.productTotal}` };
  }
  if (scan.collectionCount < scan.collectionTotal) {
    return { value, label: `Reading collections · ${scan.collectionCount} of ${scan.collectionTotal}` };
  }
  return { value, label: "Checking storefront pages…" };
}

// Badge text for the image, content and URL issues in the "Other issues" column.
type IssueItem = {
  resourceType: string;
  issues: IssueCode[];
  imageCount: number;
  imagesMissingAlt: number;
  badImageNames: number;
  wordCount: number | null;
  handleIssue: string | null;
};

function otherIssueBadges(item: IssueItem): { tone: "critical" | "warning"; text: string }[] {
  const has = (code: IssueCode) => item.issues.includes(code);
  const badges: { tone: "critical" | "warning"; text: string }[] = [];
  if (has("THIN_CONTENT")) badges.push({ tone: "warning", text: `Thin content · ${item.wordCount ?? 0} words` });
  if (has("COPIED_CONTENT")) badges.push({ tone: "critical", text: "Copied description" });
  if (has("MISSING_ALT")) {
    badges.push({
      tone: "critical",
      text:
        item.resourceType === "COLLECTION"
          ? "Image missing alt text"
          : `${item.imagesMissingAlt} of ${item.imageCount} images missing alt text`,
    });
  }
  if (has("IMAGE_FILENAMES")) {
    badges.push({
      tone: "warning",
      text: `${item.badImageNames} camera-style image ${item.badImageNames === 1 ? "name" : "names"}`,
    });
  }
  if (has("HANDLE")) badges.push({ tone: "warning", text: `URL ${item.handleIssue ?? "needs attention"}` });
  if (has("EMPTY_COLLECTION")) badges.push({ tone: "critical", text: "Empty collection" });
  if (has("NO_COLLECTION")) badges.push({ tone: "warning", text: "Not in any collection" });
  return badges;
}

export default function Index() {
  const { scan, items, total, schemaChecks, groupCounts, page, type, issue } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const shopify = useAppBridge();

  const isRunning = scan?.status === "RUNNING";
  const isStarting =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";
  const busy = isRunning || isStarting;

  // When a scan finishes, hold the bar at 100% for a moment before the results appear.
  const [finishing, setFinishing] = useState(false);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && scan?.status === "COMPLETED") setFinishing(true);
    wasBusy.current = busy;
  }, [busy, scan?.status]);
  useEffect(() => {
    if (!finishing) return;
    const timer = setTimeout(() => setFinishing(false), 2200);
    return () => clearTimeout(timer);
  }, [finishing]);

  const showProgress = busy || finishing;

  // Poll while a scan is in progress so the progress bar moves.
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2000);
    return () => clearInterval(interval);
  }, [isRunning, revalidator]);

  useEffect(() => {
    if (fetcher.data && !fetcher.data.started) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete(key);
    else next.set(key, value);
    next.delete("page");
    setSearchParams(next);
  };

  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete("page");
    else next.set("page", String(nextPage));
    setSearchParams(next);
  };

  const runScan = () => fetcher.submit({}, { method: "POST" });
  const busyProps = busy ? { loading: true, disabled: true } : {};

  const pageCount = Math.max(1, Math.ceil(total / ITEMS_PAGE_SIZE));
  const scanDone = scan?.status === "COMPLETED";
  // Issues found so far are real, but "All good" only holds once the scan has finished.
  const issueStatus = (count: number): StatStatus =>
    count
      ? { tone: "critical", text: "Needs attention" }
      : scanDone
        ? { tone: "success", text: "All good" }
        : { text: isRunning ? "Checking…" : "Incomplete" };
  const pagesStatus: StatStatus = scan?.storefrontBlocked
    ? { tone: "warning", text: "Not checked" }
    : scanDone
      ? issueStatus(scan?.schemaIssueCount ?? 0)
      : { text: isRunning ? "Waiting" : "Not checked" };

  // "3 too long · 1 duplicate", or the group's description when nothing was found.
  const breakdown = (codes: IssueCode[], fallback: string) => {
    const parts = codes
      .filter((code) => groupCounts?.codes[code])
      .map((code) => `${groupCounts?.codes[code]} ${ISSUE_INFO[code].short}`);
    return parts.length ? parts.join(" · ") : fallback;
  };

  return (
    <s-page heading="Hawkeye" inlineSize="large">
      {/* The empty state and the progress bar have their own scan control. */}
      {scan && !showProgress && (
        <s-button slot="primary-action" onClick={runScan} {...busyProps}>
          Run scan again
        </s-button>
      )}

      {showProgress && (
        <s-section>
          <ScanProgress {...scanProgress(isRunning || finishing ? scan : null, finishing)} />
        </s-section>
      )}

      {scan?.status === "FAILED" && !showProgress && (
        <s-banner heading="The last scan failed" tone="critical">
          <s-paragraph>{scan.error ?? "Unknown error."}</s-paragraph>
        </s-banner>
      )}

      {groupCounts?.legacy && !showProgress && (
        <s-banner heading="Hawk Eye checks more now" tone="info">
          <s-paragraph>
            Run a new scan to check image alt text, thin and copied content,
            URLs, and indexing, headings, social tags and broken links on your
            storefront pages.
          </s-paragraph>
        </s-banner>
      )}

      {!scan && !showProgress && (
        <s-section>
          <ScanIntro
            heading="Scan your store for SEO issues"
            onScan={runScan}
            disabled={busy}
          >
            The scan reads every active product and collection and checks meta
            titles and descriptions, image alt text, content and URLs. It also
            checks your live storefront pages for indexing problems,
            structured data, headings, social sharing tags, slow images and
            broken links.
          </ScanIntro>
        </s-section>
      )}

      {scan && !showProgress && (
        <s-section heading="Summary">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              {scan.status === "COMPLETED"
                ? `Completed ${formatDate(scan.completedAt!)}`
                : `Started ${formatDate(scan.startedAt)}`}
              {" · "}
              {scan.productCount.toLocaleString()}{" "}
              {scan.productCount === 1 ? "product" : "products"} and{" "}
              {scan.collectionCount.toLocaleString()}{" "}
              {scan.collectionCount === 1 ? "collection" : "collections"} scanned
            </s-text>
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))"
              gap="base"
            >
              {ISSUE_GROUPS.map((group) => {
                const value = groupCounts?.groups[group.key];
                return (
                  <Stat
                    key={group.key}
                    label={group.label}
                    caption={value === undefined ? "Run a new scan" : breakdown(group.codes, group.caption)}
                    value={value ?? null}
                    status={value === undefined ? { text: "Not checked" } : issueStatus(value)}
                  />
                );
              })}
              <Stat
                label="Storefront pages"
                caption={
                  scan.storefrontBlocked
                    ? "Storefront is locked"
                    : scanDone
                      ? `${schemaChecks.filter((c) => c.pageType !== "SITE").length} pages, robots.txt & sitemap`
                      : "Checked after the catalog"
                }
                value={scan.storefrontBlocked ? null : scan.schemaIssueCount}
                status={pagesStatus}
              />
            </s-grid>
          </s-stack>
        </s-section>
      )}

      {scan && !showProgress && (
        <s-section heading="Products & collections">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-select
              label="Type"
              value={type}
              onChange={(e) => setFilter("type", e.currentTarget.value)}
            >
              <s-option value="all">Products and collections</s-option>
              <s-option value="PRODUCT">Products</s-option>
              <s-option value="COLLECTION">Collections</s-option>
            </s-select>
            <s-select
              label="Issue"
              value={issue}
              onChange={(e) => setFilter("issue", e.currentTarget.value)}
            >
              <s-option value="all">Any issue</s-option>
              {ISSUE_GROUPS.map((group) => (
                <s-option-group key={group.key} label={group.label}>
                  {group.codes.map((code) => (
                    <s-option key={code} value={code}>
                      {ISSUE_INFO[code].label}
                    </s-option>
                  ))}
                </s-option-group>
              ))}
            </s-select>
            <s-text color="subdued">
              {total} {total === 1 ? "item" : "items"}
            </s-text>
          </s-stack>

          {items.length === 0 ? (
            <s-box padding="large">
              <s-paragraph>
                {scanDone
                  ? "No issues match these filters. 🎉"
                  : "No issues were found before the scan stopped. Run it again for complete results."}
              </s-paragraph>
            </s-box>
          ) : (
            <s-table
              paginate
              hasNextPage={page < pageCount}
              hasPreviousPage={page > 1}
              onNextPage={() => setPage(page + 1)}
              onPreviousPage={() => setPage(page - 1)}
            >
              <s-table-header-row>
                <s-table-header listSlot="primary">Name</s-table-header>
                <s-table-header listSlot="secondary">Type</s-table-header>
                <s-table-header>Meta title</s-table-header>
                <s-table-header>Meta description</s-table-header>
                <s-table-header>Other issues</s-table-header>
                <s-table-header></s-table-header>
              </s-table-header-row>
              <s-table-body>
                {items.map((item) => {
                  const others = otherIssueBadges(item);
                  return (
                    <s-table-row key={item.id}>
                      <s-table-cell>
                        <s-text type="strong">{item.name}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge>
                          {item.resourceType === "PRODUCT" ? "Product" : "Collection"}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <MetaValue
                          value={item.metaTitle}
                          length={item.titleLength}
                          max={TITLE_MAX_LENGTH}
                          tooLong={item.titleTooLong}
                          tooShort={item.issues.includes("TITLE_SHORT")}
                          isDefault={item.titleIsDefault}
                          duplicate={item.titleDuplicate}
                        />
                      </s-table-cell>
                      <s-table-cell>
                        <MetaValue
                          value={item.metaDescription}
                          length={item.descriptionLength}
                          max={DESCRIPTION_MAX_LENGTH}
                          tooLong={item.descriptionTooLong}
                          tooShort={item.issues.includes("DESCRIPTION_SHORT")}
                          isDefault={item.descriptionIsDefault}
                          missing={item.descriptionMissing}
                          duplicate={item.issues.includes("DESCRIPTION_DUPLICATE")}
                        />
                      </s-table-cell>
                      <s-table-cell>
                        {others.length ? (
                          <s-stack direction="block" gap="small-200">
                            {others.map((b) => (
                              <s-stack key={b.text} direction="inline">
                                <s-badge tone={b.tone}>{b.text}</s-badge>
                              </s-stack>
                            ))}
                          </s-stack>
                        ) : (
                          <s-text color="subdued">—</s-text>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        <s-link
                          href={adminUrl(item.resourceType, item.resourceId)}
                          target="_top"
                        >
                          Edit
                        </s-link>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      )}

      {scan && !showProgress && (
        <s-section heading="Storefront pages">
          {scan.storefrontBlocked ? (
            <s-banner heading="Storefront is password protected" tone="warning">
              <s-paragraph>
                Storefront pages can only be checked when search engines can
                reach them. Turn off the password under{" "}
                <s-text type="strong">Online Store → Preferences</s-text> and
                run the scan again.
              </s-paragraph>
            </s-banner>
          ) : !scanDone ? (
            <s-box padding="large">
              <s-paragraph>Storefront pages were not checked. Run the scan again.</s-paragraph>
            </s-box>
          ) : (
            <>
              <s-paragraph>
                <s-text color="subdued">
                  Checked on the homepage and a sample of product and collection
                  pages, plus your robots.txt and sitemap. Most of this comes
                  from the theme, so one page of each type usually represents
                  all of them.
                </s-text>
              </s-paragraph>
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Page</s-table-header>
                  <s-table-header listSlot="secondary">Status</s-table-header>
                  <s-table-header>Schema found</s-table-header>
                  <s-table-header>Findings</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {schemaChecks.map((check) => (
                    <s-table-row key={check.id}>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-200">
                          <s-text type="strong">
                            {check.pageType === "HOME" || check.pageType === "SITE"
                              ? check.label
                              : `${PAGE_TYPE_LABEL[check.pageType]}: ${check.label}`}
                          </s-text>
                          <s-link href={check.url} target="_blank">
                            {check.pageType === "SITE" ? "View sitemap" : "View page"}
                          </s-link>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge
                          tone={
                            check.status === "OK"
                              ? "success"
                              : check.status === "FAILED"
                                ? "critical"
                                : "warning"
                          }
                        >
                          {check.status === "OK"
                            ? "OK"
                            : check.status === "FAILED"
                              ? "Not checked"
                              : "Needs attention"}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        {check.pageType === "SITE" ? (
                          <s-text color="subdued">—</s-text>
                        ) : check.schemaTypes.length ? (
                          <s-stack direction="inline" gap="small-200">
                            {check.schemaTypes.map((t) => (
                              <s-badge key={t}>{t}</s-badge>
                            ))}
                          </s-stack>
                        ) : (
                          <s-text color="subdued">None</s-text>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {check.findings.length ? (
                          <s-stack direction="block" gap="small-200">
                            {check.findings.map((f, i) => (
                              <s-stack key={i} direction="inline" gap="small-200">
                                <s-badge
                                  tone={
                                    f.severity === "error"
                                      ? "critical"
                                      : f.severity === "warning"
                                        ? "warning"
                                        : "info"
                                  }
                                >
                                  {f.severity === "error"
                                    ? "Error"
                                    : f.severity === "warning"
                                      ? "Warning"
                                      : "Tip"}
                                </s-badge>
                                <s-text>
                                  {f.category ? `${CATEGORY_LABEL[f.category]}: ` : ""}
                                  {f.message}
                                </s-text>
                              </s-stack>
                            ))}
                          </s-stack>
                        ) : (
                          <s-text color="subdued">No issues</s-text>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </>
          )}
        </s-section>
      )}
    </s-page>
  );
}

type StatStatus = { tone?: "critical" | "success" | "warning"; text: string };

function Stat({
  label,
  caption,
  value,
  status,
}: {
  label: string;
  caption: string;
  value: number | null;
  status: StatStatus;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-text type="strong">{label}</s-text>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <span style={{ fontSize: "22px", fontWeight: 650, lineHeight: 1.2 }}>
            {value === null ? "—" : value.toLocaleString()}
          </span>
          <s-badge {...(status.tone ? { tone: status.tone } : {})}>{status.text}</s-badge>
        </s-stack>
        <s-text color="subdued">{caption}</s-text>
      </s-stack>
    </s-box>
  );
}

function MetaValue({
  value,
  length,
  max,
  tooLong,
  tooShort,
  isDefault,
  missing,
  duplicate,
}: {
  value: string;
  length: number;
  max: number;
  tooLong: boolean;
  tooShort: boolean;
  isDefault: boolean;
  missing?: boolean;
  duplicate: boolean;
}) {
  const preview = value.length > 120 ? `${value.slice(0, 120)}…` : value;
  return (
    <s-stack direction="block" gap="small-200">
      <s-stack direction="inline" gap="small-200">
        {missing ? (
          <s-badge tone="critical">Missing</s-badge>
        ) : (
          <s-badge tone={tooLong ? "critical" : tooShort ? "warning" : "success"}>
            {length} / {max}
          </s-badge>
        )}
        {tooShort && !missing && <s-badge tone="warning">Too short</s-badge>}
        {isDefault && !missing && <s-badge tone="warning">Default</s-badge>}
        {duplicate && <s-badge tone="critical">Duplicate</s-badge>}
      </s-stack>
      <s-text color="subdued">{preview || "—"}</s-text>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
