import * as cheerio from "cheerio";

// Common lazy-load image attribute names used by various libraries
// (LazyLoad, Lozad, lazysizes, WordPress, Shopify, etc.)
const LAZY_IMAGE_ATTRIBUTES = [
  "data-src",
  "data-lazy-src",
  "data-original",
  "data-lazy",
  "data-bg",
  "data-bg-url",
  "data-srcset",
  "data-lazy-url",
  "data-image",
  "data-lazy-srcset",
  "data-original-src",
  "data-ll-status",
  "data-source",
  "data-src-small",
  "data-src-medium",
  "data-src-large",
  "loading-src",
];

// Helper function to parse srcset attribute and extract URLs
// srcset format: "url descriptor, url descriptor, ..."
// Example: "img-320w.jpg 320w, img-640w.jpg 640w, img-2x.jpg 2x"
function parseSrcset(srcset: string | undefined): string[] {
  if (!srcset) return [];

  const urls: string[] = [];
  // Split by comma, then each entry is: URL [descriptor]
  const entries = srcset.split(",");

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // The URL is the first token; descriptors follow (width like "320w" or pixel density like "2x")
    const url = trimmed.split(/\s+/)[0];
    if (url && !url.startsWith("data:") && url.length > 0) {
      urls.push(url);
    }
  }

  return urls;
}

