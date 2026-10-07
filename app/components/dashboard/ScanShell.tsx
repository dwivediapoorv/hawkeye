import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { DashboardData } from "../../services/dashboard.server";
import { ScanIntro, ScanProgress } from "../ScanHero";

type ScanProgressFields = {
  productCount: number;
  collectionCount: number;
  productTotal: number | null;
  collectionTotal: number | null;
  pagesChecked: number;
  pagesTotal: number | null;
};

// Reading the catalog fills the bar to 80%; checking storefront pages fills the rest.
const CATALOG_SHARE = 0.8;

function scanProgress(
  scan: ScanProgressFields | null,
  finished: boolean,
): { value: number; label: string } {
  if (finished) return { value: 1, label: "Scan complete" };
  if (!scan || scan.productTotal === null || scan.collectionTotal === null) {
    return { value: 0, label: "Initializing…" };
  }
  if (scan.pagesTotal !== null) {
    return {
      value: CATALOG_SHARE + (1 - CATALOG_SHARE) * (scan.pagesChecked / Math.max(1, scan.pagesTotal)),
      label: `Checking storefront pages · ${scan.pagesChecked} of ${scan.pagesTotal}`,
    };
  }
  const read = scan.productCount + scan.collectionCount;
  const value = CATALOG_SHARE * Math.min(1, read / Math.max(1, scan.productTotal + scan.collectionTotal));
  if (scan.productCount < scan.productTotal) {
    return { value, label: `Reading products · ${scan.productCount} of ${scan.productTotal}` };
  }
  if (scan.collectionCount < scan.collectionTotal) {
    return { value, label: `Reading collections · ${scan.collectionCount} of ${scan.collectionTotal}` };
  }
  return { value, label: "Checking storefront pages…" };
}

// The page frame every dashboard layout shares: the scan button, progress bar,
// failure/upgrade banners and the first-run empty state. `children` (the
// layout's results) render only once there is a scan that isn't running.
export function ScanShell({ data, children }: { data: DashboardData; children: ReactNode }) {
  const { scan, groupCounts } = data;
  const fetcher = useFetcher<{ started: boolean; error?: string }>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const isRunning = scan?.status === "RUNNING";
  const isStarting =
    ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";
  const busy = isRunning || isStarting;

  // When a scan finishes, hold the bar at 100% for a moment before the results appear.
  const [finishing, setFinishing] = useState(false);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && scan?.status === "COMPLETED") setFinishing(true);
    wasBusy.current = busy;
  }, [busy, scan?.status]);
  useEffect(() => {
    if (!finishing) return;
    const timer = setTimeout(() => setFinishing(false), 2200);
    return () => clearTimeout(timer);
  }, [finishing]);

  const showProgress = busy || finishing;

  // Poll while a scan is in progress so the progress bar moves.
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2000);
    return () => clearInterval(interval);
  }, [isRunning, revalidator]);

  useEffect(() => {
    if (fetcher.data && !fetcher.data.started && fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const runScan = () => fetcher.submit({}, { method: "POST" });

  return (
    <s-page heading="Hawkeye" inlineSize="large">
      {/* The empty state and the progress bar have their own scan control. */}
      {scan && !showProgress && (
        <s-button slot="primary-action" onClick={runScan}>
          Run scan again
        </s-button>
      )}

      {showProgress && (
        <s-section>
          <ScanProgress {...scanProgress(isRunning || finishing ? scan : null, finishing)} />
        </s-section>
      )}

      {scan?.status === "FAILED" && !showProgress && (
        <s-banner heading="The last scan failed" tone="critical">
          <s-paragraph>{scan.error ?? "Unknown error."}</s-paragraph>
        </s-banner>
      )}

      {groupCounts?.legacy && !showProgress && (
        <s-banner heading="Hawkeye checks more now" tone="info">
          <s-paragraph>
            Run a new scan to check image alt text, thin and copied content,
            URLs, and indexing, headings, social tags and broken links on your
            storefront pages.
          </s-paragraph>
        </s-banner>
      )}

      {!scan && !showProgress && (
        <s-section>
          <ScanIntro heading="Scan your store for SEO issues" onScan={runScan} disabled={busy}>
            The scan reads every active product and collection and checks meta
            titles and descriptions, image alt text, content and URLs. It also
            checks your live storefront pages for indexing problems,
            structured data, headings, social sharing tags, slow images and
            broken links.
          </ScanIntro>
        </s-section>
      )}

      {scan && !showProgress && children}
    </s-page>
  );
}
