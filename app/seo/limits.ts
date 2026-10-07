// Recommended maximum lengths for meta tags. Google typically truncates
// titles around 60 characters and descriptions around 160 characters.
export const TITLE_MAX_LENGTH = 60;
export const DESCRIPTION_MAX_LENGTH = 160;

// Below these lengths a title or description wastes space in the search result.
export const TITLE_MIN_LENGTH = 30;
export const DESCRIPTION_MIN_LENGTH = 70;

// A product description with fewer words than this gives search engines little to rank.
export const THIN_CONTENT_WORDS = 50;
// Identical descriptions shorter than this are too generic to count as copied.
export const COPIED_CONTENT_MIN_WORDS = 20;

// URL handles longer than this are hard to read in search results.
export const HANDLE_MAX_LENGTH = 60;

// Length at which we stop reading the body text used as a fallback description.
export const FALLBACK_DESCRIPTION_TRUNCATE_AT = 500;

// A RUNNING scan that has not reported progress for this long is treated as
// abandoned (e.g. the server restarted mid-scan).
export const SCAN_STALE_AFTER_MS = 5 * 60 * 1000;

export const ITEMS_PAGE_SIZE = 50;
