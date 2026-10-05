import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SHOP_PROFILE_QUERY = `#graphql
  query HawkEyeShopProfile {
    shop {
      name
      email
      contactEmail
      shopOwnerName
      billingAddress { phone country }
      plan { displayName partnerDevelopment }
    }
  }`;

// Records the store on every app load (covers install and reinstall) and
// refreshes its contact profile from Shopify at most once a day.
export async function touchShop(shop: string, graphql: AdminApiContext["graphql"]) {
  const record = await db.shop.upsert({
    where: { domain: shop },
    create: { domain: shop },
    update: { lastSeenAt: new Date(), uninstalledAt: null },
  });

  const stale =
    !record.profileSyncedAt ||
    Date.now() - record.profileSyncedAt.getTime() > PROFILE_MAX_AGE_MS;
  if (!stale) return;

  try {
    const response = await graphql(SHOP_PROFILE_QUERY);
    const { data } = (await response.json()) as {
      data?: {
        shop: {
          name: string;
          email: string;
          contactEmail: string;
          shopOwnerName: string;
          billingAddress: { phone: string | null; country: string | null };
          plan: { displayName: string; partnerDevelopment: boolean };
        };
      };
    };
    if (!data) return;
    const { shop: s } = data;
    await db.shop.update({
      where: { domain: shop },
      data: {
        shopName: s.name,
        ownerName: s.shopOwnerName,
        email: s.email,
        contactEmail: s.contactEmail,
        phone: s.billingAddress?.phone ?? null,
        country: s.billingAddress?.country ?? null,
        shopifyPlan: s.plan.displayName,
        isDevStore: s.plan.partnerDevelopment,
        profileSyncedAt: new Date(),
      },
    });
  } catch (error) {
    // The profile is nice-to-have; never block the app from loading over it.
    console.error(`Could not sync shop profile for ${shop}`, error);
  }
}
