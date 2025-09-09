import * as cheerio from "cheerio";

// Helper function to extract background images from CSS content
function extractBackgroundImagesFromCSS(cssContent: string): string[] {
  const imageUrls: string[] = [];
  
  // Regular expression to match url() patterns in CSS
  const urlPattern = /url\(['"]?(.*?)['"]?\)/g;
  let match;
  
  while ((match = urlPattern.exec(cssContent)) !== null) {
    const imageUrl = match[1].trim();
    if (imageUrl && !imageUrl.startsWith('data:')) {
      imageUrls.push(imageUrl);
    }
  }
  
  return imageUrls;
}

// Helper function to extract background images from inline styles
function extractBackgroundImagesFromInlineStyle(styleAttr: string | undefined): string[] {
  if (!styleAttr) return [];
  
  const imageUrls: string[] = [];
  
  // Regular expression to match background-image: url(...) patterns
  const bgImagePattern = /background-image\s*:\s*url\(['"]?(.*?)['"]?\)/gi;
  let match;
  
  while ((match = bgImagePattern.exec(styleAttr)) !== null) {
    const imageUrl = match[1].trim();
    if (imageUrl && !imageUrl.startsWith('data:')) {
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
  const $ = cheerio.load(html);

  // Extract CSS files
  const css = $("link[rel=stylesheet]")
    ?.filter((_i, el) => el && !$(el).attr("href")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => ($(el).attr("href") || ""))
    ?.filter((el) => !!el?.length);

  // Extract JavaScript files
  const js = $("script")
    ?.filter((_i, el) => el && !$(el).attr("src")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => ($(el).attr("src") || ""))
    ?.filter((el) => !!el?.length);

  // Extract regular images from img tags
  const images = $("img")
    ?.filter((_i, el) => el && !$(el).attr("src")?.startsWith("#"))
    ?.toArray()
    ?.map((el) => ($(el).attr("src") || ""))
    ?.filter((el) => !!el?.length);

  // Extract images from inline styles
  const inlineStyleImages = $("img, div, span, section, article, header, footer, nav, main, aside")
    ?.filter((_i, el) => {
      const style = $(el).attr('style');
      return !!(style && style.includes('background-image'));
    })
    ?.toArray()
    ?.flatMap((el) => extractBackgroundImagesFromInlineStyle($(el).attr('style')))
    ?.filter((el) => !!el?.length);

  // Extract images from style tags
  const styleTagImages = $("style")
    ?.toArray()
    ?.flatMap((el) => extractBackgroundImagesFromCSS($(el).text()))
    ?.filter((el) => !!el?.length);

  // Extract images from external CSS files (we'll need to fetch these later)
  const cssFileImages: string[] = [];
  
  // Combine all images
  const allImages = [...images, ...inlineStyleImages, ...styleTagImages, ...cssFileImages];

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
    images: [...new Set(allImages)],
    links: [...new Set(links)],
    documents: [...new Set(documents)],
    text,
  };
}
