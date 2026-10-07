import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { loadDashboard, scanAction } from "../services/dashboard.server";
import { ScanShell } from "../components/dashboard/ScanShell";
import { IssuesTable, StorefrontTable, SummaryTiles, scanSummaryLine } from "../components/dashboard/parts";

// Classic layout: summary tiles, then the full issues table, then storefront pages.

export const loader = ({ request }: LoaderFunctionArgs) => loadDashboard(request);
export const action = ({ request }: ActionFunctionArgs) => scanAction(request);

export default function ClassicDashboard() {
  const data = useLoaderData<typeof loader>();
  return (
    <ScanShell data={data}>
      <s-section heading="Summary">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">{data.scan && scanSummaryLine(data.scan)}</s-text>
          <SummaryTiles data={data} />
        </s-stack>
      </s-section>
      <s-section heading="Products & collections">
        <IssuesTable data={data} />
      </s-section>
      <s-section heading="Storefront pages">
        <StorefrontTable data={data} />
      </s-section>
    </ScanShell>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
