import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { loadDashboard, scanAction, type DashboardData } from "../services/dashboard.server";
import { ScanShell } from "../components/dashboard/ScanShell";
import { CATEGORY_LABEL, pageLabel, scanSummaryLine } from "../components/dashboard/parts";
import { ISSUE_CODES, ISSUE_GROUPS, type IssueCode } from "../seo/issues";

// Simple layout: one headline number and a prioritised to-do list. Each item
// links to the classic dashboard filtered to that issue for the details.

export const loader = ({ request }: LoaderFunctionArgs) => loadDashboard(request);
export const action = ({ request }: ActionFunctionArgs) => scanAction(request);

type Priority = "high" | "medium";

const TODO: Record<IssueCode, { one: string; many: string; priority: Priority }> = {
  DESCRIPTION_MISSING: { one: "page has no meta description", many: "pages have no meta description", priority: "high" },
  MISSING_ALT: { one: "product or collection has images without alt text", many: "products and collections have images without alt text", priority: "high" },
  COPIED_CONTENT: { one: "product uses a copied description", many: "products use copied descriptions", priority: "high" },
  TITLE_DUPLICATE: { one: "page shares its meta title with another page", many: "pages share a meta title with another page", priority: "high" },
  DESCRIPTION_DUPLICATE: { one: "page shares its meta description", many: "pages share a meta description", priority: "high" },
  EMPTY_COLLECTION: { one: "collection is empty", many: "collections are empty", priority: "high" },
  TITLE_LONG: { one: "meta title gets cut off in Google", many: "meta titles get cut off in Google", priority: "high" },
  DESCRIPTION_LONG: { one: "meta description gets cut off in Google", many: "meta descriptions get cut off in Google", priority: "medium" },
  THIN_CONTENT: { one: "product has a thin description", many: "products have thin descriptions", priority: "medium" },
  TITLE_SHORT: { one: "meta title is too short", many: "meta titles are too short", priority: "medium" },
  DESCRIPTION_SHORT: { one: "meta description is too short", many: "meta descriptions are too short", priority: "medium" },
  NO_COLLECTION: { one: "product isn't in any collection", many: "products aren't in any collection", priority: "medium" },
  HANDLE: { one: "URL needs tidying", many: "URLs need tidying", priority: "medium" },
  IMAGE_FILENAMES: { one: "item has camera-style image file names", many: "items have camera-style image file names", priority: "medium" },
};

type Todo = { key: string; priority: Priority; text: string; detail?: string; href?: string };

function buildTodos(data: DashboardData): Todo[] {
  const codes = data.groupCounts?.codes ?? {};
  const catalog: Todo[] = ISSUE_CODES.filter((code) => codes[code]).map((code) => {
    const n = codes[code]!;
    return {
      key: code,
      priority: TODO[code].priority,
      text: `${n.toLocaleString()} ${n === 1 ? TODO[code].one : TODO[code].many}`,
      href: `/app?issue=${code}`,
    };
  });

  // The same storefront finding usually repeats on every page of a type
  // (it comes from the theme), so group identical findings, ignoring counts.
  const storefront = new Map<string, Todo & { pages: string[] }>();
  for (const check of data.schemaChecks) {
    for (const f of check.findings) {
      if (f.severity === "info") continue;
      const key = `${f.category}:${f.message.replace(/\d+/g, "#")}`;
      const existing = storefront.get(key);
      if (existing) {
        existing.pages.push(pageLabel(check));
        continue;
      }
      storefront.set(key, {
        key,
        priority: f.severity === "error" ? "high" : "medium",
        text: `${f.category ? `${CATEGORY_LABEL[f.category]}: ` : ""}${f.message}`,
        pages: [pageLabel(check)],
      });
    }
  }
  const pages = [...storefront.values()].map(({ pages: on, ...todo }) => ({
    ...todo,
    detail: `On ${on.slice(0, 3).join(", ")}${on.length > 3 ? ` and ${on.length - 3} more` : ""}`,
  }));

  const rank = (t: Todo) => (t.priority === "high" ? 0 : 1);
  return [...catalog, ...pages].sort((a, b) => rank(a) - rank(b));
}

export default function SimpleDashboard() {
  const data = useLoaderData<typeof loader>();
  const todos = data.scan ? buildTodos(data) : [];
  const clean = ISSUE_GROUPS.filter((g) => data.groupCounts?.groups[g.key] === 0).map((g) => g.label);
  const done = data.scan?.status === "COMPLETED";

  return (
    <ScanShell data={data}>
      <s-section>
        <s-stack direction="block" gap="small-200">
          <span style={{ fontSize: "32px", fontWeight: 650, lineHeight: 1.2 }}>
            {todos.length === 0 && done
              ? "Nothing to fix 🎉"
              : `${todos.length} ${todos.length === 1 ? "thing" : "things"} to fix`}
          </span>
          <s-text color="subdued">{data.scan && scanSummaryLine(data.scan)}</s-text>
          {clean.length > 0 && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-icon type="check-circle" tone="success" />
              <s-text color="subdued">No issues: {clean.join(", ")}</s-text>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {todos.length > 0 && (
        <s-section heading="To do">
          <s-stack direction="block" gap="none">
            {todos.map((todo, i) => (
              <s-box key={todo.key}>
                {i > 0 && <s-divider />}
                <s-box paddingBlock="base">
                  <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                    <s-stack direction="inline" gap="small-300" alignItems="center">
                      <s-icon
                        type={todo.priority === "high" ? "alert-circle" : "circle"}
                        tone={todo.priority === "high" ? "critical" : "caution"}
                      />
                      <s-stack direction="block" gap="small-500">
                        <s-text>{todo.text}</s-text>
                        {todo.detail && <s-text color="subdued">{todo.detail}</s-text>}
                      </s-stack>
                    </s-stack>
                    {todo.href && <s-link href={todo.href}>Review</s-link>}
                  </s-stack>
                </s-box>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}
    </ScanShell>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
