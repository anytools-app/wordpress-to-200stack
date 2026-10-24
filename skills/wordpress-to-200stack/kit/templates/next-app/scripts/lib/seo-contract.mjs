export const SOCIAL_FIELDS = [
  "og:image",
  "og:image:secure_url",
  "og:image:type",
  "og:image:width",
  "og:image:height",
  "og:image:alt",
  "twitter:card",
  "twitter:title",
  "twitter:description",
  "twitter:image",
  "twitter:image:alt",
];

const IMAGE_URL_FIELDS = ["og:image", "og:image:secure_url", "twitter:image"];

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function fieldNames(value) {
  return list(value).filter(nonEmpty);
}

function equalityGroups(value) {
  return list(value).filter(
    (fields) => Array.isArray(fields) && fields.length >= 2 && fields.every((field) => nonEmpty(field)),
  );
}

export function normalizeLookupPath(value) {
  let decoded = String(value || "/").split(/[?#]/, 1)[0];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep malformed percent encoding reportable.
  }
  const withSlash = decoded.startsWith("/") ? decoded : `/${decoded}`;
  return withSlash === "/" ? "/" : withSlash.replace(/\/+$/, "");
}

export function publicPath(value, base = "https://example.invalid") {
  try {
    const url = new URL(value, base);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    const raw = String(value || "/");
    return raw.startsWith("/") ? raw : `/${raw}`;
  }
}

export function expectedPublicPathForLookup(path, trailingSlash = true) {
  const normalized = normalizeLookupPath(path);
  if (!trailingSlash || normalized === "/") return normalized;
  return `${normalized}/`;
}

export function trailingSlashFor(config) {
  return config?.urlPolicy?.trailingSlash !== false;
}

export function archiveSitemapMissingErrors(config) {
  const policy = config?.archiveSitemap;
  return policy?.required === false
    ? []
    : [
        {
          path: "/",
          item: "archiveSitemap.notFound",
          message:
            "保存済みの旧sitemapがありません。取得するか、seo-contract.config.jsonで承認済みwaiverを設定してください",
        },
      ];
}

export function pathMatches(pattern, path) {
  if (!nonEmpty(pattern)) return false;
  const normalized = normalizeLookupPath(path);
  if (pattern === "**" || pattern === "/**") return true;
  if (pattern.endsWith("/**")) {
    const prefix = normalizeLookupPath(pattern.slice(0, -3));
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  }
  return normalizeLookupPath(pattern) === normalized;
}

function socialImageField(item) {
  return (
    item === "og:image" || item === "twitter:image" || item.startsWith("og:image:") || item.startsWith("twitter:image:")
  );
}

export function intentionalDiffMatches(entry, difference) {
  if (!record(entry) || entry.item !== difference.item) return false;
  if (socialImageField(difference.item)) {
    return (
      nonEmpty(entry.path) &&
      normalizeLookupPath(entry.path) === normalizeLookupPath(difference.path) &&
      !entry.path.endsWith("/**")
    );
  }
  return pathMatches(entry.path, difference.path);
}

export function validateIntentionalDiffRegistry(registry) {
  if (!record(registry)) return ["docs/seo-intentional-diffs.json must be an object"];
  const errors = [];
  if (registry.schemaVersion !== 1) errors.push("docs/seo-intentional-diffs.json schemaVersion must be 1");
  if (!Array.isArray(registry.entries)) {
    errors.push("docs/seo-intentional-diffs.json entries must be an array");
    return errors;
  }
  const keys = new Set();
  for (const [index, entry] of registry.entries.entries()) {
    const label = `entries[${index}]`;
    if (!record(entry)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (!nonEmpty(entry.path)) errors.push(`${label}.path is required`);
    if (!nonEmpty(entry.item)) errors.push(`${label}.item is required`);
    if (!nonEmpty(entry.reason)) errors.push(`${label}.reason is required`);
    if (nonEmpty(entry.item) && socialImageField(entry.item) && nonEmpty(entry.path) && entry.path.endsWith("/**")) {
      errors.push(`${label}: social image differences require an exact route path`);
    }
    const key = `${entry.path}\0${entry.item}`;
    if (keys.has(key)) errors.push(`${label}: duplicate path and item`);
    else keys.add(key);
  }
  return errors;
}

export function matchingRouteRules(config, path) {
  return list(config?.routeFamilies).filter((rule) => pathMatches(rule?.pattern, path));
}

function routeRuleFor(config, path) {
  const matches = matchingRouteRules(config, path);
  return matches.length === 1 ? matches[0] : undefined;
}

function mergedRequiredFields(config, rule) {
  return [...new Set([...fieldNames(config?.requiredFields), ...fieldNames(rule?.requiredFields)])];
}

function missingField(field, value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") {
    if (!value.trim()) return true;
    if (field === "h1:count" && Number(value) <= 0) return true;
  }
  return Array.isArray(value) && value.length === 0;
}

export function validateContractConfig(config) {
  const errors = [];
  if (!record(config)) return ["seo-contract.config.json must be an object"];
  if (config.schemaVersion !== 1) errors.push("seo-contract.config.json schemaVersion must be 1");
  if (config.status !== "approved") {
    errors.push("seo-contract.config.json status must be approved before verify:seo can pass");
  }
  if (typeof config.urlPolicy?.trailingSlash !== "boolean") {
    errors.push("seo-contract.config.json urlPolicy.trailingSlash must be boolean");
  }
  if (!record(config.archiveSitemap) || typeof config.archiveSitemap.required !== "boolean") {
    errors.push("seo-contract.config.json archiveSitemap.required must be boolean");
  } else if (config.archiveSitemap.required === false) {
    const waiver = config.archiveSitemap.waiver;
    if (!record(waiver)) {
      errors.push("seo-contract.config.json archiveSitemap.waiver is required when required is false");
    } else {
      if (!nonEmpty(waiver.reason)) errors.push("seo-contract.config.json archiveSitemap.waiver.reason is required");
      if (!nonEmpty(waiver.approvedBy)) {
        errors.push("seo-contract.config.json archiveSitemap.waiver.approvedBy is required");
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(waiver.approvedAt ?? "")) {
        errors.push("seo-contract.config.json archiveSitemap.waiver.approvedAt must be YYYY-MM-DD");
      }
    }
  }
  if (!Array.isArray(config.routeFamilies) || config.routeFamilies.length === 0) {
    errors.push("seo-contract.config.json routeFamilies must contain at least one rule");
  }
  if (
    config.requiredFields !== undefined &&
    (!Array.isArray(config.requiredFields) || config.requiredFields.some((field) => !nonEmpty(field)))
  ) {
    errors.push("seo-contract.config.json requiredFields must be an array");
  }
  if (config.expectedValues !== undefined && !record(config.expectedValues)) {
    errors.push("seo-contract.config.json expectedValues must be an object");
  }
  if (
    config.equalFields !== undefined &&
    (!Array.isArray(config.equalFields) || equalityGroups(config.equalFields).length !== config.equalFields.length)
  ) {
    errors.push("seo-contract.config.json equalFields must contain arrays of at least two field names");
  }
  if (config.retiredRoutes !== undefined && !Array.isArray(config.retiredRoutes)) {
    errors.push("seo-contract.config.json retiredRoutes must be an array");
  }
  const ids = new Set();
  for (const [index, rule] of list(config.routeFamilies).entries()) {
    if (!record(rule)) {
      errors.push(`routeFamilies[${index}] must be an object`);
      continue;
    }
    const label = rule.id ?? rule.pattern ?? `routeFamilies[${index}]`;
    if (!nonEmpty(rule.id)) errors.push(`${label}: id is required`);
    else if (ids.has(rule.id)) errors.push(`${label}: id must be unique`);
    else ids.add(rule.id);
    if (!nonEmpty(rule.pattern)) errors.push(`${label}: pattern is required`);
    if (!nonEmpty(rule.locale)) errors.push(`${label}: locale is required`);
    if (
      rule.requiredFields !== undefined &&
      (!Array.isArray(rule.requiredFields) || rule.requiredFields.some((field) => !nonEmpty(field)))
    ) {
      errors.push(`${label}: requiredFields must be an array`);
    }
    if (rule.expectedValues !== undefined && !record(rule.expectedValues)) {
      errors.push(`${label}: expectedValues must be an object`);
    }
    if (
      rule.equalFields !== undefined &&
      (!Array.isArray(rule.equalFields) ||
        rule.equalFields.some(
          (fields) => !Array.isArray(fields) || fields.length < 2 || fields.some((field) => !nonEmpty(field)),
        ))
    ) {
      errors.push(`${label}: equalFields must contain arrays of at least two field names`);
    }
  }
  const retiredPaths = new Set();
  for (const [index, decision] of list(config.retiredRoutes).entries()) {
    if (!record(decision)) {
      errors.push(`retiredRoutes[${index}] must be an object`);
      continue;
    }
    const label = decision.path ?? `retiredRoutes[${index}]`;
    if (!nonEmpty(decision.path)) errors.push(`${label}: path is required`);
    else if (retiredPaths.has(decision.path)) errors.push(`${label}: path must be unique`);
    else retiredPaths.add(decision.path);
    if (decision.type !== "retire") errors.push(`${label}: type must be retire`);
    if (!nonEmpty(decision.reason)) errors.push(`${label}: reason is required`);
    if (!nonEmpty(decision.approvedBy)) errors.push(`${label}: approvedBy is required`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(decision.approvedAt ?? "")) errors.push(`${label}: approvedAt must be YYYY-MM-DD`);
    if (!nonEmpty(decision.searchEvidence) && !nonEmpty(decision.searchEvidenceWaiver)) {
      errors.push(`${label}: searchEvidence or searchEvidenceWaiver is required`);
    }
  }
  return errors;
}

export function collectRouteFamilyCoverageErrors({ path, config }) {
  const matches = matchingRouteRules(config, path);
  if (matches.length === 1) return [];
  return [
    {
      path,
      item: matches.length ? "contract.routeFamily.ambiguous" : "contract.routeFamily.missing",
      actual: matches.map((rule) => rule.id),
      message: matches.length ? "route must match exactly one route family" : "route has no route family contract",
    },
  ];
}

export function collectRequiredFieldErrors({ path, metadata, config }) {
  const rule = routeRuleFor(config, path);
  return mergedRequiredFields(config, rule).flatMap((field) => {
    const value = metadata.values[field];
    return missingField(field, value) ? [{ path, item: `contract.required.${field}` }] : [];
  });
}

export function collectExpectedValueErrors({ path, metadata, config }) {
  const rule = routeRuleFor(config, path);
  const expectedValues = {
    ...(record(config?.expectedValues) ?? {}),
    ...(rule?.locale ? { "html:lang": rule.locale } : {}),
    ...(record(rule?.expectedValues) ?? {}),
  };
  return Object.entries(expectedValues).flatMap(([field, expected]) => {
    const actual = metadata.values[field];
    return actual !== expected ? [{ path, item: `contract.expected.${field}`, expected, actual }] : [];
  });
}

export function collectEqualityErrors({ path, metadata, config }) {
  const rule = routeRuleFor(config, path);
  const equalFields = [...equalityGroups(config?.equalFields), ...equalityGroups(rule?.equalFields)];
  return equalFields.flatMap((fields) => {
    const values = fields.map((field) => [field, metadata.values[field]]);
    const [firstField, firstValue] = values[0] ?? [];
    return values.some(([, value]) => value !== firstValue)
      ? [
          {
            path,
            item: `contract.equal.${fields.join("=")}`,
            expected: { [firstField]: firstValue },
            actual: Object.fromEntries(values),
          },
        ]
      : [];
  });
}

export function collectSocialImageEvidenceErrors(config) {
  return list(config?.routeFamilies).flatMap((rule) => {
    if (!record(rule)) return [];
    const social = rule.socialImage;
    const requiresImage = mergedRequiredFields(config, rule).some((field) => IMAGE_URL_FIELDS.includes(field));
    if (!requiresImage && !social?.requiresProvenance) return [];
    const label = rule.id ?? rule.pattern;
    const errors = [];
    if (!nonEmpty(social?.source)) {
      errors.push({ path: rule.pattern, item: "contract.socialImage.source", message: `${label}: source is required` });
    }
    if (!nonEmpty(social?.provenanceRef)) {
      errors.push({
        path: rule.pattern,
        item: "contract.socialImage.provenanceRef",
        message: `${label}: provenanceRef is required`,
      });
    }
    const contrastiveSamples = Array.isArray(social?.contrastiveSamples)
      ? social.contrastiveSamples.filter(nonEmpty)
      : nonEmpty(social?.contrastiveSample)
        ? [social.contrastiveSample]
        : [];
    if (contrastiveSamples.length === 0 && !nonEmpty(social?.singleCandidateReason)) {
      errors.push({
        path: rule.pattern,
        item: "contract.socialImage.contrastiveSample",
        message: `${label}: contrastiveSamples or singleCandidateReason is required`,
      });
    }
    return errors;
  });
}

export function collectSocialMetadataFormatErrors({ path, metadata }) {
  const errors = [];
  for (const field of IMAGE_URL_FIELDS) {
    const value = metadata.values[field];
    if (!value) continue;
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
      if (field === "og:image:secure_url" && url.protocol !== "https:") {
        errors.push({ path, item: `${field}.https`, actual: value, message: "secure_url must use https" });
      }
    } catch {
      errors.push({
        path,
        item: `${field}.absoluteUrl`,
        actual: value,
        message: "social image must be an absolute HTTP(S) URL",
      });
    }
  }
  for (const field of ["og:image:width", "og:image:height"]) {
    const value = metadata.values[field];
    if (value !== undefined && (!/^\d+$/.test(String(value)) || Number(value) <= 0)) {
      errors.push({ path, item: `${field}.positiveInteger`, actual: value });
    }
  }
  return errors;
}

