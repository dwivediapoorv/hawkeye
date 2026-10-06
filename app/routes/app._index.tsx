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
import type { Finding } from "../services/structured-data.server";
import {
  DESCRIPTION_MAX_LENGTH,
  ITEMS_PAGE_SIZE,
  SCAN_STALE_AFTER_MS,
  TITLE_MAX_LENGTH,
} from "../seo/limits";

type ResourceFilter = "all" | "PRODUCT" | "COLLECTION";
type IssueFilter = "all" | "title" | "description" | "missing" | "duplicate";

const ISSUE_WHERE: Record<Exclude<IssueFilter, "all">, Record<string, boolean>> = {
  title: { titleTooLong: true },
  description: { descriptionTooLong: true },
  missing: { descriptionMissing: true },
  duplicate: { titleDuplicate: true },
};

const PAGE_TYPE_ORDER = { HOME: 0, PRODUCT: 1, COLLECTION: 2 } as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let scan = await getLatestScan(shop);
  // Only clean up when the latest scan looks abandoned, rather than on every poll.
  if (
    scan?.status === "RUNNING" &&
    Date.now() - new Date(scan.startedAt).getTime() > SCAN_STALE_AFTER_MS
  ) {
    await failStaleScans(shop);
    scan = await getLatestScan(shop);
  }

  const url = new URL(request.url);
  const type = (url.searchParams.get("type") || "all") as ResourceFilter;
  const issue = (url.searchParams.get("issue") || "all") as IssueFilter;
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  if (!scan) {
    return { scan: null, items: [], total: 0, schemaChecks: [], page, type, issue };
  }

  const where = {
    scanId: scan.id,
    ...(type !== "all" ? { resourceType: type } : {}),
    ...(issue !== "all" ? ISSUE_WHERE[issue] : {}),
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
    items,
    total,
    schemaChecks: schemaChecks.map((c) => ({
      ...c,
      schemaTypes: c.schemaTypes as string[],
      findings: c.findings as Finding[],
    })),
    page,
    type,
    issue,
  };
};

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

