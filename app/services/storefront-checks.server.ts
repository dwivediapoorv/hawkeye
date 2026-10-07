import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

type GraphqlClient = AdminApiContext["graphql"];

export type Severity = "error" | "warning" | "info";
export type Category = "schema" | "indexing" | "headings" | "social" | "images" | "links" | "site";
export type Finding = { severity: Severity; category?: Category; message: string };
export type PageType = "SITE" | "HOME" | "PRODUCT" | "COLLECTION";

export type PageCheck = {
  pageType: PageType;
  url: string;
  label: string;
  status: "OK" | "ISSUES" | "FAILED";
  schemaTypes: string[];
  findings: Finding[];
};

type PageToCheck = Pick<PageCheck, "pageType" | "url" | "label"> & { handle?: string };

export type SampledPages = {
  products: { title: string; handle: string }[];
  collections: { title: string; handle: string }[];
};

const STOREFRONT_QUERY = `#graphql
  query StorefrontChecksDomain {
    shop { primaryDomain { url } }
  }`;

const PASSWORD_QUERY = `#graphql
  query StorefrontChecksPassword {
    onlineStore { passwordProtection { enabled } }
  }`;

const FETCH_TIMEOUT_MS = 15_000;
const LINK_TIMEOUT_MS = 10_000;
const CONCURRENCY = 3;
const LINK_CONCURRENCY = 5;
// Internal links checked per scan, across all sampled pages.
const MAX_LINKS_CHECKED = 40;
// Only links to these sections are checked; cart, account and search pages are skipped.
const CHECKED_LINK_PREFIXES = ["/products/", "/collections/", "/pages/", "/blogs/"];

const USER_AGENT = "HawkEye-SEO/1.0 (Shopify app; storefront SEO check)";
const PASSWORD_PAGE = "The storefront is password protected.";

// Fetches a handful of live storefront pages and checks what search engines
// see on them — structured data, indexing tags, headings, social tags, images
// and links — plus the store's robots.txt and sitemap.
export async function checkStorefront(
  graphql: GraphqlClient,
  samples: SampledPages,
  onProgress?: (checked: number, total: number) => Promise<unknown>,
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
  const pages: PageToCheck[] = [
    { pageType: "HOME", url: `${base}/`, label: "Homepage" },
    ...samples.products.map((p) => ({
      pageType: "PRODUCT" as const,
      url: `${base}/products/${p.handle}`,
      label: p.title,
      handle: p.handle,
    })),
    ...samples.collections.map((c) => ({
      pageType: "COLLECTION" as const,
      url: `${base}/collections/${c.handle}`,
      label: c.title,
      handle: c.handle,
    })),
  ];

  // Pages, then one step for the link check and one for robots.txt/sitemap.
  const total = pages.length + 2;
  await onProgress?.(0, total);

  const results: { check: PageCheck; links: string[] }[] = [];
  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = await Promise.all(pages.slice(i, i + CONCURRENCY).map(checkPage));
    results.push(...batch);
    await onProgress?.(results.length, total);
  }

  // A password page can appear even when the API said protection is off
  // (e.g. it was just enabled), so treat it as blocked rather than a failure.
  if (results.some(({ check }) => check.findings[0]?.message === PASSWORD_PAGE)) {
    return { blocked: true, checks: [] };
  }

  await addBrokenLinkFindings(results);
  await onProgress?.(pages.length + 1, total);

  const site = await checkSite(base);
  await onProgress?.(total, total);

  const checks = [site, ...results.map(({ check }) => check)];
  for (const check of checks) {
    if (check.status !== "FAILED") check.status = statusOf(check.findings);
  }
  return { blocked: false, checks };
}

const statusOf = (findings: Finding[]) =>
  findings.some((f) => f.severity !== "info") ? "ISSUES" : "OK";

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

const get = (url: string, accept: string, timeout = FETCH_TIMEOUT_MS) =>
  fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: accept },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  });

