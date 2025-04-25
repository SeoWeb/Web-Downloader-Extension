import * as cheerio from "cheerio";
import { Element } from 'domhandler';

// Types for element identification and tracking
interface ElementSignature {
  tagName: string;
  id: string | null;
  classes: string[];
  key: string;
  index: number;
}

/**
 * Creates a unique signature for an element based on various attributes
 * for more reliable element matching across HTML documents
 */
function createElementSignature($: cheerio.CheerioAPI, element: Element, index: number): ElementSignature {
  const $el = $(element);
  const tagName = element.tagName?.toLowerCase() || '';
  const id = $el.attr('id') || null;
  const classAttr = $el.attr('class') || '';
  const classes = classAttr.split(/\s+/).filter(Boolean).sort();
  
  // Create a normalized representation of the element for comparison
  // This focuses on structure rather than content for better matching
  const key = tagName + 
    (id ? `#${id}` : '') + 
    (classes.length ? `.${classes.join('.')}` : '') +
    ($el.attr('data-key') || '');
  
  return { tagName, id, classes, key, index };
}

/**
 * Compares two elements to determine if they're "the same" element
 * across different HTML snapshots
 */
function elementsMatch(sig1: ElementSignature, sig2: ElementSignature): boolean {
  // ID is the strongest identifier if available
  if (sig1.id && sig2.id) {
    return sig1.id === sig2.id;
  }
  
  // For elements without IDs, use tag name plus class combination
  if (sig1.tagName === sig2.tagName) {
    // If both have classes, compare them
    if (sig1.classes.length && sig2.classes.length) {
      // Check if they share at least one distinctive class
      return sig1.classes.some(cls => sig2.classes.includes(cls));
    } 
    // If elements have the same tag but no classes, compare their positions
    return Math.abs(sig1.index - sig2.index) < 3; // Allow small position differences
  }
  
  return false;
}

/**
 * Merge two HTML strings, preserving content from the first while adding new content from the second
 */
export async function mergeHtml(currentHtml: string, newHtml: string): Promise<string> {
  if (!currentHtml) return newHtml;
  if (!newHtml) return currentHtml;

  const $current = cheerio.load(currentHtml);
  const $new = cheerio.load(newHtml);
  
  // Focus on the body content which typically contains the important parts
  const $currentBody = $current('body');
  const $newBody = $new('body');
  
  if (!$currentBody.length || !$newBody.length) {
    console.warn("Could not find body elements for merging. Returning new HTML.");
    return newHtml;
  }
  
  // First, preserve the document structure: head, attributes, etc.
  mergeHeadContent($current, $new);
  mergeBodyAttributes($current, $new);
  
  // Process all direct children of the body
  const currentChildren = $currentBody.children().toArray();
  const newChildren = $newBody.children().toArray();

  // Build signatures for all current elements for faster lookup
  const currentSignatures = currentChildren.map((el, idx) => 
    createElementSignature($current, el, idx));
  
  // Track which elements from the current HTML have been matched
  const matchedCurrentElements = new Set<number>();
  
  // Process each child from the new HTML
  newChildren.forEach((newElement, newIndex) => {
    const newSig = createElementSignature($new, newElement, newIndex);
    
    // Try to find a matching element in the current HTML
    const matchingCurrentIdx = currentSignatures.findIndex((currentSig, idx) => 
      !matchedCurrentElements.has(idx) && elementsMatch(currentSig, newSig));
    
    if (matchingCurrentIdx !== -1) {
      // Found a match - update the content of the existing element
      matchedCurrentElements.add(matchingCurrentIdx);
      const currentElement = currentChildren[matchingCurrentIdx];
      
      // Replace the inner content but keep the element itself
      if (currentElement.children && currentElement.children.length > 0) {
        // Recursively merge the children
        const currentElementHtml = $current.html(currentElement);
        const newElementHtml = $new.html(newElement);
        if (currentElementHtml && newElementHtml) {
          const mergedChildContent = mergeElementContent(currentElementHtml, newElementHtml);
          $current(currentElement).html(mergedChildContent);
        }
      } else {
        // If no children, just update the content directly
        $current(currentElement).html($new(newElement).html() || '');
      }
    } else {
      // No match found - this is a new element
      // Clone the element into the current HTML context
      const newElementHtml = $new.html(newElement);
      if (newElementHtml) {
        $currentBody.append(newElementHtml);
      }
    }
  });

  // Handle elements that were in the original HTML but not in the new HTML
  // Important: We keep these elements instead of removing them to preserve content
  // that might have been scrolled off the top

  // Return the final merged HTML
  return $current.html() || '';
}

