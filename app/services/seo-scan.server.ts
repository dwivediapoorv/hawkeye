import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  DESCRIPTION_MAX_LENGTH,
  FALLBACK_DESCRIPTION_TRUNCATE_AT,
  SCAN_STALE_AFTER_MS,
  TITLE_MAX_LENGTH,
} from "../seo/limits";
import { checkStructuredData, type SampledPages } from "./structured-data.server";

type GraphqlClient = AdminApiContext["graphql"];

type SeoNode = {
  id: string;
  title: string;
  handle: string;
  description: string | null;
  seo: { title: string | null; description: string | null };
};

type Connection = {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: SeoNode[];
};

type ThrottleStatus = {
  requestedQueryCost: number;
  throttleStatus: { currentlyAvailable: number; restoreRate: number };
};

// How many live storefront pages of each type the structured data check samples.
const PRODUCT_PAGE_SAMPLES = 5;
const COLLECTION_PAGE_SAMPLES = 3;

const PRODUCTS_QUERY = `#graphql
  query SeoScanProducts($cursor: String, $truncateAt: Int!) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        description(truncateAt: $truncateAt)
        seo { title description }
      }
    }
  }`;

const COLLECTIONS_QUERY = `#graphql
  query SeoScanCollections($cursor: String, $truncateAt: Int!) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        description(truncateAt: $truncateAt)
        seo { title description }
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

async function* paginate(
  graphql: GraphqlClient,
  document: string,
  field: "products" | "collections",
) {
  let cursor: string | null = null;
  do {
    const data: Record<string, Connection> = await query(graphql, document, {
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

type ItemRow = {
  scanId: string;
  resourceType: "PRODUCT" | "COLLECTION";
  resourceId: string;
  handle: string;
  name: string;
} & ReturnType<typeof evaluateNode>;

async function runScan(scanId: string, graphql: GraphqlClient) {
  const totals = {
    productCount: 0,
    collectionCount: 0,
    longTitleCount: 0,
    longDescriptionCount: 0,
    missingDescriptionCount: 0,
    duplicateTitleCount: 0,
  };

  // Every item keyed by its (case-insensitive) meta title, so duplicates can be
  // found once the whole catalog has been read. `stored` tracks whether the row
  // was already written because of another issue.
  const byTitle = new Map<string, { row: ItemRow; stored: boolean }[]>();
  const samples: SampledPages = { products: [], collections: [] };

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

  const sources = [
    { type: "PRODUCT", document: PRODUCTS_QUERY, field: "products", counter: "productCount", sample: samples.products, sampleSize: PRODUCT_PAGE_SAMPLES },
    { type: "COLLECTION", document: COLLECTIONS_QUERY, field: "collections", counter: "collectionCount", sample: samples.collections, sampleSize: COLLECTION_PAGE_SAMPLES },
  ] as const;

  for (const source of sources) {
    for await (const nodes of paginate(graphql, source.document, source.field)) {
      totals[source.counter] += nodes.length;

      for (const node of nodes.slice(0, source.sampleSize - source.sample.length)) {
        source.sample.push({ title: node.title, handle: node.handle });
      }

      const rows: ItemRow[] = nodes.map((node) => ({
        scanId,
        resourceType: source.type,
        resourceId: node.id,
        handle: node.handle,
        name: node.title,
        ...evaluateNode(node),
      }));

      const flagged = rows.filter(
        (r) => r.titleTooLong || r.descriptionTooLong || r.descriptionMissing,
      );
      for (const row of flagged) {
        if (row.titleTooLong) totals.longTitleCount++;
        if (row.descriptionTooLong) totals.longDescriptionCount++;
        if (row.descriptionMissing) totals.missingDescriptionCount++;
      }
      for (const row of rows) {
        const key = row.metaTitle.toLowerCase();
        if (!key) continue;
        const group = byTitle.get(key) ?? [];
        group.push({ row, stored: flagged.includes(row) });
        byTitle.set(key, group);
      }

      if (flagged.length) {
        await db.scanItem.createMany({ data: flagged });
      }

      // Keep the dashboard's progress counters moving while the scan runs.
      await db.scan.update({ where: { id: scanId }, data: totals });
    }
  }

  // Duplicate meta titles: upgrade rows already stored, insert the rest.
  const duplicateGroups = [...byTitle.values()].filter((g) => g.length > 1);
  const toUpdate: string[] = [];
  const toInsert: ItemRow[] = [];
  for (const group of duplicateGroups) {
    for (const { row, stored } of group) {
      totals.duplicateTitleCount++;
      if (stored) toUpdate.push(row.resourceId);
      else toInsert.push(row);
    }
  }
  if (toUpdate.length) {
    await db.scanItem.updateMany({
      where: { scanId, resourceId: { in: toUpdate } },
      data: { titleDuplicate: true },
    });
  }
  if (toInsert.length) {
    await db.scanItem.createMany({
      data: toInsert.map((row) => ({ ...row, titleDuplicate: true })),
    });
  }
  await db.scan.update({ where: { id: scanId }, data: totals });

  // Structured data on a sample of live storefront pages.
  const { blocked, checks } = await checkStructuredData(
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
      ...totals,
      storefrontBlocked: blocked,
      schemaIssueCount: checks.filter((c) => c.status !== "OK").length,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
}

// Marks RUNNING scans that can no longer be in progress (e.g. after a server
// restart) as failed so the dashboard doesn't poll forever.
export async function failStaleScans(shop: string) {
  await db.scan.updateMany({
    where: {
      shop,
      status: "RUNNING",
      startedAt: { lt: new Date(Date.now() - SCAN_STALE_AFTER_MS) },
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
