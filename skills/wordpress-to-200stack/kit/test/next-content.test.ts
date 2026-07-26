import { describe, expect, it } from "vitest";

import {
  documentFromMicroCms,
  documentsFromMicroCms,
  normalizeMediaValue,
} from "../templates/next-app/src/lib/content/microcms-document.js";
import {
  normalizeRoutePath,
  withTrailingSlash,
} from "../templates/next-app/src/lib/content/types.js";
import { findRouteByPath } from "../templates/next-app/src/lib/repository.js";

describe("next-app microCMS content normalization", () => {
  it("keeps image values as URL strings and records dimensions beside them", () => {
    const document = documentFromMicroCms("articles", {
      id: "article-1",
      title: "Article",
      featuredImage: { url: "https://images.example/featured.jpg", width: 1200, height: 630 },
      cardImage: { url: "https://images.example/card.jpg", width: 640, height: 360 },
      gallery: [{
        fieldId: "gallery",
        image: { url: "https://images.example/gallery.jpg", width: 800, height: 600 },
      }],
    });

    expect(document.featuredImage).toBe("https://images.example/featured.jpg");
    expect(document.featuredImageDimensions).toEqual({ width: 1200, height: 630 });
    expect(document.fields).toMatchObject({
      cardImage: "https://images.example/card.jpg",
      cardImageDimensions: { width: 640, height: 360 },
    });
    expect(document.repeaters.gallery).toEqual([{
      fieldId: "gallery",
      image: "https://images.example/gallery.jpg",
      imageDimensions: { width: 800, height: 600 },
    }]);
    expect(normalizeMediaValue({ nested: { url: "/image.jpg", width: 1, height: 2 } }))
      .toEqual({ nested: "/image.jpg", nestedDimensions: { width: 1, height: 2 } });
  });

  it("rejects content IDs duplicated across APIs", () => {
    expect(() => documentsFromMicroCms({
      articles: [{ id: "same" }],
      news: [{ id: "same" }],
    }, ["articles", "news"])).toThrow(/contentId.*重複/);
  });

  it("normalizes custom-field groups, group relations, array select kind, and trailing slashes", () => {
    const related = { id: "person-1", title: "Person" };
    const document = documentFromMicroCms("articles", {
      id: "article-1",
      kind: ["feature"],
      profile: {
        fieldId: "profile",
        label: "Profile",
        image: { url: "/profile.jpg", width: 300, height: 200 },
        author: related,
      },
    }, {
      articles: [{ id: "article-1" }],
      people: [related],
    });
    expect(document.kind).toBe("feature");
    expect(document.route.path).toBe("/articles/article-1/");
    expect(document.fields).toMatchObject({
      label: "Profile",
      image: "/profile.jpg",
      imageDimensions: { width: 300, height: 200 },
      kind: "feature",
    });
    expect(document.relations).toEqual([
      { fieldId: "author", toApi: "people", targetContentId: "person-1" },
    ]);
    expect(normalizeRoutePath("/articles/article-1")).toBe("/articles/article-1/");
    expect(withTrailingSlash("/articles/article-1?draft=1#top"))
      .toBe("/articles/article-1/?draft=1#top");
    expect(findRouteByPath([{
      api: "articles",
      contentId: "article-1",
      legacyUrl: "/articles/article-1/",
      path: "/articles/article-1",
      segments: ["articles", "article-1"],
      trailingSlash: true,
    }], ["articles", "article-1"])?.contentId).toBe("article-1");
  });
});
