import type { Music21Container } from "./server.ts";

export interface AuthProps {
  email: string;
  name: string;
  sub: string;
}

export interface Env {
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_ISSUER: string;
  ACCESS_JWKS_URL: string;
  ACCESS_TOKEN_URL: string;
  ALLOWED_EMAILS: string;
  MUSIC21_CONTAINER: DurableObjectNamespace<Music21Container>;
  OAUTH_KV: KVNamespace;
}
