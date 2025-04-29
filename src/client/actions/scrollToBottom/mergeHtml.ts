import * as cheerio from "cheerio";
import { CheerioAPI, Cheerio } from "cheerio";
import { Element } from 'domhandler';

// --- Types ---

interface ElementInfo {
  element: Element;
  signature: ElementSignature;
  index: number; // Original index in its parent
  cheerioElement: Cheerio<Element>; // Store the Cheerio object
}

interface ElementSignature {
  tagName: string;
  id: string | undefined; // Use undefined instead of null for consistency
  classes: string[];
  key: string; // The unique key for matching
}

// Map from signature key to ElementInfo in the current document
type ElementMap = Map<string, ElementInfo>;

// --- Helper Functions ---

/**
 * Creates a unique signature key for an element.
 */
function createElementSignatureKey(element: Element, $: CheerioAPI): string {
  const $el = $(element);
  const tagName = element.tagName?.toLowerCase() || 'unknown';
  const id = $el.attr('id');
  const classAttr = $el.attr('class') || '';
  // Normalize classes: split, filter empty, sort
  const classes = classAttr.split(/\s+/).filter(Boolean).sort();

  // Key includes tag, id (if present), and sorted classes
  return `${tagName}${id ? `#${id}` : ''}${classes.length ? `.${classes.join('.')}` : ''}`;
}

/**
 * Creates full ElementSignature.
 */
function getElementSignature(element: Element, $: CheerioAPI): ElementSignature {
    const $el = $(element);
    const tagName = element.tagName?.toLowerCase() || 'unknown';
    const id = $el.attr('id');
    const classAttr = $el.attr('class') || '';
    const classes = classAttr.split(/\s+/).filter(Boolean).sort();
    const key = createElementSignatureKey(element, $);
    return { tagName, id, classes, key };
}


/**
 * Builds a map from signature key to ElementInfo for efficient lookup.
 * Only maps elements with potentially unique keys (avoids mapping plain text nodes etc.)
 */
function buildElementMap($: CheerioAPI, parent: Cheerio<Element>): Map<string, ElementInfo> {
  const map: ElementMap = new Map();
  parent.children().each((index, element) => {
    // Only map element nodes (type 'tag')
    if (element.type === 'tag') {
       const signature = getElementSignature(element, $);
       const info: ElementInfo = {
           element: element,
           signature: signature,
           index: index,
           cheerioElement: $(element) // Store Cheerio object
       };
       // If the key is already present, it indicates non-unique elements
       // based on this signature (e.g., multiple divs with the same class).
       // For simplicity here, we overwrite, favoring the last one.
       // A more complex strategy could handle lists of elements per key.
       map.set(signature.key, info);
    }
  });
  return map;
}

/**
 * Recursively merges nodes from 'newElement' into 'currentElement'.
 * Modifies 'currentElement' in place.
 */
function recursiveMergeNodes(
    currentElement: Cheerio<Element>,
    newElement: Cheerio<Element>,
    $: CheerioAPI, // The Cheerio instance for the *current* document
    $new: CheerioAPI // The Cheerio instance for the *new* document
): void {
    // 1. Update Attributes on currentElement from newElement
    const newAttrs = newElement.attr();
    if (newAttrs) {
        // Special handling for 'class' to merge rather than replace
        const currentClasses = (currentElement.attr('class') || '').split(/\s+/).filter(Boolean);
        const newClasses = (newAttrs.class || '').split(/\s+/).filter(Boolean);
        const mergedClasses = new Set([...currentClasses, ...newClasses]); // Use Set for uniqueness
        
        // Set all attributes from new, then overwrite class with merged
        currentElement.attr(newAttrs);
        if (mergedClasses.size > 0) {
             currentElement.attr('class', Array.from(mergedClasses).join(' '));
        } else {
            currentElement.removeAttr('class'); // Remove class attr if empty
        }
    }

    // 2. Merge Children
    const currentChildrenMap = buildElementMap($, currentElement);
    const newChildrenInfo: ElementInfo[] = [];
     $new(newElement).children().each((index, child) => {
        if(child.type === 'tag'){
            newChildrenInfo.push({
                element: child,
                signature: getElementSignature(child, $new),
                index: index,
                cheerioElement: $new(child)
            });
        }
         // Rudimentary handling for non-tag content (like text) - replace if changed?
         // This part needs careful consideration based on desired behavior for text nodes.
         // For now, we focus on element merging. Consider replacing text if it's the only child?
     });


    const matchedCurrentKeys = new Set<string>();
    let lastMatchedCurrentElement: Cheerio<Element> | null = null;

    newChildrenInfo.forEach((newInfo) => {
        const currentMatchInfo = currentChildrenMap.get(newInfo.signature.key);

        if (currentMatchInfo && !matchedCurrentKeys.has(newInfo.signature.key)) {
            // --- Match found ---
            matchedCurrentKeys.add(newInfo.signature.key);
            const currentMatchedElement = currentMatchInfo.cheerioElement;

            // Recursively merge the matched children
            recursiveMergeNodes(currentMatchedElement, newInfo.cheerioElement, $, $new);

            lastMatchedCurrentElement = currentMatchedElement; // Track the last match

            // Remove from map to handle potential duplicate keys correctly if needed later
            currentChildrenMap.delete(newInfo.signature.key);

        } else {
            // --- No Match found (New element or already matched key) ---
            // Clone the new element into the '$' context to add it
            const clonedElement = $<Element, string>(newInfo.cheerioElement.toString()); // Clone using HTML string representation

            if (lastMatchedCurrentElement) {
                // Insert after the last matched element in the current DOM
                lastMatchedCurrentElement.after(clonedElement);
            } else {
                // Insert at the beginning if this is the first new element
                currentElement.prepend(clonedElement);
            }
            // Update lastMatchedCurrentElement to the newly inserted one
            // so subsequent new elements are inserted relative to this one
            lastMatchedCurrentElement = clonedElement;
        }
    });

    // 3. Remove current elements that were not matched (optional, depends on goal)
    // The original goal was to *keep* elements from currentHtml, so we *don't* remove unmatched elements.
    // If removal was desired:
    // currentChildrenMap.forEach((info) => {
    //     info.cheerioElement.remove();
    // });
}


