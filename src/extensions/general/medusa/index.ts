import type { Extension } from '@/lib/extensions/types'
import { medusaApiRoutes } from './api-routes'

/**
 * Medusa extension
 *
 * Connects a company's self-hosted Medusa v2 backend via a merchant-created
 * secret API key (Settings > API Key Management > Secret keys in their own
 * Medusa admin) and imports the store's paid orders as rows in the Orders
 * workspace (webshop_orders). Feed-only (same doctrine as the WooCommerce/
 * Shopify/Zettle feeds): nothing is auto-booked, the user books each row
 * from the Orders page.
 *
 * Built for the dtc-platform-template project (a generic, config-driven
 * fork of a Swedish DTC storefront + Medusa backend, see that repo's
 * tenant.config.json): this extension is the Accounted-side half of the
 * sync, replacing a bespoke Python worker with the same integration
 * mechanism WooCommerce/Shopify/Zettle already use here.
 *
 * v1 scope is narrower than the longer-lived feeds (see lib/order-sync.ts
 * for the exact gaps): orders only, no refund rows yet, and a single VAT
 * bucket per order rather than Shopify/WooCommerce's per-rate
 * reconstruction. Not verified against a live Medusa instance in this
 * environment.
 *
 * Required environment variables:
 * - MEDUSA_CREDENTIALS_ENCRYPTION_KEY (at-rest key for the admin API key)
 */
export const medusaExtension: Extension = {
  id: 'medusa',
  name: 'Medusa',
  version: '1.0.0',
  sector: 'general',

  settingsPanel: {
    label: 'Medusa',
    path: '/import?mode=medusa',
  },

  apiRoutes: medusaApiRoutes,
}

export default medusaExtension
