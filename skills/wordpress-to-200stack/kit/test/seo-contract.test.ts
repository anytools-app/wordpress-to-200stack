import { describe, expect, it } from "vitest";

const {
  archiveSitemapMissingErrors,
  collectExpectedValueErrors,
  collectInternalHrefErrors,
  collectRequiredFieldErrors,
  collectRetiredRouteErrors,
  collectRouteFamilyCoverageErrors,
  collectSocialImageEvidenceErrors,
  collectSocialMetadataFormatErrors,
  expectedPublicPathForLookup,
  exactTrailingSlashErrors,
  intentionalDiffMatches,
  normalizeLookupPath,
  publicPath,
  validateContractConfig,
  validateIntentionalDiffRegistry,
  // @ts-ignore The template helper is plain ESM copied into generated Next apps.
} = (await import("../templates/next-app/scripts/lib/seo-contract.mjs")) as Record<string, any>;

const approvedConfig = {
  schemaVersion: 1,
  status: "approved",
  urlPolicy: { trailingSlash: true },
  archiveSitemap: { required: true },
  routeFamilies: [
    {
      id: "detail-en",
      pattern: "/posts/**",
      locale: "en",
      requiredFields: ["h1:count", "h1:text", "og:image", "twitter:image"],
      equalFields: [["og:image", "twitter:image"]],
      socialImage: {
        requiresProvenance: true,
        source: "declared project-specific source order",
        provenanceRef: "docs/seo-social-image.md#detail",
        contrastiveSamples: ["/posts/featured-differs-from-gallery/"],
      },
    },
  ],
  retiredRoutes: [
    {
      path: "/retired/**",
      type: "retire",
      reason: "approved content retirement",
      approvedBy: "owner",
      approvedAt: "2026-08-21",
      searchEvidence: "docs/search-impact.md",
    },
  ],
};