/**
 * Merges the content of one element with another
 */
function mergeElementContent(currentElementHtml: string, newElementHtml: string): string {
  // For simple cases, we can use a direct replacement
  if (currentElementHtml.length < 100 || newElementHtml.length < 100) {
    return newElementHtml;
  }
  
  // For more complex elements, do a recursive merge
  const $currentEl = cheerio.load(currentElementHtml);
  const $newEl = cheerio.load(newElementHtml);
  
  // Compare children and merge them appropriately
  // This is a simplified approach - in a real implementation, you might want
  // more sophisticated logic here depending on your specific HTML structure
  const $currentRoot = $currentEl('body > *');
  const $newRoot = $newEl('body > *');
  
  // If structures are compatible, attempt to merge
  if ($currentRoot.length === 1 && $newRoot.length === 1) {
    const tagName1 = $currentRoot[0].tagName;
    const tagName2 = $newRoot[0].tagName;
    
    if (tagName1 === tagName2) {
      $currentRoot.html($newRoot.html() || '');
      return $currentRoot.toString();
    }
  }
  
  // Default case - use the new content
  return newElementHtml;
}

/**
 * Merges head content from new HTML into current HTML
 */
function mergeHeadContent($current: cheerio.CheerioAPI, $new: cheerio.CheerioAPI): void {
  const $currentHead = $current('head');
  const $newHead = $new('head');
  
  if (!$currentHead.length || !$newHead.length) return;
  
  // Merge meta tags, scripts, styles, etc.
  // This ensures important resources are included
  
  // Update title if present
  const newTitle = $new('title').text();
  if (newTitle) {
    if ($current('title').length) {
      $current('title').text(newTitle);
    } else {
      $currentHead.append(`<title>${newTitle}</title>`);
    }
  }
  
  // Add new scripts that don't exist in current
  $new('head script').each((_, script) => {
    const src = $new(script).attr('src');
    if (src && !$current(`head script[src="${src}"]`).length) {
      $currentHead.append($new.html(script));
    }
  });
  
  // Add new stylesheets that don't exist in current
  $new('head link[rel="stylesheet"]').each((_, link) => {
    const href = $new(link).attr('href');
    if (href && !$current(`head link[href="${href}"]`).length) {
      $currentHead.append($new.html(link));
    }
  });
}

/**
 * Merges body attributes from new HTML into current HTML
 */
function mergeBodyAttributes($current: cheerio.CheerioAPI, $new: cheerio.CheerioAPI): void {
  const $currentBody = $current('body');
  const $newBody = $new('body');
  
  if (!$currentBody.length || !$newBody.length) return;
  
  // Preserve important attributes like classes and data attributes
  const newBodyAttrs = $newBody.attr();
  if (newBodyAttrs) {
    // Merge classes rather than replacing
    if (newBodyAttrs.class) {
      const currentClasses = ($currentBody.attr('class') || '').split(/\s+/).filter(Boolean);
      const newClasses = newBodyAttrs.class.split(/\s+/).filter(Boolean);
      
      // Add new classes that don't already exist
      newClasses.forEach(cls => {
        if (!currentClasses.includes(cls)) {
          currentClasses.push(cls);
        }
      });
      
      newBodyAttrs.class = currentClasses.join(' ');
    }
    
    // Apply merged attributes to current body
    $currentBody.attr(newBodyAttrs);
  }
}