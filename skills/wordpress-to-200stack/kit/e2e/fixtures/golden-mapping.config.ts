import { defineMigration } from "../../src/config.js";

export default defineMigration({
  wxr: "./golden-wxr.xml",
  site: { origin: "https://example.test", mediaHost: "https://media.example.test" },
  contentIdStrategy: "legacySlug",
  apis: {
    cars: {
      from: "car", featuredImage: true, taxonomies: ["brand"],
      fields: [{ metaKey: "price", fieldId: "price", type: "number" }, { metaKey: "tag", fieldId: "tags", type: "stringArray" }],
      repeaters: [
        { fieldId: "gallery", columns: [{ metaKey: "image", fieldId: "image", type: "image" }, { metaKey: "caption", fieldId: "caption", type: "text" }] },
        { fieldId: "details", columns: [{ metaKey: "price", fieldId: "price", type: "number" }] },
      ],
      relations: [{ metaKey: "related", fieldId: "related", toApi: "pages" }],
    },
    pages: { from: "page", fields: [] },
  },
  seo: { yoast: true },
});
