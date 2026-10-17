import "server-only";
import { GoogleAuth, IdTokenClient } from "google-auth-library";

const googleAuth = new GoogleAuth();
let identityClient: IdTokenClient | undefined;

export async function backendFetch(url: string, options: RequestInit): Promise<Response> {
  if (!process.env.K_SERVICE) return fetch(url, options);

  const audience = process.env.BACKEND_ID_TOKEN_AUDIENCE ?? new URL(url).origin;
  identityClient ??= await googleAuth.getIdTokenClient(audience);
  const identityHeaders = await identityClient.getRequestHeaders();
  const serviceAuthorization = identityHeaders.get("authorization");
  if (!serviceAuthorization) throw new Error("Backend service identity is unavailable.");

  const headers = new Headers(options.headers);
  headers.set("X-Serverless-Authorization", serviceAuthorization);
  return fetch(url, { ...options, headers });
}