export default function Index() {
  const { scan, items, total, schemaChecks, page, type, issue } =
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

  // Poll while a scan is in progress so the counters and table fill in live.
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
  const schemaDone = scan?.status === "COMPLETED";
  // Issues found so far are real, but "All good" only holds once the scan has finished.
  const issueStatus = (count: number): StatStatus =>
    count
      ? { tone: "critical", text: "Needs attention" }
      : schemaDone
        ? { tone: "success", text: "All good" }
        : { text: isRunning ? "Checking…" : "Incomplete" };
  const schemaStatus: StatStatus = scan?.storefrontBlocked
    ? { tone: "warning", text: "Not checked" }
    : schemaDone
      ? issueStatus(scan?.schemaIssueCount ?? 0)
      : { text: isRunning ? "Waiting" : "Not checked" };

  return (
    <s-page heading="Hawk Eye" inlineSize="large">
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

      {!scan && !showProgress && (
        <s-section>
          <ScanIntro
            heading="Scan your store for SEO issues"
            onScan={runScan}
            disabled={busy}
          >
            The scan reads every active product and collection and flags meta
            titles longer than {TITLE_MAX_LENGTH} characters, meta descriptions
            longer than {DESCRIPTION_MAX_LENGTH} characters, missing
            descriptions and duplicate titles. It also checks the structured
            data (schema.org JSON-LD) your storefront pages render.
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
              <Stat
                label="Long titles"
                caption={`Over ${TITLE_MAX_LENGTH} characters`}
                value={scan.longTitleCount}
                status={issueStatus(scan.longTitleCount)}
              />
              <Stat
                label="Long descriptions"
                caption={`Over ${DESCRIPTION_MAX_LENGTH} characters`}
                value={scan.longDescriptionCount}
                status={issueStatus(scan.longDescriptionCount)}
              />
              <Stat
                label="Missing descriptions"
                caption="No SEO or body text"
                value={scan.missingDescriptionCount}
                status={issueStatus(scan.missingDescriptionCount)}
              />
              <Stat
                label="Duplicate titles"
                caption="Shared by 2+ pages"
                value={scan.duplicateTitleCount}
                status={issueStatus(scan.duplicateTitleCount)}
              />
              <Stat
                label="Schema issues"
                caption={
                  scan.storefrontBlocked
                    ? "Storefront is locked"
                    : schemaDone
                      ? `${schemaChecks.length} pages sampled`
                      : "Checked after the catalog"
                }
                value={scan.schemaIssueCount}
                status={schemaStatus}
              />
            </s-grid>
          </s-stack>
        </s-section>
      )}

      {scan && !showProgress && (
        <s-section heading="Meta tag issues">
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
              <s-option value="title">Title too long</s-option>
              <s-option value="description">Description too long</s-option>
              <s-option value="missing">Description missing</s-option>
              <s-option value="duplicate">Duplicate title</s-option>
            </s-select>
            <s-text color="subdued">
              {total} {total === 1 ? "item" : "items"}
            </s-text>
          </s-stack>

          {items.length === 0 ? (
            <s-box padding="large">
              <s-paragraph>
                {isRunning
                  ? "No issues found yet."
                  : schemaDone
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
                <s-table-header></s-table-header>
              </s-table-header-row>
              <s-table-body>
                {items.map((item) => (
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
                        isDefault={item.titleIsDefault}
                        extra={item.titleDuplicate ? "Duplicate" : undefined}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <MetaValue
                        value={item.metaDescription}
                        length={item.descriptionLength}
                        max={DESCRIPTION_MAX_LENGTH}
                        tooLong={item.descriptionTooLong}
                        isDefault={item.descriptionIsDefault}
                        missing={item.descriptionMissing}
                      />
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
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      )}

      {scan && !showProgress && (
        <s-section heading="Structured data">
          {scan.storefrontBlocked ? (
            <s-banner heading="Storefront is password protected" tone="warning">
              <s-paragraph>
                Structured data can only be checked on pages search engines
                can reach. Turn off the password under{" "}
                <s-text type="strong">Online Store → Preferences</s-text> and
                run the scan again.
              </s-paragraph>
            </s-banner>
          ) : !schemaDone ? (
            <s-box padding="large">
              <s-paragraph>
                {isRunning
                  ? "Structured data is checked once products and collections have been read."
                  : "Structured data was not checked. Run the scan again."}
              </s-paragraph>
            </s-box>
          ) : (
            <>
              <s-paragraph>
                <s-text color="subdued">
                  Checked on the homepage and a sample of product and collection
                  pages. Schema comes from the theme, so one page of each type
                  represents all of them.
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
                            {check.pageType === "HOME"
                              ? "Homepage"
                              : `${PAGE_TYPE_LABEL[check.pageType]}: ${check.label}`}
                          </s-text>
                          <s-link href={check.url} target="_blank">
                            View page
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
                        {check.schemaTypes.length ? (
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
                                <s-text>{f.message}</s-text>
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
  value: number;
  status: StatStatus;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-text type="strong">{label}</s-text>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <span style={{ fontSize: "22px", fontWeight: 650, lineHeight: 1.2 }}>
            {value.toLocaleString()}
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
  isDefault,
  missing,
  extra,
}: {
  value: string;
  length: number;
  max: number;
  tooLong: boolean;
  isDefault: boolean;
  missing?: boolean;
  extra?: string;
}) {
  const preview = value.length > 120 ? `${value.slice(0, 120)}…` : value;
  return (
    <s-stack direction="block" gap="small-200">
      <s-stack direction="inline" gap="small-200">
        {missing ? (
          <s-badge tone="critical">Missing</s-badge>
        ) : (
          <s-badge tone={tooLong ? "critical" : "success"}>
            {length} / {max}
          </s-badge>
        )}
        {isDefault && !missing && <s-badge tone="warning">Default</s-badge>}
        {extra && <s-badge tone="critical">{extra}</s-badge>}
      </s-stack>
      <s-text color="subdued">{preview || "—"}</s-text>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
