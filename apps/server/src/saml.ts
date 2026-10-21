import { SAML } from "@node-saml/node-saml";
import type { SamlConfig } from "./env.js";

let cached: { config: SamlConfig; saml: SAML } | null = null;

export function getSaml(config: SamlConfig): SAML {
  if (cached && cached.config === config) return cached.saml;

  const saml = new SAML({
    entryPoint: config.entryPoint,
    issuer: config.issuer,
    callbackUrl: config.callbackUrl,
    idpCert: config.idpCert,
    audience: config.audience,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 5000,
  });

  cached = { config, saml };
  return saml;
}
