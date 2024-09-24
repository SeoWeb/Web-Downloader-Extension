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
    ?.map((el) => ($(el).attr("href") || ""))
    ?.filter((el) => !!el?.length);

  const js = $("script")
    ?.filter((_i, el) => el && !$(el).attr("src")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => ($(el).attr("src") || ""))
    ?.filter((el) => !!el?.length);

  const images = $("img")
    ?.filter((_i, el) => el && !$(el).attr("src")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => ($(el).attr("src") || ""))
    ?.filter((el) => !!el?.length);

  const links = $("a")
    ?.filter((_i, el) => el && !$(el).attr("href")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => ($(el).attr("href") || ""))
    ?.filter((el) => !!el?.length);

    // .pdf, .doc, .docx, .xls, .xlsx, .ppt, .pptx, .txt, .rtf, .odt, .ods, .odp, .csv, .zip, .gz, .bz2, .xz, .avi, .mkv, .mp3, .ogg, .wav, .mp4, .webm, .ogg, .ogv, .oga, .gif, .png, .jpg, .jpeg, .bmp, .svg, .ico, .heic, .avif
  const documents = $(
    "a[href*='.pdf'], a[href*='.doc'], a[href*='.docx'], a[href*='.xls'], a[href*='.xlsx'], a[href*='.ppt'], a[href*='.pptx'], a[href*='.txt'], a[href*='.rtf'], a[href*='.odt'], a[href*='.ods'], a[href*='.odp'], a[href*='.csv'], a[href*='.zip'], a[href*='.gz'], a[href*='.bz2'], a[href*='.xz'], a[href*='.avi'], a[href*='.mkv'], a[href*='.mp3'], a[href*='.ogg'], a[href*='.wav'], a[href*='.mp4'], a[href*='.webm'], a[href*='.ogg'], a[href*='.ogv'], a[href*='.oga'], a[href*='.gif'], a[href*='.png'], a[href*='.jpg'], a[href*='.jpeg'], a[href*='.bmp'], a[href*='.svg'], a[href*='.ico'], a[href*='.heic'], a[href*='.avif']",
  )
    ?.toArray()
    ?.map((el) => ($(el).attr("href") || ""))
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
