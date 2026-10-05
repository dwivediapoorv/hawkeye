// Recommended maximum lengths for meta tags. Google typically truncates
// titles around 60 characters and descriptions around 160 characters.
export const TITLE_MAX_LENGTH = 60;
export const DESCRIPTION_MAX_LENGTH = 160;

// Length at which we stop reading the body text used as a fallback description.
export const FALLBACK_DESCRIPTION_TRUNCATE_AT = 500;

// A RUNNING scan older than this is treated as abandoned (e.g. the server restarted mid-scan).
export const SCAN_STALE_AFTER_MS = 15 * 60 * 1000;

export const ITEMS_PAGE_SIZE = 50;