// Helper function to extract background images from CSS content
function extractBackgroundImagesFromCSS(cssContent: string): string[] {
  const imageUrls: string[] = [];

  // Regular expression to match url() patterns in CSS
  const urlPattern = /url\(['"]?(.*?)['"]?\)/g;
  let match;

  while ((match = urlPattern.exec(cssContent)) !== null) {
    const imageUrl = match[1].trim();
    if (imageUrl && !imageUrl.startsWith("data:")) {
      imageUrls.push(imageUrl);
    }
  }

  return imageUrls;
}

// Helper function to extract background images from inline styles
function extractBackgroundImagesFromInlineStyle(
  styleAttr: string | undefined,
): string[] {
  if (!styleAttr) return [];

  const imageUrls: string[] = [];

  // Regular expression to match background-image: url(...) patterns
  const bgImagePattern = /background-image\s*:\s*url\(['"]?(.*?)['"]?\)/gi;
  let match;

  while ((match = bgImagePattern.exec(styleAttr)) !== null) {
    const imageUrl = match[1].trim();
    if (imageUrl && !imageUrl.startsWith("data:")) {
      imageUrls.push(imageUrl);
    }
  }

  return imageUrls;
}

export function getResources(html: string): {
  css: string[];
  js: string[];
  documents: string[];
  images: string[];
  links: string[];
  text: string;
} {
  if (!html || typeof html !== 'string') {
    return { css: [], js: [], documents: [], images: [], links: [], text: '' };
  }

  const $ = cheerio.load(html);

  // Extract CSS files
  const css = $("link[rel=stylesheet]")
    ?.filter((_i, el) => el && !$(el).attr("href")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => $(el).attr("href") || "")
    ?.filter((el) => !!el?.length);

  // Extract JavaScript files
  const js = $("script")
    ?.filter((_i, el) => el && !$(el).attr("src")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => $(el).attr("src") || "")
    ?.filter((el) => !!el?.length);

  // Extract regular images from img tags (src attribute)
  const images = $("img")
    ?.filter((_i, el) => el && !$(el).attr("src")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => $(el).attr("src") || "")
    ?.filter((el) => !!el?.length);

  // Extract images from lazy-load attributes on img tags (data-src, data-lazy-src, etc.)
  const lazyImages = $("img")
    ?.toArray()
    ?.flatMap((el) => {
      const lazyUrls: string[] = [];
      for (const attr of LAZY_IMAGE_ATTRIBUTES) {
        const value = $(el).attr(attr);
        if (value && !value.startsWith("data:") && !value.startsWith("#")) {
          if (attr === "data-srcset" || attr === "data-lazy-srcset") {
            // Parse srcset format for these attributes
            lazyUrls.push(...parseSrcset(value));
          } else {
            lazyUrls.push(value);
          }
        }
      }
      return lazyUrls;
    })
    ?.filter((el) => !!el?.length);

  // Extract images from srcset attributes on img tags
  const srcsetImages = $("img[srcset]")
    ?.toArray()
    ?.flatMap((el) => parseSrcset($(el).attr("srcset")))
    ?.filter((el) => !!el?.length);

  // Extract images from <picture> <source> elements
  const pictureImages = $("picture source")
    ?.toArray()
    ?.flatMap((el) => {
      const urls: string[] = [];
      // Extract from srcset attribute
      const srcset = $(el).attr("srcset");
      if (srcset) {
        urls.push(...parseSrcset(srcset));
      }
      // Extract from data-srcset attribute (lazy-loaded picture sources)
      const dataSrcset = $(el).attr("data-srcset");
      if (dataSrcset) {
        urls.push(...parseSrcset(dataSrcset));
      }
      // Extract from src attribute (some picture sources use src)
      const src = $(el).attr("src");
      if (src && !src.startsWith("data:") && !src.startsWith("#")) {
        urls.push(src);
      }
      return urls;
    })
    ?.filter((el) => !!el?.length);

  // Extract images from elements with data-bg or data-bg-url attributes
  // (common in WordPress themes, parallax sections, and background image plugins)
  const dataBgImages = $("[data-bg], [data-bg-url]")
    ?.toArray()
    ?.flatMap((el) => {
      const urls: string[] = [];
      const bg = $(el).attr("data-bg");
      if (bg && !bg.startsWith("data:") && !bg.startsWith("#")) {
        urls.push(bg);
      }
      const bgUrl = $(el).attr("data-bg-url");
      if (bgUrl && !bgUrl.startsWith("data:") && !bgUrl.startsWith("#")) {
        urls.push(bgUrl);
      }
      return urls;
    })
    ?.filter((el) => !!el?.length);

  // Extract images from object elements with type="image/..." and data attribute
  const objectImages = $("object[type^='image/']")
    ?.filter((_i, el) => el && !$(el).attr("data")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => $(el).attr("data") || "")
    ?.filter((el) => !!el?.length);

  // Extract images from inline styles
  const inlineStyleImages = $(
    "img, div, span, section, article, header, footer, nav, main, aside",
  )
    ?.filter((_i, el) => {
      const style = $(el).attr("style");
      return !!(style && style.includes("background-image"));
    })
    ?.toArray()
    ?.flatMap((el) =>
      extractBackgroundImagesFromInlineStyle($(el).attr("style")),
    )
    ?.filter((el) => !!el?.length);

  // Extract images from style tags
  const styleTagImages = $("style")
    ?.toArray()
    ?.flatMap((el) => extractBackgroundImagesFromCSS($(el).text()))
    ?.filter((el) => !!el?.length);

  // CSS background images in external stylesheets are handled at download time
  // by the CSS file handler (see css.ts -> downloadBackgroundImages)
  const cssFileImages: string[] = [];

  // Combine all images
  const allImages = [
    ...images,
    ...lazyImages,
    ...srcsetImages,
    ...pictureImages,
    ...dataBgImages,
    ...objectImages,
    ...inlineStyleImages,
    ...styleTagImages,
    ...cssFileImages,
  ];

  const links = $("a")
    ?.filter((_i, el) => el && !$(el).attr("href")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => $(el).attr("href") || "")
    ?.filter((el) => !!el?.length);

  // .pdf, .doc, .docx, .xls, .xlsx, .ppt, .pptx, .txt, .rtf, .odt, .ods, .odp, .csv, .zip, .gz, .bz2, .xz, .avi, .mkv, .mp3, .ogg, .wav, .mp4, .webm, .ogg, .ogv, .oga, .gif, .png, .jpg, .jpeg, .bmp, .svg, .ico, .heic, .avif, .stl, .obj, .3mf, .fbx, .dae, .step, .stp, .iges, .igs, .dxf, .dwg, .gcode
  const documents = $(
    "a[href*='.pdf'], a[href*='.doc'], a[href*='.docx'], a[href*='.xls'], a[href*='.xlsx'], a[href*='.ppt'], a[href*='.pptx'], a[href*='.txt'], a[href*='.rtf'], a[href*='.odt'], a[href*='.ods'], a[href*='.odp'], a[href*='.csv'], a[href*='.zip'], a[href*='.gz'], a[href*='.bz2'], a[href*='.xz'], a[href*='.avi'], a[href*='.mkv'], a[href*='.mp3'], a[href*='.ogg'], a[href*='.wav'], a[href*='.mp4'], a[href*='.webm'], a[href*='.ogg'], a[href*='.ogv'], a[href*='.oga'], a[href*='.gif'], a[href*='.png'], a[href*='.jpg'], a[href*='.jpeg'], a[href*='.bmp'], a[href*='.svg'], a[href*='.ico'], a[href*='.heic'], a[href*='.avif'], a[href*='.stl'], a[href*='.obj'], a[href*='.3mf'], a[href*='.fbx'], a[href*='.dae'], a[href*='.step'], a[href*='.stp'], a[href*='.iges'], a[href*='.igs'], a[href*='.dxf'], a[href*='.dwg'], a[href*='.gcode']",
  )
    ?.toArray()
    ?.map((el) => $(el).attr("href") || "")
    ?.filter((el) => !!el?.length);

  const text = $("body").text();

  return {
    css: [...new Set(css)],
    js: [...new Set(js)],
    images: [...new Set(allImages)],
    links: [...new Set(links)],
    documents: [...new Set(documents)],
    text,
  };
}
