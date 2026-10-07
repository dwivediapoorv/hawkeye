import { useSearchParams } from "react-router";
import type { DashboardData } from "../../services/dashboard.server";
import type { Category } from "../../services/storefront-checks.server";
import { DESCRIPTION_MAX_LENGTH, ITEMS_PAGE_SIZE, TITLE_MAX_LENGTH } from "../../seo/limits";
import { ISSUE_GROUPS, ISSUE_INFO, type IssueCode } from "../../seo/issues";

// Building blocks shared by the dashboard layouts.

type Scan = NonNullable<DashboardData["scan"]>;
type Item = DashboardData["items"][number];

// gid://shopify/Product/123 -> 123
const numericId = (gid: string) => gid.split("/").pop();

export const adminUrl = (resourceType: string, resourceId: string) =>
  `shopify://admin/${resourceType === "PRODUCT" ? "products" : "collections"}/${numericId(resourceId)}`;

export const formatDate = (value: string | Date) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const PAGE_TYPE_LABEL: Record<string, string> = {
  HOME: "Homepage",
  PRODUCT: "Product",
  COLLECTION: "Collection",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  schema: "Structured data",
  indexing: "Indexing",
  headings: "Headings",
  social: "Social sharing",
  images: "Images",
  links: "Links",
  site: "Site",
};

export type StatStatus = { tone?: "critical" | "success" | "warning"; text: string };

// "All good" only holds once the scan has finished; issues found so far are real.
export function issueStatus(scan: Scan, count: number): StatStatus {
  if (count) return { tone: "critical", text: "Needs attention" };
  return scan.status === "COMPLETED" ? { tone: "success", text: "All good" } : { text: "Incomplete" };
}

export function pagesStatus(scan: Scan): StatStatus {
  if (scan.storefrontBlocked) return { tone: "warning", text: "Not checked" };
  if (scan.status !== "COMPLETED") return { text: "Not checked" };
  return issueStatus(scan, scan.schemaIssueCount);
}

// "3 too long · 1 duplicate", or `fallback` when nothing was found.
export function breakdown(data: DashboardData, codes: IssueCode[], fallback: string) {
  const parts = codes
    .filter((code) => data.groupCounts?.codes[code])
    .map((code) => `${data.groupCounts?.codes[code]} ${ISSUE_INFO[code].short}`);
  return parts.length ? parts.join(" · ") : fallback;
}

export function scanSummaryLine(scan: Scan) {
  const when =
    scan.status === "COMPLETED" ? `Completed ${formatDate(scan.completedAt!)}` : `Started ${formatDate(scan.startedAt)}`;
  const products = `${scan.productCount.toLocaleString()} ${scan.productCount === 1 ? "product" : "products"}`;
  const collections = `${scan.collectionCount.toLocaleString()} ${scan.collectionCount === 1 ? "collection" : "collections"}`;
  return `${when} · ${products} and ${collections} scanned`;
}

