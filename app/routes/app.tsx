import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { touchShop } from "../services/shop-profile.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  // Install history + contact profile for the admin dashboard.
  await touchShop(session.shop, admin.graphql);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

// This loader only records the visit and passes the API key; neither needs
// repeating while the dashboard polls during a scan.
export const shouldRevalidate = () => false;

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        {/* rel="home" makes this the app-name link instead of a sub-item */}
        <a href="/app" rel="home">
          Dashboard
        </a>
        {/* Alternative dashboard layouts, side by side while we pick one. */}
        <s-link href="/app/simple">Simple</s-link>
        <s-link href="/app/tabs">Tabs</s-link>
        <s-link href="/app/visual">Visual</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
