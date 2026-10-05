import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

type GraphqlClient = AdminApiContext["graphql"];

export type Severity = "error" | "warning" | "info";
export type Finding = { severity: Severity; message: string };
export type PageType = "HOME" | "PRODUCT" | "COLLECTION";

export type PageCheck = {
  pageType: PageType;
  url: string;
  label: string;
  status: "OK" | "ISSUES" | "FAILED";
  schemaTypes: string[];
  findings: Finding[];
};

export type SampledPages = {
  products: { title: string; handle: string }[];
  collections: { title: string; handle: string }[];
};

const STOREFRONT_QUERY = `#graphql
  query StructuredDataStorefront {
    shop { primaryDomain { url } }
  }`;

const PASSWORD_QUERY = `#graphql
  query StructuredDataPassword {
    onlineStore { passwordProtection { enabled } }
  }`;

const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 3;

// Fetches a handful of live storefront pages and reports on the JSON-LD each
// one renders — the same thing search engines see, including markup injected
// by the theme and by other apps.
export async function checkStructuredData(
  graphql: GraphqlClient,
  samples: SampledPages,
): Promise<{ blocked: boolean; checks: PageCheck[] }> {
  const response = await graphql(STOREFRONT_QUERY);
  const { data } = (await response.json()) as {
    data?: { shop: { primaryDomain: { url: string } } };
  };
  if (!data) throw new Error("Could not read the storefront domain.");
  if (await isPasswordProtected(graphql)) {
    return { blocked: true, checks: [] };
  }

  const base = data.shop.primaryDomain.url.replace(/\/$/, "");
  const pages: Omit<PageCheck, "status" | "schemaTypes" | "findings">[] = [
    { pageType: "HOME", url: `${base}/`, label: "Homepage" },
    ...samples.products.map((p) => ({
      pageType: "PRODUCT" as const,
      url: `${base}/products/${p.handle}`,
      label: p.title,
    })),
    ...samples.collections.map((c) => ({
      pageType: "COLLECTION" as const,
      url: `${base}/collections/${c.handle}`,
      label: c.title,
    })),
  ];

  const checks: PageCheck[] = [];
  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = await Promise.all(pages.slice(i, i + CONCURRENCY).map(checkPage));
    checks.push(...batch);
  }

  // A password page can appear even when the API said protection is off
  // (e.g. it was just enabled), so treat it as blocked rather than a failure.
  if (checks.some((c) => c.status === "FAILED" && c.findings[0]?.message === PASSWORD_PAGE)) {
    return { blocked: true, checks: [] };
  }

  return { blocked: false, checks };
}

const PASSWORD_PAGE = "The storefront is password protected.";

// Best effort: if this field is unavailable (e.g. behind a scope the app does
// not hold), fall back to detecting the password page when pages are fetched.
async function isPasswordProtected(graphql: GraphqlClient) {
  try {
    const response = await graphql(PASSWORD_QUERY);
    const { data } = (await response.json()) as {
      data?: { onlineStore: { passwordProtection: { enabled: boolean } } | null };
    };
    return data?.onlineStore?.passwordProtection.enabled === true;
  } catch {
    return false;
  }
}