export function Stat({
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

export function SummaryTiles({ data }: { data: DashboardData }) {
  const scan = data.scan!;
  return (
    <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
      {ISSUE_GROUPS.map((group) => {
        const value = data.groupCounts?.groups[group.key];
        return (
          <Stat
            key={group.key}
            label={group.label}
            caption={value === undefined ? "Run a new scan" : breakdown(data, group.codes, group.caption)}
            value={value ?? null}
            status={value === undefined ? { text: "Not checked" } : issueStatus(scan, value)}
          />
        );
      })}
      <Stat
        label="Storefront pages"
        caption={
          scan.storefrontBlocked
            ? "Storefront is locked"
            : scan.status === "COMPLETED"
              ? `${data.schemaChecks.filter((c) => c.pageType !== "SITE").length} pages, robots.txt & sitemap`
              : "Not checked"
        }
        value={scan.storefrontBlocked ? null : scan.schemaIssueCount}
        status={pagesStatus(scan)}
      />
    </s-grid>
  );
}

export function MetaValue({
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

type IssueBadge = { tone: "critical" | "warning"; text: string };

// Badges for the image, content and URL issues of one item.
export function otherIssueBadges(item: Item, only?: IssueCode[]): IssueBadge[] {
  const has = (code: IssueCode) => item.issues.includes(code) && (!only || only.includes(code));
  const badges: IssueBadge[] = [];
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

function BadgeList({ badges }: { badges: IssueBadge[] }) {
  if (!badges.length) return <s-text color="subdued">—</s-text>;
  return (
    <s-stack direction="block" gap="small-200">
      {badges.map((b) => (
        <s-stack key={b.text} direction="inline">
          <s-badge tone={b.tone}>{b.text}</s-badge>
        </s-stack>
      ))}
    </s-stack>
  );
}

// Which columns the issues table shows: everything, or one area's details.
export type TableView = "all" | "meta" | "content" | "images" | "structure";

const VIEW_CODES: Record<TableView, IssueCode[]> = {
  all: ISSUE_GROUPS.flatMap((g) => g.codes),
  meta: ISSUE_GROUPS.filter((g) => g.key === "titles" || g.key === "descriptions").flatMap((g) => g.codes),
  content: ["THIN_CONTENT", "COPIED_CONTENT"],
  images: ["MISSING_ALT", "IMAGE_FILENAMES"],
  structure: ["HANDLE", "EMPTY_COLLECTION", "NO_COLLECTION"],
};

// Filterable, paginated table of flagged products and collections.
export function IssuesTable({ data, view = "all" }: { data: DashboardData; view?: TableView }) {
  const { items, total, page, type, issue } = data;
  const [searchParams, setSearchParams] = useSearchParams();
  const codes = VIEW_CODES[view];
  const groups = ISSUE_GROUPS.map((g) => ({ ...g, codes: g.codes.filter((c) => codes.includes(c)) })).filter(
    (g) => g.codes.length,
  );

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
  const pageCount = Math.max(1, Math.ceil(total / ITEMS_PAGE_SIZE));
  const done = data.scan?.status === "COMPLETED";

  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="base" alignItems="end">
        <s-select label="Type" value={type} onChange={(e) => setFilter("type", e.currentTarget.value)}>
          <s-option value="all">Products and collections</s-option>
          <s-option value="PRODUCT">Products</s-option>
          <s-option value="COLLECTION">Collections</s-option>
        </s-select>
        <s-select label="Issue" value={issue} onChange={(e) => setFilter("issue", e.currentTarget.value)}>
          <s-option value="all">Any issue</s-option>
          {groups.map((group) => (
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
            {done
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
            {(view === "all" || view === "meta") && (
              <>
                <s-table-header>Meta title</s-table-header>
                <s-table-header>Meta description</s-table-header>
              </>
            )}
            {view === "content" && <s-table-header>Words</s-table-header>}
            {view === "images" && <s-table-header>Images</s-table-header>}
            {view === "structure" && <s-table-header>URL handle</s-table-header>}
            {view !== "meta" && <s-table-header>{view === "all" ? "Other issues" : "Issues"}</s-table-header>}
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {items.map((item) => (
              <s-table-row key={item.id}>
                <s-table-cell>
                  <s-text type="strong">{item.name}</s-text>
                </s-table-cell>
                <s-table-cell>
                  <s-badge>{item.resourceType === "PRODUCT" ? "Product" : "Collection"}</s-badge>
                </s-table-cell>
                {(view === "all" || view === "meta") && (
                  <>
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
                  </>
                )}
                {view === "content" && (
                  <s-table-cell>{item.wordCount === null ? "—" : item.wordCount.toLocaleString()}</s-table-cell>
                )}
                {view === "images" && <s-table-cell>{item.imageCount}</s-table-cell>}
                {view === "structure" && (
                  <s-table-cell>
                    <s-text color="subdued">/{item.handle}</s-text>
                  </s-table-cell>
                )}
                {view !== "meta" && (
                  <s-table-cell>
                    <BadgeList badges={otherIssueBadges(item, view === "all" ? undefined : codes)} />
                  </s-table-cell>
                )}
                <s-table-cell>
                  <s-link href={adminUrl(item.resourceType, item.resourceId)} target="_top">
                    Edit
                  </s-link>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}
    </s-stack>
  );
}

const severityTone = (severity: string) =>
  severity === "error" ? "critical" : severity === "warning" ? "warning" : "info";
const severityLabel = (severity: string) =>
  severity === "error" ? "Error" : severity === "warning" ? "Warning" : "Tip";

export function pageLabel(check: { pageType: string; label: string }) {
  return check.pageType === "HOME" || check.pageType === "SITE"
    ? check.label
    : `${PAGE_TYPE_LABEL[check.pageType]}: ${check.label}`;
}

// Per-page findings from the storefront checks.
export function StorefrontTable({ data }: { data: DashboardData }) {
  const scan = data.scan!;
  if (scan.storefrontBlocked) {
    return (
      <s-banner heading="Storefront is password protected" tone="warning">
        <s-paragraph>
          Storefront pages can only be checked when search engines can reach
          them. Turn off the password under{" "}
          <s-text type="strong">Online Store → Preferences</s-text> and run the
          scan again.
        </s-paragraph>
      </s-banner>
    );
  }
  if (scan.status !== "COMPLETED") {
    return (
      <s-box padding="large">
        <s-paragraph>Storefront pages were not checked. Run the scan again.</s-paragraph>
      </s-box>
    );
  }
  return (
    <s-stack direction="block" gap="base">
      <s-text color="subdued">
        Checked on the homepage and a sample of product and collection pages,
        plus your robots.txt and sitemap. Most of this comes from the theme, so
        one page of each type usually represents all of them.
      </s-text>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Page</s-table-header>
          <s-table-header listSlot="secondary">Status</s-table-header>
          <s-table-header>Schema found</s-table-header>
          <s-table-header>Findings</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {data.schemaChecks.map((check) => (
            <s-table-row key={check.id}>
              <s-table-cell>
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">{pageLabel(check)}</s-text>
                  <s-link href={check.url} target="_blank">
                    {check.pageType === "SITE" ? "View sitemap" : "View page"}
                  </s-link>
                </s-stack>
              </s-table-cell>
              <s-table-cell>
                <s-badge
                  tone={check.status === "OK" ? "success" : check.status === "FAILED" ? "critical" : "warning"}
                >
                  {check.status === "OK" ? "OK" : check.status === "FAILED" ? "Not checked" : "Needs attention"}
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
                        <s-badge tone={severityTone(f.severity)}>{severityLabel(f.severity)}</s-badge>
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
    </s-stack>
  );
}
