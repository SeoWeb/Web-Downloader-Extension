import * as cheerio from "cheerio";

export function getResources(html: string): {
  css: string[];
  js: string[];
  documents: string[];
  images: string[];
  links: string[];
  text: string;
} {
  const $ = cheerio.load(html);

  const css = $("link[rel=stylesheet]")
    ?.filter((_i, el) => el && !$(el).attr("href")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => ($(el).attr("href") || "").split("?")[0])
    ?.filter((el) => !!el?.length);

  const js = $("script")
    ?.filter((_i, el) => el && !$(el).attr("src")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => ($(el).attr("src") || "").split("?")[0])
    ?.filter((el) => !!el?.length);

  const images = $("img")
    ?.filter((_i, el) => el && !$(el).attr("src")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => ($(el).attr("src") || "").split("?")[0])
    ?.filter((el) => !!el?.length);

  const links = $("a")
    ?.filter((_i, el) => el && !$(el).attr("href")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => ($(el).attr("href") || "").split("?")[0])
    ?.filter((el) => !!el?.length);

  const documents = $(
    "a[href$='.pdf'], a[href$='.doc'], a[href$='.docx'], a[href$='.xls'], a[href$='.xlsx'], a[href$='.ppt'], a[href$='.pptx']",
  )
    ?.toArray()
    ?.map((el) => $(el).attr("href") || "")
    ?.filter((el) => !!el?.length);

  const text = $("body").text();

  return {
    css: [...new Set(css)],
    js: [...new Set(js)],
    images: [...new Set(images)],
    links: [...new Set(links)],
    documents: [...new Set(documents)],
    text,
  };
}
