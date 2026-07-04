import * as oidc from 'openid-client';
import { getSetting } from '../settings.js';

// OIDC (Authentik / Authelia / Keycloak / any compliant provider), configured
// by the admin. Authorization-code flow with PKCE; discovery is cached until
// the settings change.

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
}

export function getOidcSettings(): OidcSettings | null {
  const issuer = getSetting('oidc.issuer');
  const clientId = getSetting('oidc.clientId');
  const clientSecret = getSetting('oidc.clientSecret');
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer, clientId, clientSecret, label: getSetting('oidc.label') || 'SSO' };
}

let cached: { key: string; config: oidc.Configuration } | null = null;

export function clearOidcCache(): void {
  cached = null;
}

export async function getOidcConfiguration(): Promise<oidc.Configuration> {
  const settings = getOidcSettings();
  if (!settings) throw new Error('OIDC is not configured');
  const key = `${settings.issuer}|${settings.clientId}|${settings.clientSecret}`;
  if (cached?.key === key) return cached.config;
  const config = await oidc.discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret);
  cached = { key, config };
  return config;
}

export function oidcRedirectUri(): string {
  const appUrl = getSetting('app.url');
  if (!appUrl) throw new Error('Set the public app URL in Admin settings first (OIDC needs it for the redirect)');
  return `${appUrl.replace(/\/+$/, '')}/api/auth/oidc/callback`;
}
