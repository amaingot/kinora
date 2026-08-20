import { expect, test } from '@playwright/test'

// Runs against the second stack booted by playwright.config.ts: KINORA_DISABLE_PASSWORD_AUTH=true
// with OIDC configured. The IdP itself is never reached - these cover the dashboard's gating,
// which is driven entirely by config.get.

test('offers only SSO, with no credentials UI', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('button', { name: /Continue with E2E SSO/i })).toBeVisible()
  await expect(page.locator('input[type="email"]')).toHaveCount(0)
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  // The "or" divider only makes sense above an email form.
  await expect(page.getByText('or', { exact: true })).toHaveCount(0)
  // No "Create one" / "Forgot password?" links to dead routes.
  await expect(page.getByRole('link')).toHaveCount(0)
})

test('redirects the password-only routes to login', async ({ page }) => {
  for (const path of ['/signup', '/forgot-password']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/login$/)
  }
})

test('keeps the invite destination when bouncing signup to login', async ({ page }) => {
  // The invite page's "Create account" CTA points at /signup?redirect=/accept-invite/<id>.
  // Dropping that query would strand a first-time SSO user on the overview.
  await page.goto('/signup?redirect=/accept-invite/abc123')
  await expect(page).toHaveURL(/\/login\?redirect=%2Faccept-invite%2Fabc123$|\/login\?redirect=\/accept-invite\/abc123$/)
  await expect(page.getByRole('button', { name: /Continue with E2E SSO/i })).toBeVisible()
})

test('carries a device-approval deep link through to SSO', async ({ page }) => {
  await page.goto('/device?user_code=ABCD-EFGH')
  await expect(page).toHaveURL(/\/login\?redirect=/)
  await expect(page).toHaveURL(/user_code/)
  await expect(page.getByRole('button', { name: /Continue with E2E SSO/i })).toBeVisible()
})

test('surfaces a failed callback error instead of a bare page', async ({ page }) => {
  // Where the server's onAPIError.errorURL sends a cancelled sign-in.
  await page.goto('/login?error=access_denied')
  await expect(page.getByText(/Sign-in was cancelled/i)).toBeVisible()
})
