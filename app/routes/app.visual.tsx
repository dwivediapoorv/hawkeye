import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { loadDashboard, scanAction, type DashboardData } from "../services/dashboard.server";
import { ScanShell } from "../components/dashboard/ScanShell";
import {
  IssuesTable,
  StorefrontTable,
  breakdown,
  scanSummaryLine,
  type TableView,
} from "../components/dashboard/parts";
import { ISSUE_GROUPS, type IssueGroupKey } from "../seo/issues";
import styles from "../components/dashboard/Visual.module.css";

// Visual layout: an SEO health score, one card per area (clicking a card
// filters the table below), then the details.

export const loader = ({ request }: LoaderFunctionArgs) => loadDashboard(request);
export const action = ({ request }: ActionFunctionArgs) => scanAction(request);

const ICONS = {
  titles: "text-title",
  descriptions: "text-block",
  content: "page",
  images: "image-alt",
  structure: "link",
  storefront: "store-online",
} as const satisfies Record<IssueGroupKey | "storefront", string>;

const VIEW_FOR: Record<IssueGroupKey, TableView> = {
  titles: "meta",
  descriptions: "meta",
  content: "content",
  images: "images",
  structure: "structure",
};

// Share of the catalog with no issues (70%) and of storefront pages that pass (30%).
// When pages weren't checked, the score is the catalog share alone.
function healthScore(data: DashboardData) {
  const scan = data.scan!;
  const catalog = scan.productCount + scan.collectionCount;
  const catalogClean = catalog ? Math.max(0, catalog - data.flaggedTotal) / catalog : 1;
  const pages = data.schemaChecks.filter((c) => c.pageType !== "SITE" && c.status !== "FAILED");
  const pagesClean = pages.length ? pages.filter((c) => c.status === "OK").length / pages.length : null;
  const score = pagesClean === null ? catalogClean : 0.7 * catalogClean + 0.3 * pagesClean;
  return {
    score: Math.round(score * 100),
    catalog,
    catalogClean: catalog - data.flaggedTotal,
    pages: pages.length,
    pagesClean: pages.filter((c) => c.status === "OK").length,
  };
}

const rating = (score: number) =>
  score >= 80
    ? { tone: "success" as const, text: "Good" }
    : score >= 50
      ? { tone: "warning" as const, text: "Needs work" }
      : { tone: "critical" as const, text: "Poor" };

export default function VisualDashboard() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get("group");

  const select = (key: string) => {
    const next = new URLSearchParams();
    if (key !== selected) next.set("group", key);
    setSearchParams(next);
  };

  if (!data.scan) return <ScanShell data={data}>{null}</ScanShell>;

  const scan = data.scan;
  const health = healthScore(data);
  const label = rating(health.score);
  const done = scan.status === "COMPLETED";
  const selectedGroup = ISSUE_GROUPS.find((g) => g.key === selected);

  return (
    <ScanShell data={data}>
      <s-section>
        <div className={styles.score}>
          <div>
            <span className={styles.scoreNumber}>{health.score}</span>
            <span className={styles.scoreOutOf}> / 100</span>
          </div>
          <div className={styles.scoreBody}>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text type="strong">SEO health</s-text>
              <s-badge tone={label.tone}>{label.text}</s-badge>
            </s-stack>
            <div className={styles.bar}>
              <div className={styles.fill} style={{ width: `${health.score}%` }} />
            </div>
            <s-text color="subdued">
              {health.catalogClean} of {health.catalog} products and collections have no issues
              {health.pages > 0 && ` · ${health.pagesClean} of ${health.pages} storefront pages pass`}
            </s-text>
            <s-text color="subdued">{scanSummaryLine(scan)}</s-text>
          </div>
        </div>
      </s-section>

      <s-section>
        <div className={styles.cards}>
          {ISSUE_GROUPS.map((group) => {
            const count = data.groupCounts?.groups[group.key];
            const clean = count === undefined || !health.catalog ? null : 1 - count / health.catalog;
            return (
              <button
                key={group.key}
                type="button"
                className={`${styles.card} ${selected === group.key ? styles.active : ""}`}
                onClick={() => select(group.key)}
                aria-pressed={selected === group.key}
              >
                <span className={styles.cardTop}>
                  <s-icon type={ICONS[group.key]} />
                  {group.label}
                </span>
                <span className={styles.cardCount}>{count ?? "—"}</span>
                <div className={styles.miniBar}>
                  <div className={styles.fill} style={{ width: `${Math.round((clean ?? 0) * 100)}%` }} />
                </div>
                <span className={styles.cardCaption}>
                  {count === undefined ? "Run a new scan" : breakdown(data, group.codes, done ? "All good" : group.caption)}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            className={`${styles.card} ${selected === "storefront" ? styles.active : ""}`}
            onClick={() => select("storefront")}
            aria-pressed={selected === "storefront"}
          >
            <span className={styles.cardTop}>
              <s-icon type={ICONS.storefront} />
              Storefront pages
            </span>
            <span className={styles.cardCount}>{scan.storefrontBlocked ? "—" : scan.schemaIssueCount}</span>
            <div className={styles.miniBar}>
              <div
                className={styles.fill}
                style={{ width: `${health.pages ? Math.round((health.pagesClean / health.pages) * 100) : 0}%` }}
              />
            </div>
            <span className={styles.cardCaption}>
              {scan.storefrontBlocked ? "Storefront is locked" : "Checks with issues"}
            </span>
          </button>
        </div>
      </s-section>

      {selected === "storefront" ? (
        <s-section heading="Storefront pages">
          <StorefrontTable data={data} />
        </s-section>
      ) : (
        <>
          <s-section heading={selectedGroup ? selectedGroup.label : "All issues"}>
            <IssuesTable data={data} view={selectedGroup ? VIEW_FOR[selectedGroup.key] : "all"} />
          </s-section>
          {!selectedGroup && (
            <s-section heading="Storefront pages">
              <StorefrontTable data={data} />
            </s-section>
          )}
        </>
      )}
    </ScanShell>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
