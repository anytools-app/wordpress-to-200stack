const ALL_BLOCKS = "(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary)";
const WP_WHITESPACE = "[\\x09-\\x0D ]";

function phpTrim(value: string): string {
  return value.replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, "");
}

/**
 * Split text and HTML elements into alternating entries, matching WordPress'
 * wp_html_split() treatment of comments, CDATA, and incomplete elements.
 */
function wpHtmlSplit(input: string): string[] {
  const parts: string[] = [];
  let offset = 0;

  while (offset < input.length) {
    const start = input.indexOf("<", offset);
    if (start === -1) {
      parts.push(input.slice(offset));
      return parts;
    }

    parts.push(input.slice(offset, start));

    let end: number;
    if (input.startsWith("<!--", start)) {
      // WordPress' comment regex allows the opening dashes to also form the
      // closing sequence in malformed-but-matched input such as "<!-->".
      const close = input.indexOf("-->", start + 2);
      end = close === -1 ? input.length : close + 3;
    } else if (input.startsWith("<![CDATA[", start)) {
      const close = input.indexOf("]]>", start + 9);
      end = close === -1 ? input.length : close + 3;
    } else {
      const close = input.indexOf(">", start + 1);
      end = close === -1 ? input.length : close + 1;
    }

    parts.push(input.slice(start, end));
    offset = end;
  }

  parts.push("");
  return parts;
}

/** Equivalent to wp_replace_in_html_tags() for wpautop's single newline pair. */
function preserveNewlinesInHtmlTags(haystack: string): string {
  const parts = wpHtmlSplit(haystack);
  let changed = false;

  for (let index = 1; index < parts.length; index += 2) {
    const element = parts[index];
    if (element?.includes("\n")) {
      parts[index] = element.replaceAll("\n", " <!-- wpnl --> ");
      changed = true;
    }
  }

  return changed ? parts.join("") : haystack;
}

function preserveElementNewlines(element: string): string {
  return element.replaceAll("\n", "<WPPreserveNewline />");
}

/**
 * Port of WordPress wp-includes/formatting.php wpautop().
 *
 * The operation order intentionally follows WordPress core.
 */
