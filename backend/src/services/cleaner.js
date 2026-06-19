/**
 * Generic, high-performance HTML/MIME email content cleaner.
 * Processes raw email HTML and text contents into clean, scannable, human-readable prose.
 * 
 * Works for any Gmail account and any email sender dynamically.
 */
export function cleanEmailContent(htmlContent, plainTextContent) {
  let text = '';
  
  if (htmlContent) {
    let html = htmlContent;
    
    // 1. Strip CSS/Style blocks and Script blocks (and their content)
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    
    // 2. Remove HTML comments
    html = html.replace(/<!--[\s\S]*?-->/gi, '');
    
    // 3. Remove tracking pixels and hidden images (e.g. width/height is 1px, or display: none)
    html = html.replace(/<img[^>]+width=["'](?:1|0)["'][^>]*>/gi, '');
    html = html.replace(/<img[^>]+height=["'](?:1|0)["'][^>]*>/gi, '');
    html = html.replace(/<img[^>]+style=["'][^"']*display:\s*none[^"']*["'][^>]*>/gi, '');
    
    // 4. Format block tags and list tags to preserve layout readability
    html = html.replace(/<\/p>/gi, '\n\n');
    html = html.replace(/<\/div>/gi, '\n');
    html = html.replace(/<\/tr>/gi, '\n');
    html = html.replace(/<\/td>/gi, ' ');
    html = html.replace(/<br\s*\/?>/gi, '\n');
    html = html.replace(/<li[^>]*>/gi, '\n• ');
    html = html.replace(/<\/li>/gi, '');
    
    // Format headers with spacing
    html = html.replace(/<h[1-6][^>]*>/gi, '\n\n');
    html = html.replace(/<\/h[1-6]>/gi, '\n');
    
    // 5. Clean and format links
    // Replace <a href="URL">Text</a> with "Text (URL)" while stripping tracking UTM parameters
    html = html.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, url, linkText) => {
      let cleanUrl = url.trim();
      try {
        // Only attempt to parse absolute URLs to avoid failures on relative or custom links
        if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) {
          const urlObj = new URL(cleanUrl);
          const paramsToStrip = [
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 
            'clickid', 'gclid', 'fbclid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi'
          ];
          paramsToStrip.forEach(p => urlObj.searchParams.delete(p));
          cleanUrl = urlObj.toString();
        }
      } catch (e) {
        // Fail-safe: keep original URL if parsing fails
      }
      
      const cleanText = linkText.replace(/<[^>]+>/g, '').trim();
      if (!cleanText) return '';
      
      // If the link text is identical to the URL or contains no useful text, skip listing the URL twice
      if (cleanText === cleanUrl || cleanUrl.startsWith('mailto:') || cleanUrl.startsWith('tel:') || cleanUrl.startsWith('javascript:')) {
        return cleanText;
      }
      
      // If URL is too long and looks like tracking redirect, just keep the anchor text
      if (cleanUrl.length > 180 || cleanUrl.includes('click') || cleanUrl.includes('track')) {
        return cleanText;
      }
      
      return `${cleanText} (${cleanUrl})`;
    });

    // 6. Strip all remaining HTML tags
    text = html.replace(/<[^>]+>/g, '');
  } else {
    text = plainTextContent || '';
  }

  // 7. Decode HTML entities & NCRs (Numerical Character References)
  const htmlEntities = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&ndash;': '-',
    '&mdash;': '--',
    '&copy;': '(c)',
    '&reg;': '(r)'
  };
  
  Object.entries(htmlEntities).forEach(([entity, replacement]) => {
    text = text.replace(new RegExp(entity, 'g'), replacement);
  });
  
  // Decode decimal references (e.g. &#8217;)
  text = text.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)));
  // Decode hexadecimal references (e.g. &#x2019;)
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));

  // 8. Filter MIME boundaries and raw transport headers
  text = text.split('\n')
    .filter(line => {
      const trimmed = line.trim();
      // Filter out boundary boundaries like --0000000000000 or ------=NextPart
      if (trimmed.startsWith('--') && (trimmed.length > 15 || /[0-9a-fA-F]{10,}/.test(trimmed))) return false;
      // Filter out transport protocol leaking lines
      if (/^(mime-version|content-type|content-transfer-encoding|content-id|content-disposition):/i.test(trimmed)) return false;
      return true;
    })
    .join('\n');

  // 9. Strip generic footer boilerplates
  const boilerplatePatterns = [
    /unsubscribe/i,
    /view\s+in\s+browser/i,
    /manage\s+(your\s+)?subscriptions/i,
    /manage\s+preferences/i,
    /update\s+profile/i,
    /privacy\s+policy/i,
    /terms\s+of\s+service/i,
    /all\s+rights\s+reserved/i
  ];
  
  text = text.split('\n')
    .map(line => {
      const trimmed = line.trim();
      // If a line is short and contains unsubscribe links or legal boilerplates, discard it
      if (trimmed.length < 80) {
        const isBoilerplate = boilerplatePatterns.some(pattern => pattern.test(trimmed));
        if (isBoilerplate) return '';
      }
      return line;
    })
    .join('\n');

  // 10. Normalize whitespace and empty lines
  text = text.replace(/[ \t]+/g, ' '); // collapse duplicate spaces/tabs
  text = text.replace(/\r/g, '');      // strip carriage returns
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n'); // collapse multiple consecutive blank lines to max 2
  
  return text.trim();
}
