import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { loadDashboard, scanAction, type DashboardData } from "../services/dashboard.server";
import { ScanShell } from "../components/dashboard/ScanShell";
import {
  IssuesTable,
  StorefrontTable,
  SummaryTiles,
  scanSummaryLine,
  type TableView,
} from "../components/dashboard/parts";
import { ISSUE_GROUPS, ISSUE_INFO, type IssueCode, type IssueGroupKey } from "../seo/issues";

// Tabs layout: the same data split into one focused screen per area. The
// active tab lives in the `group` URL parameter, which also filters the table.

export const loader = ({ request }: LoaderFunctionArgs) => loadDashboard(request);
export const action = ({ request }: ActionFunctionArgs) => scanAction(request);

type Tab = "overview" | TableView | "storefront";

const TABS: { key: Tab; label: string; groups: IssueGroupKey[] }[] = [
  { key: "overview", label: "Overview", groups: [] },
  { key: "meta", label: "Meta tags", groups: ["titles", "descriptions"] },
  { key: "content", label: "Content", groups: ["content"] },
  { key: "images", label: "Images", groups: ["images"] },
  { key: "structure", label: "URLs & structure", groups: ["structure"] },
  { key: "storefront", label: "Storefront pages", groups: [] },
];

function tabCount(data: DashboardData, tab: (typeof TABS)[number]) {
  if (tab.key === "storefront") return data.scan?.storefrontBlocked ? undefined : data.scan?.schemaIssueCount;
  if (!tab.groups.length) return undefined;
  const counts = tab.groups.map((g) => data.groupCounts?.groups[g]);
  return counts.every((c) => c === undefined) ? undefined : counts.reduce<number>((sum, c) => sum + (c ?? 0), 0);
}

export default function TabsDashboard() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const groupParam = searchParams.get("group");
  const active: Tab = TABS.some((t) => t.key === groupParam) ? (groupParam as Tab) : "overview";

  // Switching tabs resets the table's filters and page.
  const openTab = (key: Tab, issue?: IssueCode) => {
    const next = new URLSearchParams();
    if (key !== "overview") next.set("group", key);
    if (issue) next.set("issue", issue);
    setSearchParams(next);
  };

  // The biggest catalog issues, for the overview.
  const top = Object.entries(data.groupCounts?.codes ?? {})
    .filter(([, n]) => n)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .slice(0, 5) as [IssueCode, number][];
  const tabFor = (code: IssueCode): Tab =>
    TABS.find((t) => t.groups.some((g) => g === groupOf(code)))?.key ?? "overview";

  return (
    <ScanShell data={data}>
      <s-section>
        <s-stack direction="inline" gap="small-200">
          {TABS.map((tab) => {
            const count = tabCount(data, tab);
            return (
              <s-button
                key={tab.key}
                variant={tab.key === active ? "primary" : "secondary"}
                onClick={() => openTab(tab.key)}
              >
                {count === undefined ? tab.label : `${tab.label} (${count})`}
              </s-button>
            );
          })}
        </s-stack>
      </s-section>

      {active === "overview" && (
        <>
          <s-section heading="Summary">
            <s-stack direction="block" gap="base">
              <s-text color="subdued">{data.scan && scanSummaryLine(data.scan)}</s-text>
              <SummaryTiles data={data} />
            </s-stack>
          </s-section>
          {top.length > 0 && (
            <s-section heading="Biggest issues">
              <s-stack direction="block" gap="small-300">
                {top.map(([code, n]) => (
                  <s-stack key={code} direction="inline" gap="small-200" alignItems="center">
                    <s-badge tone="critical">{n}</s-badge>
                    <s-link onClick={() => openTab(tabFor(code), code)}>{ISSUE_INFO[code].label}</s-link>
                  </s-stack>
                ))}
              </s-stack>
            </s-section>
          )}
        </>
      )}

      {(active === "meta" || active === "content" || active === "images" || active === "structure") && (
        <s-section heading={TABS.find((t) => t.key === active)!.label}>
          <IssuesTable data={data} view={active} />
        </s-section>
      )}

      {active === "storefront" && (
        <s-section heading="Storefront pages">
          <StorefrontTable data={data} />
        </s-section>
      )}
    </ScanShell>
  );
}

const groupOf = (code: IssueCode): IssueGroupKey | undefined =>
  ISSUE_GROUPS.find((g) => g.codes.includes(code))?.key;

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
