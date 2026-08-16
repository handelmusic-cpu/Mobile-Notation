// Custom domains are where self-hosting usually stalls, so Pagesmith spells out
// exactly which records to enter at the registrar and then checks them for you.

import { Resolver } from "node:dns/promises";

// GitHub's published Pages addresses. They are stable and documented; hardcoding
// them is what lets the app say "add these four A records" before any lookup.
export const APEX_A = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"];
export const APEX_AAAA = [
  "2606:50c0:8000::153",
  "2606:50c0:8001::153",
  "2606:50c0:8002::153",
  "2606:50c0:8003::153",
];

export function isApex(domain) {
  // Good enough for the domains a person actually owns: "a.com" is apex,
  // "www.a.com" is not. Multi-label public suffixes (co.uk) are treated as apex
  // only when the name has two labels, which is the same rule GitHub applies.
  return domain.split(".").length === 2;
}

// The records the user must create, in the shape a registrar's form asks for.
export function requiredRecords(domain, login) {
  const target = `${login}.github.io`;
  if (!isApex(domain)) {
    return [{ type: "CNAME", name: hostLabel(domain), value: target }];
  }
  return [
    ...APEX_A.map((ip) => ({ type: "A", name: "@", value: ip })),
    ...APEX_AAAA.map((ip) => ({ type: "AAAA", name: "@", value: ip })),
    // Not required, but every visitor who types www expects it to work.
    { type: "CNAME", name: "www", value: target, optional: true },
  ];
}

function hostLabel(domain) {
  return domain.split(".")[0];
}

// Resolves the domain against public resolvers rather than the machine's own,
// because a local resolver may still be serving a cached pre-move answer.
export async function checkDomain(domain, login) {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const target = `${login}.github.io`;

  if (!isApex(domain)) {
    const cname = await safe(() => resolver.resolveCname(domain));
    const ok = (cname.value || []).some((v) => v.replace(/\.$/, "").toLowerCase() === target);
    return {
      domain,
      kind: "cname",
      ok,
      found: cname.value || [],
      expected: [target],
      error: cname.error,
      advice: ok
        ? "DNS looks right."
        : `Point ${domain} at ${target} with a CNAME record, then check again.`,
    };
  }

  const a = await safe(() => resolver.resolve4(domain));
  const found = a.value || [];
  const matched = APEX_A.filter((ip) => found.includes(ip));
  const ok = matched.length === APEX_A.length;
  const partial = matched.length > 0 && !ok;
  return {
    domain,
    kind: "apex",
    ok,
    found,
    expected: APEX_A,
    error: a.error,
    advice: ok
      ? "DNS looks right. HTTPS can take up to an hour after this first turns green."
      : partial
        ? `Only ${matched.length} of 4 GitHub A records are in place. Add the rest.`
        : `Replace the A records for ${domain} with the four GitHub addresses listed above.`,
  };
}

async function safe(fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    // NODATA/NOTFOUND is the normal answer before the records exist; it is
    // information for the user, not a failure of the check.
    return { error: err.code || err.message };
  }
}