export function wpautop(input: string, br = true): string {
  const preTags = new Map<string, string>();

  if (phpTrim(input) === "") return "";

  // Just to make things a little easier, pad the end.
  let text = `${input}\n`;

  /*
   * Pre tags shouldn't be touched by autop.
   * Replace pre tags with placeholders and bring them back after autop.
   */
  if (text.includes("<pre")) {
    const textParts = text.split("</pre>");
    const lastPart = textParts.pop() ?? "";
    let rebuilt = "";
    let index = 0;

    for (const textPart of textParts) {
      const start = textPart.indexOf("<pre");
      if (start === -1) {
        rebuilt += textPart;
        continue;
      }

      const name = `<pre wp-pre-tag-${index}></pre>`;
      preTags.set(name, `${textPart.slice(start)}</pre>`);
      rebuilt += `${textPart.slice(0, start)}${name}`;
      index += 1;
    }

    text = `${rebuilt}${lastPart}`;
  }

  // Change multiple <br>'s into two line breaks, which will turn into paragraphs.
  text = text.replace(/<br[\x09-\x0D ]*\/?>[\x09-\x0D ]*<br[\x09-\x0D ]*\/?>/g, "\n\n");

  // Add double line breaks around block-level tags.
  text = text.replace(new RegExp(`(<${ALL_BLOCKS}[\\x09-\\x0D />])`, "g"), "\n\n$1");
  text = text.replace(new RegExp(`(</${ALL_BLOCKS}>)`, "g"), "$1\n\n");

  // Add a double line break after hr tags, which are self closing.
  text = text.replace(/(<hr[\x09-\x0D ]*?\/?>)/g, "$1\n\n");

  // Standardize newline characters to "\n".
  text = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

  // Find newlines in all elements and add placeholders.
  text = preserveNewlinesInHtmlTags(text);

  // Collapse line breaks before and after <option> elements so they don't get autop'd.
  if (text.includes("<option")) {
    text = text.replace(/[\x09-\x0D ]*<option/g, "<option");
    text = text.replace(/<\/option>[\x09-\x0D ]*/g, "</option>");
  }

  /*
   * Collapse line breaks inside <object> elements, before <param> and <embed>
   * elements so they don't get autop'd.
   */
  if (text.includes("</object>")) {
    text = text.replace(/(<object[^>]*>)[\x09-\x0D ]*/g, "$1");
    text = text.replace(/[\x09-\x0D ]*<\/object>/g, "</object>");
    text = text.replace(/[\x09-\x0D ]*(<\/?(?:param|embed)[^>]*>)[\x09-\x0D ]*/g, "$1");
  }

  /*
   * Collapse line breaks inside <audio> and <video> elements, before and after
   * <source> and <track> elements.
   */
  if (text.includes("<source") || text.includes("<track")) {
    text = text.replace(/([<[](?:audio|video)[^>\]]*[>\]])[\x09-\x0D ]*/g, "$1");
    text = text.replace(/[\x09-\x0D ]*([<[]\/(?:audio|video)[>\]])/g, "$1");
    text = text.replace(/[\x09-\x0D ]*(<(?:source|track)[^>]*>)[\x09-\x0D ]*/g, "$1");
  }

  // Collapse line breaks before and after <figcaption> elements.
  if (text.includes("<figcaption")) {
    text = text.replace(/[\x09-\x0D ]*(<figcaption[^>]*>)/g, "$1");
    text = text.replace(/<\/figcaption>[\x09-\x0D ]*/g, "</figcaption>");
  }

  // Remove more than two contiguous line breaks.
  text = text.replace(/\n\n+/g, "\n\n");

  // Split on double line breaks and wrap every non-empty part with a paragraph.
  const paragraphs = text.split(/\n[\x09-\x0D ]*\n/).filter((paragraph) => paragraph !== "");
  text = "";
  for (const paragraph of paragraphs) {
    text += `<p>${paragraph.replace(/^\n+|\n+$/g, "")}</p>\n`;
  }

  // Under certain strange conditions it could create a P of entirely whitespace.
  text = text.replace(/<p>[\x09-\x0D ]*<\/p>/g, "");

  // Add a closing <p> inside <div>, <address>, or <form> tag if missing.
  text = text.replace(/<p>([^<]+)<\/(div|address|form)>/g, "<p>$1</p></$2>");

  // If an opening or closing block element tag is wrapped in a <p>, unwrap it.
  text = text.replace(new RegExp(`<p>${WP_WHITESPACE}*(</?${ALL_BLOCKS}[^>]*>)${WP_WHITESPACE}*</p>`, "g"), "$1");

  // In some cases <li> may get wrapped in <p>, fix them.
  text = text.replace(/<p>(<li.+?)<\/p>/g, "$1");

  // If a <blockquote> is wrapped with a <p>, move it inside the <blockquote>.
  text = text.replace(/<p><blockquote([^>]*)>/gi, "<blockquote$1><p>");
  text = text.replaceAll("</blockquote></p>", "</p></blockquote>");

  // Remove paragraph tags immediately inside or outside block element tags.
  text = text.replace(new RegExp(`<p>${WP_WHITESPACE}*(</?${ALL_BLOCKS}[^>]*>)`, "g"), "$1");
  text = text.replace(new RegExp(`(</?${ALL_BLOCKS}[^>]*>)${WP_WHITESPACE}*</p>`, "g"), "$1");

  // Optionally insert line breaks.
  if (br) {
    // Replace newlines that shouldn't be touched with a placeholder.
    text = text.replace(/<(script|style|svg|math).*?<\/\1>/gs, preserveElementNewlines);

    // Normalize <br>.
    text = text.replaceAll("<br>", "<br />").replaceAll("<br/>", "<br />");

    // Replace newlines that aren't preceded by a <br /> with a <br />.
    text = text.replace(/(?<!<br \/>)[\x09-\x0D ]*\n/g, "<br />\n");

    // Replace newline placeholders with newlines.
    text = text.replaceAll("<WPPreserveNewline />", "\n");
  }

  // Remove <br /> tags adjacent to block elements.
  text = text.replace(new RegExp(`(</?${ALL_BLOCKS}[^>]*>)${WP_WHITESPACE}*<br />`, "g"), "$1");
  text = text.replace(/<br \/>([\x09-\x0D ]*<\/?(?:p|li|div|dl|dd|dt|th|pre|td|ul|ol)[^>]*>)/g, "$1");
  // PHP PCRE's $ without /D also matches immediately before a single trailing LF.
  text = text.replace(/\n<\/p>(?=\n?$)/, "</p>");

  // Replace placeholder <pre> tags with their original content.
  for (const [placeholder, pre] of preTags) {
    text = text.replaceAll(placeholder, () => pre);
  }

  // Restore newlines in all elements.
  if (text.includes("<!-- wpnl -->")) {
    text = text.replaceAll(" <!-- wpnl --> ", "\n").replaceAll("<!-- wpnl -->", "\n");
  }

  return text;
}

/** Return true when applying wpautop would double-format known block markup. */
export function hasBlockMarkup(html: string): boolean {
  return /<p[\s/>]/i.test(html) || html.includes("<!-- wp:");
}