export function classifyRetiredPath(path, config, aliases = {}) {
  const lookup = normalizeLookupPath(path);
  for (const [currentPath, legacyPath] of Object.entries(aliases)) {
    if (normalizeLookupPath(legacyPath) === lookup) {
      return { type: "redirect", target: normalizeLookupPath(currentPath) };
    }
  }
  for (const rule of list(config?.retiredRoutes)) {
    if (!record(rule)) continue;
    if (pathMatches(rule.path, lookup)) return rule;
  }
  return undefined;
}

export function collectRetiredRouteErrors({
  archivePaths,
  outputPaths,
  sitemapPaths,
  outputPublicPaths,
  sitemapPublicPaths,
  aliases,
  config,
  trailingSlash = true,
}) {
  return [...archivePaths].flatMap((path) => {
    const lookup = normalizeLookupPath(path);
    const expectedPublicPath = expectedPublicPathForLookup(lookup, trailingSlash);
    const hasOutput = outputPublicPaths ? outputPublicPaths.has(expectedPublicPath) : outputPaths.has(lookup);
    const hasSitemap = sitemapPublicPaths ? sitemapPublicPaths.has(expectedPublicPath) : sitemapPaths.has(lookup);
    if (hasOutput && hasSitemap) return [];
    if (hasOutput || hasSitemap) {
      return [
        {
          path: lookup,
          item: "archiveSitemap.preserveIncomplete",
          expected: { output: true, sitemap: true },
          actual: { output: hasOutput, sitemap: hasSitemap },
        },
      ];
    }
    const classification = classifyRetiredPath(lookup, config, aliases);
    if (classification?.type === "retire") return [];
    if (classification?.type === "redirect") {
      const targetInOutput = outputPaths.has(classification.target);
      const targetInSitemap = sitemapPaths.has(classification.target);
      return targetInOutput && targetInSitemap
        ? []
        : [
            {
              path: lookup,
              item: "archiveSitemap.redirectTargetMissing",
              expected: { output: true, sitemap: true },
              actual: {
                target: classification.target,
                output: targetInOutput,
                sitemap: targetInSitemap,
              },
            },
          ];
    }
    return [
      {
        path: lookup,
        item: "archiveSitemap.unclassifiedRetire",
        message: "archive indexable route disappeared without preserve/redirect/retire classification",
      },
    ];
  });
}

export function exactTrailingSlashErrors({ route, metadata, siteOrigin, trailingSlash = true }) {
  const expected = expectedPublicPathForLookup(route, trailingSlash);
  return ["canonical", "og:url"].flatMap((field) => {
    const value = metadata.values[field];
    if (!value) return [];
    const actualPath = publicPath(value, siteOrigin);
    return actualPath === expected
      ? []
      : [
          {
            path: route,
            item: `${field}.publicPath`,
            expected,
            actual: actualPath,
            message: "public URL path must match trailingSlash contract exactly",
          },
        ];
  });
}

export function collectInternalHrefErrors({ sourcePath, hrefs, outputPaths, siteOrigin, trailingSlash = true }) {
  const base = new URL(expectedPublicPathForLookup(sourcePath, trailingSlash), siteOrigin);
  return hrefs.flatMap((href) => {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      return [];
    }
    if (url.origin !== base.origin) return [];
    const lookup = normalizeLookupPath(url.pathname);
    if (!outputPaths.has(lookup)) return [];
    const expected = expectedPublicPathForLookup(lookup, trailingSlash);
    return url.pathname === expected
      ? []
      : [{ sourcePath, path: lookup, item: "internalHref.publicPath", expected, actual: url.pathname, href }];
  });
}