describe("seo contract helpers", () => {
  it("keeps lookup normalization separate from public trailing-slash exactness", () => {
    expect(normalizeLookupPath("/company/")).toBe("/company");
    expect(expectedPublicPathForLookup("/company", true)).toBe("/company/");
    expect(publicPath("https://example.test/company", "https://example.test")).toBe("/company");
    expect(
      exactTrailingSlashErrors({
        route: "/company",
        siteOrigin: "https://example.test",
        metadata: { values: { canonical: "https://example.test/company", "og:url": "https://example.test/company/" } },
      }),
    ).toEqual([
      expect.objectContaining({ item: "canonical.publicPath", expected: "/company/", actual: "/company" }),
    ]);
  });

  it("fails missing H1/social fields and a locale mismatch for the matched route family", () => {
    const metadata = { values: { "html:lang": "ja", "og:image": "https://example.test/og.jpg", "h1:count": "0" } };
    expect(
      collectRequiredFieldErrors({ path: "/posts/example", config: approvedConfig, metadata }).map(
        (error: { item: string }) => error.item,
      ),
    ).toEqual(["contract.required.h1:count", "contract.required.h1:text", "contract.required.twitter:image"]);
    expect(collectExpectedValueErrors({ path: "/posts/example", config: approvedConfig, metadata })).toEqual([
      expect.objectContaining({ item: "contract.expected.html:lang", expected: "en", actual: "ja" }),
    ]);
  });

  it("requires exactly one route-family rule for every output route", () => {
    expect(collectRouteFamilyCoverageErrors({ path: "/outside", config: approvedConfig })).toEqual([
      expect.objectContaining({ item: "contract.routeFamily.missing" }),
    ]);
    expect(
      collectRouteFamilyCoverageErrors({
        path: "/posts/example",
        config: { ...approvedConfig, routeFamilies: [...approvedConfig.routeFamilies, { id: "all", pattern: "/**", locale: "en" }] },
      }),
    ).toEqual([expect.objectContaining({ item: "contract.routeFamily.ambiguous" })]);
  });

  it("requires social-image provenance and contrastive evidence before approval", () => {
    expect(validateContractConfig(approvedConfig)).toEqual([]);
    expect(validateContractConfig({ ...approvedConfig, status: "draft" })).toContain(
      "seo-contract.config.json status must be approved before verify:seo can pass",
    );
    expect(
      collectSocialImageEvidenceErrors({
        ...approvedConfig,
        routeFamilies: [
          {
            id: "detail",
            pattern: "/posts/**",
            locale: "en",
            requiredFields: ["og:image"],
            socialImage: { requiresProvenance: true },
          },
        ],
      }).map((error: { item: string }) => error.item),
    ).toEqual([
      "contract.socialImage.source",
      "contract.socialImage.provenanceRef",
      "contract.socialImage.contrastiveSample",
    ]);
  });

  it("reports malformed config instead of crashing downstream checks", () => {
    const malformed = { schemaVersion: 1, status: "approved", urlPolicy: {}, routeFamilies: {}, retiredRoutes: {} };
    expect(validateContractConfig(malformed)).toEqual(
      expect.arrayContaining([
        "seo-contract.config.json urlPolicy.trailingSlash must be boolean",
        "seo-contract.config.json routeFamilies must contain at least one rule",
        "seo-contract.config.json retiredRoutes must be an array",
      ]),
    );
    expect(collectRouteFamilyCoverageErrors({ path: "/posts/example", config: malformed })).toEqual([
      expect.objectContaining({ item: "contract.routeFamily.missing" }),
    ]);
    expect(collectSocialImageEvidenceErrors(malformed)).toEqual([]);
  });

  it("fails closed when the archived sitemap is missing unless an approved waiver is declared", () => {
    expect(archiveSitemapMissingErrors(approvedConfig)).toEqual([
      expect.objectContaining({ item: "archiveSitemap.notFound" }),
    ]);
    const waived = {
      ...approvedConfig,
      archiveSitemap: {
        required: false,
        waiver: { reason: "the legacy site did not publish a sitemap", approvedBy: "owner", approvedAt: "2026-08-21" },
      },
    };
    expect(validateContractConfig(waived)).toEqual([]);
    expect(archiveSitemapMissingErrors(waived)).toEqual([]);
    expect(
      validateContractConfig({ ...approvedConfig, archiveSitemap: { required: false } }),
    ).toContain("seo-contract.config.json archiveSitemap.waiver is required when required is false");
  });

  it("validates social image URLs and dimensions without fetching remote assets", () => {
    expect(
      collectSocialMetadataFormatErrors({
        path: "/posts/example",
        metadata: {
          values: {
            "og:image": "/relative.jpg",
            "og:image:secure_url": "http://example.test/insecure.jpg",
            "og:image:width": "0",
            "og:image:height": "630",
          },
        },
      }).map((error: { item: string }) => error.item),
    ).toEqual(["og:image.absoluteUrl", "og:image:secure_url.https", "og:image:width.positiveInteger"]);
  });

  it("requires archive sitemap disappearances to resolve to output, a live alias target, or approved retire", () => {
    const errors = collectRetiredRouteErrors({
      archivePaths: new Set(["/kept", "/alias", "/retired/old", "/missing", "/broken-alias", "/output-only"]),
      outputPaths: new Set(["/kept", "/new-alias", "/output-only"]),
      sitemapPaths: new Set(["/kept", "/new-alias"]),
      aliases: { "/new-alias": "/alias", "/missing-target": "/broken-alias" },
      config: approvedConfig,
    });
    expect(errors).toEqual([
      expect.objectContaining({ path: "/missing", item: "archiveSitemap.unclassifiedRetire" }),
      expect.objectContaining({ path: "/broken-alias", item: "archiveSitemap.redirectTargetMissing" }),
      expect.objectContaining({ path: "/output-only", item: "archiveSitemap.preserveIncomplete" }),
    ]);
  });

  it("checks internal links to emitted routes without crawling external URLs", () => {
    const errors = collectInternalHrefErrors({
      sourcePath: "/posts/example",
      hrefs: ["/company", "/company/", "https://outside.test/company"],
      outputPaths: new Set(["/posts/example", "/company"]),
      siteOrigin: "https://example.test",
      trailingSlash: true,
    });
    expect(errors).toEqual([
      expect.objectContaining({ item: "internalHref.publicPath", expected: "/company/", actual: "/company" }),
    ]);
  });

  it("requires exact social-image intentional diffs and validates their registry", () => {
    const difference = { path: "/posts/example", item: "og:image" };
    expect(intentionalDiffMatches({ path: "/posts/**", item: "og:image", reason: "too broad" }, difference)).toBe(false);
    expect(intentionalDiffMatches({ path: "/posts/example/", item: "og:image", reason: "approved" }, difference)).toBe(true);
    expect(
      validateIntentionalDiffRegistry({
        schemaVersion: 1,
        entries: [{ path: "/posts/**", item: "og:image", reason: "too broad" }],
      }),
    ).toContain("entries[0]: social image differences require an exact route path");
  });
});
