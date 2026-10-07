import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import {
  COPIED_CONTENT_MIN_WORDS,
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_MIN_LENGTH,
  FALLBACK_DESCRIPTION_TRUNCATE_AT,
  HANDLE_MAX_LENGTH,
  SCAN_STALE_AFTER_MS,
  THIN_CONTENT_WORDS,
  TITLE_MAX_LENGTH,
  TITLE_MIN_LENGTH,
} from "../seo/limits";
import { ISSUE_GROUPS, type IssueCode, type IssueCounts } from "../seo/issues";
import { checkStorefront, type SampledPages } from "./storefront-checks.server";

type GraphqlClient = AdminApiContext["graphql"];

type SeoNode = {
  id: string;
  title: string;
  handle: string;
  description: string | null;
  seo: { title: string | null; description: string | null };
};

type ProductNode = SeoNode & {
  onlineStoreUrl: string | null;
  media: { nodes: { mediaContentType: string; alt: string | null; image?: { url: string } | null }[] };
  collections: { nodes: { id: string }[] };
};

type CollectionNode = SeoNode & {
  image: { altText: string | null; url: string } | null;
  productsCount: { count: number } | null;
};

type Connection<T> = {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
};

type ThrottleStatus = {
  requestedQueryCost: number;
  throttleStatus: { currentlyAvailable: number; restoreRate: number };
};

// How many live storefront pages of each type the storefront checks sample.
const PRODUCT_PAGE_SAMPLES = 5;
const COLLECTION_PAGE_SAMPLES = 3;

// Page sizes keep each query well under Shopify's 1,000-point cost limit:
// every product also pulls up to 10 images and one collection.
const PRODUCTS_QUERY = `#graphql
  query SeoScanProducts($cursor: String, $truncateAt: Int!) {
    products(first: 25, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        onlineStoreUrl
        description(truncateAt: $truncateAt)
        seo { title description }
        media(first: 10) {
          nodes {
            mediaContentType
            alt
            ... on MediaImage { image { url } }
          }
        }
        collections(first: 1) { nodes { id } }
      }
    }
  }`;

const COLLECTIONS_QUERY = `#graphql
  query SeoScanCollections($cursor: String, $truncateAt: Int!) {
    collections(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        description(truncateAt: $truncateAt)
        seo { title description }
        image { altText url }
        productsCount { count }
      }
    }
  }`;

// Totals for the dashboard's progress bar. `limit: null` asks for an exact count.
const COUNTS_QUERY = `#graphql
  query SeoScanCounts {
    productsCount(query: "status:active", limit: null) { count }
    collectionsCount(limit: null) { count }
  }`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs a query, retrying on Shopify's cost-based throttling and waiting when
// the bucket is nearly empty so the next page doesn't get rejected.
async function query<T>(
  graphql: GraphqlClient,
  document: string,
  variables: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await graphql(document, { variables });
    const json = (await response.json()) as {
      data?: T;
      errors?: { message: string; extensions?: { code?: string } }[];
      extensions?: { cost?: ThrottleStatus };
    };

    const throttled = json.errors?.some(
      (e) => e.extensions?.code === "THROTTLED",
    );
    if (throttled) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }

    const cost = json.extensions?.cost;
    if (cost && cost.throttleStatus.currentlyAvailable < cost.requestedQueryCost) {
      const deficit = cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable;
      await sleep(Math.ceil(deficit / cost.throttleStatus.restoreRate) * 1000);
    }

    return json.data as T;
  }
  throw new Error("Shopify API kept throttling the request; try again later.");
}

