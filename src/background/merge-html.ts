import * as cheerio from "cheerio";

export function mergeHtml(html1: string, html2: string) {
  const $1 = cheerio.load(html1);
  const $2 = cheerio.load(html2);
  const parentSelector = findParentSelector($1, $2);
  if (parentSelector) {
    const $container1 = $1(parentSelector);
    const $container2 = $2(parentSelector);
    const children1 = $container1.children();
    const children2 = $container2.children();
    const firstCild1 = children1.first().html() || "";
    const firstCild2 = children2.first().html() || "";

    if (compareHTMLBlocks(firstCild1, firstCild2)) {
      return $2.html();
    } else {
      const length2 = children2.length;
      for (let i = 0; i < length2; i++) {
        $container1.append(children2[i]);
      }
    }
  }

  return $1.html();
}

function compareHTMLBlocks(html1: string, html2: string) {
  const normalizedHtml1 = html1.replace(/\s/g, "").toLowerCase();
  const normalizedHtml2 = html2.replace(/\s/g, "").toLowerCase();

  return normalizedHtml1 === normalizedHtml2;
}

function findParentSelector($1: cheerio.CheerioAPI, $2: cheerio.CheerioAPI) {
  let parentSelector: string | null = null;

  $1("body *").each((_, element) => {
    try {
      const element1 = $1(element);
      const selector = getSelector(element1);
      const element2 = $2(selector);

      if (element2.length === 0) {
        const parent = element2.parent();
        if (parent.length > 0) {
          parentSelector = getSelector(parent);
        }
      }
    } catch (error) {
      //
    }
  });

  return parentSelector;
}

function getSelector(element: cheerio.Cheerio<cheerio.Element>): string {
  const selectors = getSelectors(element);
  return selectors.join(" > ");
}

function getSelectors(element: cheerio.Cheerio<cheerio.Element>): string[] {
  const selectors = [];

  if (element.length > 0) {
    const parent = element.parent();
    let nth = "";

    if (parent.length > 0) {
      selectors.push(...getSelectors(parent));
      const index = parent.children().index(element[0]);
      nth = `:nth-child(${index + 1})`;
    }

    const name = element[0].name;
    const sel = !!nth.length ? `${name ? name : "*"}${nth}` : name;
    selectors.push(sel);
  }

  return selectors;
}
