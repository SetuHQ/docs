## Summary

Update 18 stale internal links across 14 MDX files to point directly to their current page paths, eliminating unnecessary redirect hops for users and crawlers.

## Changes

### Bridge org-settings links → `/dev-tools/bridge/overview` (10 instances)

Old `/dev-tools/bridge/org-settings/api-keys/jwt` and `/oauth` pages no longer exist. Updated across:
- `payments/bbps/resources/jwt.mdx` (2 links)
- `payments/bbps/resources/oauth.mdx` (1 link)
- `payments/upi-deeplinks/resources/jwt.mdx` (2 links)
- `payments/upi-deeplinks/resources/oauth.mdx` (1 link)
- `dev-tools/bridge/v1/generate-token.mdx` (1 link)
- `dev-tools/bridge/v1/org-settings/api-keys/jwt-auth.mdx` (2 links)
- `dev-tools/bridge/v1/org-settings/api-keys/jwt.mdx` (1 link)

### BillPay links → correct `pre-built-screens` paths (6 instances)

Content was moved under `pre-built-screens/` but links still used old paths. Updated both default and v1 versions:

| Old link | New link |
|---|---|
| `/payments/billpay/custom-payment/cross-platform` | `/payments/billpay/pre-built-screens/custom-payment/cross-platform` |
| `/payments/billpay/quickstart/iOS` | `/payments/billpay/pre-built-screens/quickstart/iOS` |
| `/payments/billpay/quickstart/cross-platform` | `/payments/billpay/pre-built-screens/quickstart/cross-platform` |

### Removed pages (2 instances)

| Old link | New link | File |
|---|---|---|
| `/payments/umap/notifications/disputes` | `/payments/umap/overview` | `payments/umap/refunds-disputes.mdx` |
| `/data/okyc/overview` | `/data` | `data/digilocker/quickstart.mdx` |

## Verification

- Fetched each MDX from GitHub to confirm old links exist before editing
- Confirmed old URLs are redirect destinations in the docs-mdx SEO branches
- BillPay links pointed to actual content pages (verified via file existence) rather than parent pages, preserving user intent
- Grep confirmed zero remaining instances of old URL patterns after edits

## Test plan

- [ ] Verify pages render correctly on staging after merge
- [ ] Click updated links on affected pages — should navigate directly without redirect hop in Network tab