async function* paginate<T>(
  graphql: GraphqlClient,
  document: string,
  field: "products" | "collections",
) {
  let cursor: string | null = null;
  do {
    const data: Record<string, Connection<T>> = await query(graphql, document, {
      cursor,
      truncateAt: FALLBACK_DESCRIPTION_TRUNCATE_AT,
    });
    const connection = data[field];
    yield connection.nodes;
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
}

// Mirrors what Shopify's storefront renders when no custom SEO value is set:
// the title tag falls back to the resource title, the description to the body text.
export function evaluateNode(node: SeoNode) {
  const titleIsDefault = !node.seo.title;
  const descriptionIsDefault = !node.seo.description;
  const metaTitle = (node.seo.title || node.title || "").trim();
  const metaDescription = (node.seo.description || node.description || "").trim();

  return {
    metaTitle,
    metaDescription,
    titleLength: metaTitle.length,
    descriptionLength: metaDescription.length,
    titleTooLong: metaTitle.length > TITLE_MAX_LENGTH,
    descriptionTooLong: metaDescription.length > DESCRIPTION_MAX_LENGTH,
    descriptionMissing: metaDescription.length === 0,
    titleIsDefault,
    descriptionIsDefault,
  };
}

// File names straight from a camera or phone, e.g. IMG_4821.jpg, DSC0012.jpg,
// PXL_20240101.jpg, "Screenshot 2024-…", or bare numbers/UUIDs.
const CAMERA_NAME =
  /^(img|dsc|dscn|dscf|pxl|mvimg|gopr|dji|photo|image|screenshot|screen[-_ ]?shot|whatsapp[-_ ]?image|untitled)[-_ ]?\d/i;
const MEANINGLESS_NAME = /^([\d_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function isCameraFileName(url: string) {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return false;
  }
  const stem = name.replace(/\.[a-z0-9]+$/i, "");
  return CAMERA_NAME.test(stem) || MEANINGLESS_NAME.test(stem);
}

const wordCount = (text: string) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;

const isBlank = (value: string | null | undefined) => !value || value.trim() === "";

type Analyzed = {
  row: Prisma.ScanItemCreateManyInput;
  issues: Set<IssueCode>;
  // Normalised body text, for spotting the same description on several products.
  bodyKey: string | null;
};

function analyze(
  scanId: string,
  resourceType: "PRODUCT" | "COLLECTION",
  node: SeoNode,
  images: { alt: string | null; url: string | null }[],
  extra: { notInCollection?: boolean; empty?: boolean },
): Analyzed {
  const meta = evaluateNode(node);
  const issues = new Set<IssueCode>();

  if (meta.titleTooLong) issues.add("TITLE_LONG");
  if (meta.titleLength > 0 && meta.titleLength < TITLE_MIN_LENGTH) issues.add("TITLE_SHORT");
  if (meta.descriptionTooLong) issues.add("DESCRIPTION_LONG");
  if (meta.descriptionMissing) issues.add("DESCRIPTION_MISSING");
  else if (meta.descriptionLength < DESCRIPTION_MIN_LENGTH) issues.add("DESCRIPTION_SHORT");

  const body = (node.description ?? "").trim();
  const words = resourceType === "PRODUCT" ? wordCount(body) : null;
  if (words !== null && words < THIN_CONTENT_WORDS) issues.add("THIN_CONTENT");

  const imagesMissingAlt = images.filter((i) => isBlank(i.alt)).length;
  const badImageNames = images.filter((i) => i.url && isCameraFileName(i.url)).length;
  if (imagesMissingAlt > 0) issues.add("MISSING_ALT");
  if (badImageNames > 0) issues.add("IMAGE_FILENAMES");

  let handleIssue: string | null = null;
  if (node.handle.startsWith("copy-of-")) handleIssue = "starts with “copy-of”";
  else if (node.handle.length > HANDLE_MAX_LENGTH) handleIssue = `${node.handle.length} characters long`;
  if (handleIssue) issues.add("HANDLE");

  if (extra.notInCollection) issues.add("NO_COLLECTION");
  if (extra.empty) issues.add("EMPTY_COLLECTION");

  return {
    row: {
      scanId,
      resourceType,
      resourceId: node.id,
      handle: node.handle,
      name: node.title,
      ...meta,
      imageCount: images.length,
      imagesMissingAlt,
      badImageNames,
      wordCount: words,
      handleIssue,
    },
    issues,
    bodyKey:
      words !== null && words >= COPIED_CONTENT_MIN_WORDS
        ? body.toLowerCase().replace(/\s+/g, " ")
        : null,
  };
}

// Flags every item in groups (by key) that have more than one member.
function flagShared(items: Analyzed[], keyOf: (item: Analyzed) => string | null, code: IssueCode) {
  const groups = new Map<string, Analyzed[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const group of groups.values()) {
    if (group.length > 1) group.forEach((item) => item.issues.add(code));
  }
}

// Serialises scans per process so a double click can't start two for the same shop.
const runningScans = new Set<string>();

export async function startScan(shop: string, graphql: GraphqlClient) {
  if (runningScans.has(shop)) return null;

  const existing = await db.scan.findFirst({
    where: { shop, status: "RUNNING" },
  });
  if (existing) return null;

  const scan = await db.scan.create({ data: { shop, status: "RUNNING" } });
  runningScans.add(shop);

  // Deliberately not awaited: the scan can take minutes on large catalogs,
  // so the action returns immediately and the dashboard polls for progress.
  runScan(scan.id, graphql)
    .catch(async (error: unknown) => {
      console.error(`SEO scan ${scan.id} failed`, error);
      await db.scan.update({
        where: { id: scan.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    })
    .finally(() => runningScans.delete(shop));

  return scan;
}

async function runScan(scanId: string, graphql: GraphqlClient) {
  const counts = await query<{
    productsCount: { count: number };
    collectionsCount: { count: number };
  }>(graphql, COUNTS_QUERY, {});
  await db.scan.update({
    where: { id: scanId },
    data: {
      productTotal: counts.productsCount.count,
      collectionTotal: counts.collectionsCount.count,
    },
  });

  // Duplicate and copied-content checks need the whole catalog, so every item
  // is analysed in memory first and only the flagged ones are written at the end.
  const items: Analyzed[] = [];
  const samples: SampledPages = { products: [], collections: [] };
  let productCount = 0;
  let collectionCount = 0;

  for await (const nodes of paginate<ProductNode>(graphql, PRODUCTS_QUERY, "products")) {
    productCount += nodes.length;
    for (const node of nodes) {
      const images = node.media.nodes
        .filter((m) => m.mediaContentType === "IMAGE")
        .map((m) => ({ alt: m.alt, url: m.image?.url ?? null }));
      items.push(
        analyze(scanId, "PRODUCT", node, images, {
          notInCollection: node.collections.nodes.length === 0,
        }),
      );
      // Only products published to the Online Store have a page to check.
      if (node.onlineStoreUrl && samples.products.length < PRODUCT_PAGE_SAMPLES) {
        samples.products.push({ title: node.title, handle: node.handle });
      }
    }
    // Keep the dashboard's progress bar moving while the scan runs.
    await db.scan.update({ where: { id: scanId }, data: { productCount } });
  }

  for await (const nodes of paginate<CollectionNode>(graphql, COLLECTIONS_QUERY, "collections")) {
    collectionCount += nodes.length;
    for (const node of nodes) {
      const images = node.image ? [{ alt: node.image.altText, url: node.image.url }] : [];
      const empty = node.productsCount?.count === 0;
      items.push(analyze(scanId, "COLLECTION", node, images, { empty }));
      if (!empty && samples.collections.length < COLLECTION_PAGE_SAMPLES) {
        samples.collections.push({ title: node.title, handle: node.handle });
      }
    }
    await db.scan.update({ where: { id: scanId }, data: { collectionCount } });
  }

  // Checks across the whole catalog.
  flagShared(items, (i) => i.row.metaTitle.toLowerCase() || null, "TITLE_DUPLICATE");
  flagShared(items, (i) => i.row.metaDescription.toLowerCase() || null, "DESCRIPTION_DUPLICATE");
  flagShared(items, (i) => i.bodyKey, "COPIED_CONTENT");
  flagDuplicateHandles(items);

  const flagged = items.filter((i) => i.issues.size > 0);
  const rows = flagged.map(({ row, issues }) => ({
    ...row,
    titleDuplicate: issues.has("TITLE_DUPLICATE"),
    issues: [...issues],
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await db.scanItem.createMany({ data: rows.slice(i, i + 500) });
  }

  const issueCounts: IssueCounts = { codes: {}, groups: {} };
  for (const { issues } of flagged) {
    for (const code of issues) issueCounts.codes[code] = (issueCounts.codes[code] ?? 0) + 1;
    for (const group of ISSUE_GROUPS) {
      if (group.codes.some((c) => issues.has(c))) {
        issueCounts.groups[group.key] = (issueCounts.groups[group.key] ?? 0) + 1;
      }
    }
  }
  const count = (code: IssueCode) => issueCounts.codes[code] ?? 0;
  await db.scan.update({
    where: { id: scanId },
    data: {
      issueCounts,
      longTitleCount: count("TITLE_LONG"),
      longDescriptionCount: count("DESCRIPTION_LONG"),
      missingDescriptionCount: count("DESCRIPTION_MISSING"),
      duplicateTitleCount: count("TITLE_DUPLICATE"),
    },
  });

  // Live storefront pages, as search engines see them.
  const { blocked, checks } = await checkStorefront(
    graphql,
    samples,
    (pagesChecked, pagesTotal) =>
      db.scan.update({ where: { id: scanId }, data: { pagesChecked, pagesTotal } }),
  );
  if (checks.length) {
    await db.schemaCheck.createMany({
      data: checks.map((c) => ({ scanId, ...c })),
    });
  }

  await db.scan.update({
    where: { id: scanId },
    data: {
      storefrontBlocked: blocked,
      schemaIssueCount: checks.filter((c) => c.status !== "OK").length,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
}

// Handles like "blue-shirt-1" next to an existing "blue-shirt" are usually left
// over from duplicating a product or collection.
function flagDuplicateHandles(items: Analyzed[]) {
  const handles = new Set(items.map((i) => `${i.row.resourceType}:${i.row.handle}`));
  for (const item of items) {
    if (item.row.handleIssue) continue;
    const match = item.row.handle.match(/^(.+)-\d$/);
    if (match && handles.has(`${item.row.resourceType}:${match[1]}`)) {
      item.row.handleIssue = `looks like a copy of “${match[1]}”`;
      item.issues.add("HANDLE");
    }
  }
}

// Marks RUNNING scans that have stopped reporting progress (e.g. after a server
// restart) as failed so the dashboard doesn't poll forever.
export async function failStaleScans(shop: string) {
  await db.scan.updateMany({
    where: {
      shop,
      status: "RUNNING",
      updatedAt: { lt: new Date(Date.now() - SCAN_STALE_AFTER_MS) },
    },
    data: {
      status: "FAILED",
      completedAt: new Date(),
      error: "The scan was interrupted before it finished. Please run it again.",
    },
  });
}

export async function getLatestScan(shop: string) {
  return db.scan.findFirst({ where: { shop }, orderBy: { startedAt: "desc" } });
}