export async function checkPage(
  page: Omit<PageCheck, "status" | "schemaTypes" | "findings">,
): Promise<PageCheck> {
  let html: string;
  try {
    const res = await fetch(page.url, {
      headers: {
        "User-Agent": "HawkEye-SEO/1.0 (Shopify app; structured data check)",
        Accept: "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (new URL(res.url).pathname.replace(/\/$/, "").endsWith("/password")) {
      return failed(page, PASSWORD_PAGE);
    }
    if (!res.ok) return failed(page, `The page returned HTTP ${res.status}.`);
    html = await res.text();
  } catch (error) {
    return failed(
      page,
      `The page could not be fetched (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  const { entities, invalidBlocks } = extractJsonLd(html);
  const findings: Finding[] = [];

  if (invalidBlocks > 0) {
    findings.push({
      severity: "error",
      message: `${invalidBlocks} structured data ${invalidBlocks === 1 ? "block contains" : "blocks contain"} invalid JSON, so search engines ignore ${invalidBlocks === 1 ? "it" : "them"}.`,
    });
  }
  if (entities.length === 0 && invalidBlocks === 0) {
    findings.push({ severity: "error", message: "No structured data found on this page." });
  }

  const types = unique(entities.flatMap(typesOf));
  const has = (type: string) => types.includes(type);

  if (page.pageType === "HOME") {
    if (!has("Organization") && !has("WebSite") && entities.length > 0) {
      findings.push({
        severity: "warning",
        message: "No Organization or WebSite schema — these tell search engines who runs the store.",
      });
    }
    const org = entities.find((e) => typesOf(e).includes("Organization"));
    if (org && !org.logo) {
      findings.push({ severity: "info", message: "Organization schema has no logo (used in knowledge panels)." });
    }
    const site = entities.find((e) => typesOf(e).includes("WebSite"));
    if (site && !site.potentialAction) {
      findings.push({ severity: "info", message: "WebSite schema has no SearchAction (enables the sitelinks search box)." });
    }
  }

  if (page.pageType === "PRODUCT") {
    const products = entities.filter((e) => typesOf(e).includes("Product"));
    if (products.length === 0 && entities.length > 0) {
      findings.push({
        severity: "error",
        message: "No Product schema — this page can't show price, availability or rating rich results.",
      });
    }
    if (products.length > 1) {
      findings.push({
        severity: "warning",
        message: `${products.length} Product schema blocks on one page — search engines may pick the wrong one. Usually the theme and an app both add one.`,
      });
    }
    const product = products[0];
    if (product) {
      const missing = ["name", "image", "description", "offers"].filter((f) => isBlank(product[f]));
      if (missing.length) {
        findings.push({ severity: "warning", message: `Product schema is missing required fields: ${missing.join(", ")}.` });
      }
      const offers = toArray(product.offers).filter(isRecord);
      if (offers.length) {
        const offerMissing = [
          ["price", offers.every((o) => isBlank(o.price) && isBlank(o.lowPrice))],
          ["priceCurrency", offers.every((o) => isBlank(o.priceCurrency))],
          ["availability", offers.every((o) => isBlank(o.availability))],
        ]
          .filter(([, isMissing]) => isMissing)
          .map(([field]) => field);
        if (offerMissing.length) {
          findings.push({ severity: "warning", message: `Offer is missing: ${offerMissing.join(", ")}.` });
        }
      }
      const recommended = ["sku", "brand"].filter((f) => isBlank(product[f]));
      if (recommended.length) {
        findings.push({ severity: "info", message: `Product schema has no ${recommended.join(" or ")} (recommended by Google).` });
      }
      if (isBlank(product.aggregateRating)) {
        findings.push({ severity: "info", message: "No aggregateRating — star ratings won't show in search results. Review apps usually add this." });
      }
    }
  }

  if (page.pageType === "PRODUCT" || page.pageType === "COLLECTION") {
    if (!has("BreadcrumbList") && entities.length > 0) {
      findings.push({
        severity: "warning",
        message: "No BreadcrumbList schema — search results show the raw URL instead of a navigation path.",
      });
    }
  }

  if (page.pageType === "COLLECTION" && entities.length > 0) {
    if (!has("CollectionPage") && !has("ItemList")) {
      findings.push({ severity: "info", message: "No CollectionPage or ItemList schema (optional)." });
    }
  }

  const status = findings.some((f) => f.severity !== "info") ? "ISSUES" : "OK";
  return { ...page, status, schemaTypes: types, findings };
}

function failed(
  page: Omit<PageCheck, "status" | "schemaTypes" | "findings">,
  message: string,
): PageCheck {
  return { ...page, status: "FAILED", schemaTypes: [], findings: [{ severity: "error", message }] };
}

type Entity = Record<string, unknown>;

// Pulls every <script type="application/ld+json"> block out of the page and
// flattens @graph / array wrappers into a list of schema.org entities.
export function extractJsonLd(html: string): { entities: Entity[]; invalidBlocks: number } {
  const pattern = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const entities: Entity[] = [];
  let invalidBlocks = 0;

  for (const match of html.matchAll(pattern)) {
    const raw = match[1].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      invalidBlocks++;
      continue;
    }
    for (const item of toArray(parsed)) {
      if (!isRecord(item)) continue;
      if (Array.isArray(item["@graph"])) {
        entities.push(...item["@graph"].filter(isRecord));
      } else {
        entities.push(item);
      }
    }
  }
  return { entities, invalidBlocks };
}

const typesOf = (entity: Entity): string[] =>
  toArray(entity["@type"]).filter((t): t is string => typeof t === "string");

const toArray = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const isRecord = (value: unknown): value is Entity =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBlank = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

const unique = <T>(items: T[]) => [...new Set(items)];