export async function checkPage(page: PageToCheck): Promise<{ check: PageCheck; links: string[] }> {
  const pageFields = { pageType: page.pageType, url: page.url, label: page.label };
  const failed = (message: string) => ({
    check: {
      ...pageFields,
      status: "FAILED" as const,
      schemaTypes: [],
      findings: [{ severity: "error" as const, message }],
    },
    links: [],
  });

  let res: Response;
  let html: string;
  try {
    res = await get(page.url, "text/html");
    if (new URL(res.url).pathname.replace(/\/$/, "").endsWith("/password")) {
      return failed(PASSWORD_PAGE);
    }
    if (!res.ok) return failed(`The page returned HTTP ${res.status}.`);
    html = await res.text();
  } catch (error) {
    return failed(
      `The page could not be fetched (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  // Tag checks ignore scripts, styles, <noscript> fallbacks and comments.
  const markup = html.replace(
    /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<noscript\b[\s\S]*?<\/noscript>|<!--[\s\S]*?-->/gi,
    "",
  );

  const { types, findings: schemaFindings } = checkSchema(page, html);
  const findings: Finding[] = [
    ...indexingFindings(page, markup, res),
    ...headingFindings(markup),
    ...schemaFindings,
    ...socialFindings(markup),
    ...imageFindings(markup),
  ];

  return {
    check: { ...pageFields, status: statusOf(findings), schemaTypes: types, findings },
    links: internalLinks(markup, page.url),
  };
}

// --- Indexing: noindex and canonical ---

function indexingFindings(page: PageToCheck, markup: string, res: Response): Finding[] {
  const findings: Finding[] = [];
  const noindexMeta = tags(markup, "meta").some(
    (t) => /^(robots|googlebot)$/i.test(attr(t, "name") ?? "") && /noindex/i.test(attr(t, "content") ?? ""),
  );
  if (noindexMeta || /noindex/i.test(res.headers.get("x-robots-tag") ?? "")) {
    findings.push({
      severity: "error",
      category: "indexing",
      message: "This page tells search engines not to index it (noindex), so it can't appear in Google.",
    });
  }

  const canonicals = unique(
    tags(markup, "link")
      .filter((t) => (attr(t, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"))
      .map((t) => attr(t, "href"))
      .filter((href): href is string => !!href),
  );
  if (canonicals.length === 0) {
    findings.push({
      severity: "warning",
      category: "indexing",
      message: "No canonical tag — search engines may index duplicate versions of this page (e.g. with filters or tracking parameters).",
    });
  } else if (canonicals.length > 1) {
    findings.push({
      severity: "warning",
      category: "indexing",
      message: `${canonicals.length} different canonical tags — search engines may ignore all of them.`,
    });
  } else {
    let canonical: URL | null = null;
    try {
      canonical = new URL(canonicals[0], page.url);
    } catch {
      // handled below
    }
    const pageHost = new URL(page.url).host;
    if (!canonical) {
      findings.push({ severity: "warning", category: "indexing", message: "The canonical tag has an invalid URL." });
    } else if (canonical.host !== pageHost) {
      findings.push({
        severity: "warning",
        category: "indexing",
        message: `The canonical tag points to another domain (${canonical.host}), so search engines credit that site instead.`,
      });
    } else if (!canonicalMatches(page, canonical)) {
      findings.push({
        severity: "warning",
        category: "indexing",
        message: `The canonical tag points to ${canonical.pathname} instead of this page.`,
      });
    }
  }
  return findings;
}

function canonicalMatches(page: PageToCheck, canonical: URL) {
  let path = canonical.pathname.toLowerCase().replace(/\/$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  const handle = page.handle?.toLowerCase();
  if (page.pageType === "PRODUCT") return path.endsWith(`/products/${handle}`);
  if (page.pageType === "COLLECTION") return path.endsWith(`/collections/${handle}`);
  // Homepage: the root, or a market/language root such as /en-ca.
  return path === "" || /^\/[a-z]{2}(-[a-z]{2})?$/.test(path);
}

// --- Headings ---

function headingFindings(markup: string): Finding[] {
  const h1Count = (markup.match(/<h1\b/gi) ?? []).length;
  if (h1Count === 0) {
    return [{
      severity: "warning",
      category: "headings",
      message: "No H1 heading — search engines use it to understand what the page is about.",
    }];
  }
  if (h1Count > 1) {
    return [{
      severity: "warning",
      category: "headings",
      message: `${h1Count} H1 headings — a page should have one main heading. Themes often wrap the logo in an extra H1.`,
    }];
  }
  return [];
}

// --- Social sharing (Open Graph) ---

function socialFindings(markup: string): Finding[] {
  const og = new Set(
    tags(markup, "meta")
      .filter((t) => (attr(t, "content") ?? "").trim() !== "")
      .map((t) => (attr(t, "property") ?? attr(t, "name") ?? "").toLowerCase()),
  );
  const findings: Finding[] = [];
  if (!og.has("og:image")) {
    findings.push({
      severity: "warning",
      category: "social",
      message: "No og:image tag — links shared on WhatsApp, Facebook and others show without a picture.",
    });
  }
  const missingText = ["og:title", "og:description"].filter((p) => !og.has(p));
  if (missingText.length) {
    findings.push({
      severity: "info",
      category: "social",
      message: `No ${missingText.join(" or ")} tag — shared links fall back to the page title and text.`,
    });
  }
  return findings;
}

// --- Images: layout shift and full-size downloads ---

function imageFindings(markup: string): Finding[] {
  const images = tags(markup, "img").filter((t) => {
    const src = attr(t, "src") ?? attr(t, "data-src") ?? "";
    return src !== "" && !src.startsWith("data:");
  });

  const noSize = images.filter((t) => attr(t, "width") === null || attr(t, "height") === null).length;
  const fullSize = images.filter((t) => {
    const src = attr(t, "src") ?? attr(t, "data-src") ?? "";
    const onShopifyCdn = src.includes("cdn.shopify.com") || src.includes("/cdn/shop/");
    return onShopifyCdn && attr(t, "srcset") === null && attr(t, "data-srcset") === null && !/[?&]width=\d+/.test(src);
  }).length;

  const findings: Finding[] = [];
  if (noSize > 0) {
    findings.push({
      severity: "warning",
      category: "images",
      message: `${noSize} ${noSize === 1 ? "image has" : "images have"} no width/height, so the page jumps around while loading (hurts Core Web Vitals).`,
    });
  }
  if (fullSize > 0) {
    findings.push({
      severity: "warning",
      category: "images",
      message: `${fullSize} ${fullSize === 1 ? "image loads" : "images load"} at full size with no resized versions, which slows the page down.`,
    });
  }
  return findings;
}

// --- Links ---

function internalLinks(markup: string, pageUrl: string): string[] {
  const host = new URL(pageUrl).host;
  const links = new Set<string>();
  for (const tag of tags(markup, "a")) {
    const href = attr(tag, "href");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (url.host !== host) continue;
    if (!CHECKED_LINK_PREFIXES.some((p) => url.pathname.includes(p))) continue;
    url.hash = "";
    url.search = "";
    links.add(url.toString());
  }
  return [...links];
}

// Checks the internal links found on the sampled pages and reports any that
// return 404/410 on the pages that link to them.
async function addBrokenLinkFindings(results: { check: PageCheck; links: string[] }[]) {
  const fetched = new Set(results.map(({ check }) => check.url));
  const toCheck = unique(results.flatMap(({ links }) => links))
    .filter((url) => !fetched.has(url))
    .slice(0, MAX_LINKS_CHECKED);

  const broken = new Map<string, number>();
  for (let i = 0; i < toCheck.length; i += LINK_CONCURRENCY) {
    await Promise.all(
      toCheck.slice(i, i + LINK_CONCURRENCY).map(async (url) => {
        const status = await linkStatus(url);
        if (status === 404 || status === 410) broken.set(url, status);
      }),
    );
  }

  for (const { check, links } of results) {
    const dead = links.filter((url) => broken.has(url)).map((url) => new URL(url).pathname);
    if (dead.length === 0) continue;
    const listed = dead.slice(0, 3).join(", ");
    const more = dead.length > 3 ? ` and ${dead.length - 3} more` : "";
    check.findings.push({
      severity: "error",
      category: "links",
      message: `${dead.length} broken ${dead.length === 1 ? "link" : "links"} (page not found): ${listed}${more}.`,
    });
  }
}

// HTTP status of a link, or null if it could not be reached (not reported as broken).
async function linkStatus(url: string): Promise<number | null> {
  try {
    const head = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
    });
    if (head.status !== 405 && head.status !== 501) return head.status;
    const res = await get(url, "text/html", LINK_TIMEOUT_MS);
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
}

// --- robots.txt and sitemap.xml ---

async function checkSite(base: string): Promise<PageCheck> {
  const findings: Finding[] = [];

  try {
    const res = await get(`${base}/robots.txt`, "text/plain");
    if (!res.ok) {
      findings.push({ severity: "warning", category: "site", message: `robots.txt returned HTTP ${res.status}.` });
    } else {
      const text = await res.text();
      if (blocksEverything(text)) {
        findings.push({
          severity: "error",
          category: "site",
          message: "robots.txt blocks search engines from the whole store (Disallow: /).",
        });
      }
      if (!/^\s*sitemap\s*:/im.test(text)) {
        findings.push({ severity: "info", category: "site", message: "robots.txt doesn't point search engines to the sitemap." });
      }
    }
  } catch {
    findings.push({ severity: "warning", category: "site", message: "robots.txt could not be fetched." });
  }

  try {
    const res = await get(`${base}/sitemap.xml`, "application/xml");
    if (!res.ok) {
      findings.push({
        severity: "error",
        category: "site",
        message: `sitemap.xml returned HTTP ${res.status}, so search engines can't use it to find your pages.`,
      });
    } else {
      const text = await res.text();
      if (!/sitemap_products|\/products\//i.test(text)) {
        findings.push({ severity: "warning", category: "site", message: "sitemap.xml doesn't list any products." });
      }
    }
  } catch {
    findings.push({ severity: "warning", category: "site", message: "sitemap.xml could not be fetched." });
  }

  return {
    pageType: "SITE",
    url: `${base}/sitemap.xml`,
    label: "robots.txt & sitemap.xml",
    status: statusOf(findings),
    schemaTypes: [],
    findings,
  };
}

