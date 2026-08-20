import { randomUUID } from 'node:crypto'
import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, bearer, deviceAuthorization, genericOAuth, lastLoginMethod, organization } from 'better-auth/plugins'
import { and, eq } from 'drizzle-orm'
import { polarAuthPlugin, polarClient } from '../billing/polar'
import { db } from '../db'
import { member, organization as organizationTable } from '../db/schemas/index'
import { purgeUserOwnedData } from './account'
import { demo, env, githubOauthEnabled, googleOauthEnabled, oidc, OIDC_PROVIDER_ID, passwordAuthEnabled } from './env'
import { logger } from './logger'
import { mailerEnabled, sendMail } from './mailer'
import { getTrustedOrigins } from './utils'

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'team'
}

async function sendResetPassword({ user, url }: { user: { email: string, name?: string | null }, url: string }): Promise<void> {
  sendMail({
    to: user.email,
    subject: 'Reset your kinora password',
    text: `Hi${user.name ? ` ${user.name}` : ''},\n\nSomeone requested a password reset for your kinora account. Click the link below to choose a new password:\n\n${url}\n\nThe link expires in 1 hour. If you didn't ask for this, you can safely ignore this email.`,
  })
}

const polarPlugin = polarAuthPlugin()

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  baseURL: env.BASE_URL,
  trustedOrigins: getTrustedOrigins(),
  emailAndPassword: {
    enabled: passwordAuthEnabled,
    // better-auth gates /forget-password on this callback existing, never on `enabled`, and
    // /reset-password isn't gated at all (it would create a credential account). Omitting the
    // callback is what actually closes the password-reset path on an SSO-only install.
    ...(passwordAuthEnabled ? { sendResetPassword } : {}),
  },
  emailVerification: {
    sendOnSignUp: mailerEnabled,
    sendVerificationEmail: async ({ user, url }) => {
      sendMail({
        to: user.email,
        subject: 'Verify your kinora email',
        text: `Hi${user.name ? ` ${user.name}` : ''},\n\nConfirm this address for your kinora account by clicking the link below:\n\n${url}\n\nIf you didn't create a kinora account, you can safely ignore this email.`,
      })
    },
  },
  socialProviders: {
    ...(googleOauthEnabled ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
    ...(githubOauthEnabled ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } } : {}),
  },
  account: {
    accountLinking: {
      enabled: true,
      // Trust the corporate IdP: an OIDC identity lands in the existing kinora account with the
      // same email, so self-hosters move existing users onto SSO without losing their projects.
      trustedProviders: oidc ? [OIDC_PROVIDER_ID] : [],
      // Independent of trustedProviders: without this, every user on a no-SMTP self-host (where
      // emailVerified is never set) fails to link. Only relaxed when OIDC is actually configured.
      // TODO(better-auth): deprecated, removed in the next minor - the gate becomes unconditional.
      ...(oidc ? { requireLocalEmailVerified: false } : {}),
    },
  },
  user: {
    deleteUser: {
      enabled: true,
      // Fresh session or password required by better-auth; we just clean up owned data first.
      beforeDelete: async (u) => {
        await purgeUserOwnedData(u.id)
        if (polarClient) {
          try {
            await polarClient.customers.deleteExternal({ externalId: u.id })
          }
          catch (error) {
            logger.warn({ error, userId: u.id }, 'polar customer deletion skipped')
          }
        }
      },
    },
    changeEmail: {
      enabled: true,
      updateEmailWithoutVerification: !mailerEnabled,
      sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
        sendMail({
          to: user.email,
          subject: 'Approve your kinora email change',
          text: `Hi${user.name ? ` ${user.name}` : ''},\n\nApprove changing your kinora email to ${newEmail} by clicking the link below:\n\n${url}\n\nIf you didn't request this, ignore this email and your address stays the same.`,
        })
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Every account owns one personal organization; projects + billing live on it.
        after: async (createdUser) => {
          const orgId = randomUUID()
          const base = slugify(createdUser.name || createdUser.email.split('@')[0] || 'team')
          await db.insert(organizationTable).values({
            id: orgId,
            name: createdUser.name ? `${createdUser.name}'s workspace` : 'My workspace',
            slug: `${base}-${randomUUID().slice(0, 8)}`,
          })
          await db.insert(member).values({
            id: randomUUID(),
            organizationId: orgId,
            userId: createdUser.id,
            role: 'owner',
          })

          if (polarClient) {
            try {
              await polarClient.customers.create({ email: createdUser.email, name: createdUser.name, externalId: createdUser.id })
            }
            catch (error) {
              logger.warn({ error, userId: createdUser.id }, 'polar customer creation skipped')
            }
          }
        },
      },
    },
    session: {
      create: {
        // Default the session to the org the user owns (a user may also be a member of others).
        before: async (session) => {
          const owned = await db.query.member.findFirst({
            where: and(eq(member.userId, session.userId), eq(member.role, 'owner')),
            columns: { organizationId: true },
          })
          return { data: { ...session, activeOrganizationId: owned?.organizationId ?? null } }
        },
      },
    },
  },
  advanced: {
    ...(env.COOKIE_DOMAIN ? { crossSubDomainCookies: { enabled: true, domain: env.COOKIE_DOMAIN } } : {}),
    // Demo runs on a *.kinora.dev subdomain next to prod; a distinct cookie name stops prod's
    ...(demo ? { cookiePrefix: 'kinora-demo' } : {}),
  },
  secret: env.AUTH_SECRET,
  plugins: [
    // Plugin default is 10 req/day per key, which any real CI exceeds, billing quotas already cap ingest volume.
    apiKey({ rateLimit: { enabled: false } }),
    bearer(),
    // schema: {} works around better-auth 1.6.14 requiring the (otherwise-optional) schema option.
    deviceAuthorization({ schema: {}, verificationUri: `${env.WEB_ORIGIN}/device` }),
    lastLoginMethod(),
    organization({
      // Only the auto-created personal org exists; members can't spin up extra orgs.
      allowUserToCreateOrganization: false,
      sendInvitationEmail: async (data) => {
        // The UI also surfaces the accept link from the invite response, so no-SMTP setups still work.
        logger.info({ invitationId: data.id, email: data.email, org: data.organization.name }, 'org invitation created')
        const inviter = data.inviter.user.name || data.inviter.user.email
        sendMail({
          to: data.email,
          subject: `Join ${data.organization.name} on kinora`,
          text: `${inviter} invited you to the "${data.organization.name}" workspace on kinora.\n\nAccept the invitation:\n\n${env.WEB_ORIGIN}/accept-invite/${data.id}\n\nIf you weren't expecting this, you can safely ignore this email.`,
        })
      },
    }),
    admin(),
    ...(oidc
      ? [genericOAuth({
          config: [{
            providerId: OIDC_PROVIDER_ID,
            discoveryUrl: oidc.discoveryUrl,
            issuer: oidc.issuerUrl,
            clientId: oidc.clientId,
            clientSecret: oidc.clientSecret,
            scopes: oidc.scopes,
            pkce: oidc.pkce,
            // The callback hard-fails with "name_is_missing" when the IdP returns no `name`
            // claim, which plenty of Keycloak/Authentik setups don't. Fall back, don't reject.
            mapProfileToUser: (profile: Record<string, unknown>) => ({
              name: String(
                profile.name || profile.preferred_username || profile.given_name
                || String(profile.email ?? '').split('@')[0],
              ),
            }),
          }],
        })]
      : []),
    ...(polarPlugin ? [polarPlugin] : []),
  ],
})

export interface AuthType {
  user: typeof auth.$Infer.Session.user | null
  session: typeof auth.$Infer.Session.session | null
}