// --- Main Merge Function ---

export async function mergeHtml(currentHtml: string, newHtml: string): Promise<string> {
  if (!currentHtml) return newHtml || '';
  if (!newHtml) return currentHtml || '';

  const $ = cheerio.load(currentHtml); // Use '$' for the current/target document
  const $new = cheerio.load(newHtml);

  const $currentBody = $('body');
  const $newBody = $new('body');
  const $currentHead = $('head');
  const $newHead = $new('head');


  // --- Safety Checks ---
  if (!$currentBody.length) {
      console.warn("Current HTML lacks a <body> tag. Returning new HTML.");
      return newHtml;
  }
   if (!$newBody.length) {
      console.warn("New HTML lacks a <body> tag. Returning current HTML.");
      return currentHtml;
  }
   if (!$currentHead.length || !$newHead.length) {
       console.warn("HTML documents missing <head> tags. Proceeding with body merge only.");
   } else {
       // --- Merge Head Content (Simplified: Add missing elements) ---
       // Add new link/script/meta tags from newHead if not present in currentHead
       $newHead.children().each((_, newHeadChildEl) => {
           const $newChild = $new(newHeadChildEl);
           let exists = false;
           // Basic check based on tag and key attributes (href/src)
           const tagName = newHeadChildEl.tagName;
           const src = $newChild.attr('src');
           const href = $newChild.attr('href');
           const rel = $newChild.attr('rel'); // Useful for links

           if (tagName === 'script' && src) {
               exists = $currentHead.find(`script[src="${src}"]`).length > 0;
           } else if (tagName === 'link' && href && rel === 'stylesheet') {
                exists = $currentHead.find(`link[href="${href}"][rel="stylesheet"]`).length > 0;
           } else if (tagName === 'title') {
               // Replace title
               $('title').text($newChild.text());
               exists = true; // Mark as handled
           }
           // Add other tag checks (meta, etc.) if needed

           if (!exists) {
               // Clone and append
               $currentHead.append($newChild.toString());
           }
       });
   }


  // --- Merge Body Attributes ---
  const newBodyAttrs = $newBody.attr();
  if (newBodyAttrs) {
    const currentClasses = ($currentBody.attr('class') || '').split(/\s+/).filter(Boolean);
    const newClasses = (newBodyAttrs.class || '').split(/\s+/).filter(Boolean);
    const mergedClasses = new Set([...currentClasses, ...newClasses]);

    $currentBody.attr(newBodyAttrs); // Apply new attributes first
    if (mergedClasses.size > 0) {
        $currentBody.attr('class', Array.from(mergedClasses).join(' ')); // Apply merged class
    } else {
         $currentBody.removeAttr('class');
    }
  }

  // --- Merge Body Content Recursively ---
  // Start the recursive merge from the body elements
  recursiveMergeNodes($currentBody, $newBody, $, $new);

  // Return the final merged HTML
  // Use $.html() to get the whole document structure including doctype, html, head, body
  return $.html() || '';
}

// Example Usage (Conceptual - requires environment with cheerio)
/*
const html1 = `
<html><head><title>Initial</title></head>
<body>
  <div id="a" class="content">Visible Part 1</div>
  <div id="b" class="content extra">Visible Part 2</div>
  <div id="c" class="footer">Footer</div>
</body></html>`;

const html2 = `
<html><head><title>Scrolled</title><link rel="stylesheet" href="new.css"></head>
<body>
  <div id="b" class="content extra updated">Visible Part 2 Updated</div>
  <div id="d" class="content loaded">Newly Loaded Content</div>
  <div id="c" class="footer">Footer</div>
</body></html>`;

mergeHtml(html1, html2).then(merged => {
  console.log(merged);
  Expected rough output:
  <html><head><title>Scrolled</title><link rel="stylesheet" href="new.css"></head>
  <body>
    <div id="a" class="content">Visible Part 1</div> // Kept from html1
    <div id="b" class="content extra updated">Visible Part 2 Updated</div> // Updated from html2
    <div id="d" class="content loaded">Newly Loaded Content</div> // Inserted from html2 in correct position
    <div id="c" class="footer">Footer</div> // Kept (or updated if changed in html2)
  </body></html>
});
*/