// True when the rules for all crawlers (or Googlebot) disallow the whole site.
function blocksEverything(robots: string) {
  let agents: string[] = [];
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const [, key, value] = match;
    if (key.toLowerCase() === "user-agent") {
      agents = lastWasAgent ? [...agents, value.toLowerCase()] : [value.toLowerCase()];
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    const forSearchEngines = agents.includes("*") || agents.includes("googlebot");
    if (key.toLowerCase() === "disallow" && value.trim() === "/" && forSearchEngines) return true;
  }
  return false;
}

// --- Structured data (JSON-LD) ---

function checkSchema(page: PageToCheck, html: string): { types: string[]; findings: Finding[] } {
  const { entities, invalidBlocks } = extractJsonLd(html);
  const findings: Finding[] = [];
  const add = (severity: Severity, message: string) =>
    findings.push({ severity, category: "schema", message });

  if (invalidBlocks > 0) {
    add(
      "error",
      `${invalidBlocks} structured data ${invalidBlocks === 1 ? "block contains" : "blocks contain"} invalid JSON, so search engines ignore ${invalidBlocks === 1 ? "it" : "them"}.`,
    );
  }
  if (entities.length === 0 && invalidBlocks === 0) {
    add("error", "No structured data found on this page.");
  }

  const types = unique(entities.flatMap(typesOf));
  const has = (type: string) => types.includes(type);

  if (page.pageType === "HOME") {
    if (!has("Organization") && !has("WebSite") && entities.length > 0) {
      add("warning", "No Organization or WebSite schema — these tell search engines who runs the store.");
    }
    const org = entities.find((e) => typesOf(e).includes("Organization"));
    if (org && !org.logo) {
      add("info", "Organization schema has no logo (used in knowledge panels).");
    }
    const site = entities.find((e) => typesOf(e).includes("WebSite"));
    if (site && !site.potentialAction) {
      add("info", "WebSite schema has no SearchAction (enables the sitelinks search box).");
    }
  }

  if (page.pageType === "PRODUCT") {
    const products = entities.filter((e) => typesOf(e).includes("Product"));
    if (products.length === 0 && entities.length > 0) {
      add("error", "No Product schema — this page can't show price, availability or rating rich results.");
    }
    if (products.length > 1) {
      add(
        "warning",
        `${products.length} Product schema blocks on one page — search engines may pick the wrong one. Usually the theme and an app both add one.`,
      );
    }
    const product = products[0];
    if (product) {
      const missing = ["name", "image", "description", "offers"].filter((f) => isBlank(product[f]));
      if (missing.length) {
        add("warning", `Product schema is missing required fields: ${missing.join(", ")}.`);
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
          add("warning", `Offer is missing: ${offerMissing.join(", ")}.`);
        }
      }
      const recommended = ["sku", "brand"].filter((f) => isBlank(product[f]));
      if (recommended.length) {
        add("info", `Product schema has no ${recommended.join(" or ")} (recommended by Google).`);
      }
      if (isBlank(product.aggregateRating)) {
        add("info", "No aggregateRating — star ratings won't show in search results. Review apps usually add this.");
      }
    }
  }

  if (page.pageType === "PRODUCT" || page.pageType === "COLLECTION") {
    if (!has("BreadcrumbList") && entities.length > 0) {
      add("warning", "No BreadcrumbList schema — search results show the raw URL instead of a navigation path.");
    }
  }

  if (page.pageType === "COLLECTION" && entities.length > 0) {
    if (!has("CollectionPage") && !has("ItemList")) {
      add("info", "No CollectionPage or ItemList schema (optional).");
    }
  }

  return { types, findings };
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

// --- HTML helpers ---

// Every opening tag with the given name, e.g. all `<meta …>` tags.
const tags = (html: string, name: string) =>
  html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];

// The value of an attribute on a raw tag, or null if the attribute is absent.
function attr(tag: string, name: string): string | null {
  const match = tag.match(
    new RegExp(`\\s${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?(?=[\\s/>])`, "i"),
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
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
