import { defineMigration } from "../../src/config.js";

export default defineMigration({
  wxr: "./mini-wxr.xml",
  site: { origin: "https://example.test", mediaHost: "https://media.example.test" },
  apis: {
    cars: {
      from: "car",
      fields: [
        { metaKey: "price", fieldId: "price", type: "number" },
        { metaKey: "tag", fieldId: "tags", type: "stringArray" },
      ],
      repeaters: [{ fieldId: "gallery", columns: [
        { metaKey: "image", fieldId: "image", type: "string" },
        { metaKey: "caption", fieldId: "caption", type: "text" },
      ] }],
      relations: [{ metaKey: "related", fieldId: "related", toApi: "pages" }],
      featuredImage: true,
      taxonomies: ["brand"],
    },
    pages: { from: "page", fields: [] },
  },
  seo: { yoast: true },
});
