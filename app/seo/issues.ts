// Issue codes stored in ScanItem.issues. The first four also have their own
// boolean columns (titleTooLong, …), which older scans rely on.
export const ISSUE_CODES = [
  "TITLE_LONG",
  "TITLE_SHORT",
  "TITLE_DUPLICATE",
  "DESCRIPTION_LONG",
  "DESCRIPTION_SHORT",
  "DESCRIPTION_MISSING",
  "DESCRIPTION_DUPLICATE",
  "THIN_CONTENT",
  "COPIED_CONTENT",
  "MISSING_ALT",
  "IMAGE_FILENAMES",
  "HANDLE",
  "EMPTY_COLLECTION",
  "NO_COLLECTION",
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

export const isIssueCode = (value: string): value is IssueCode =>
  (ISSUE_CODES as readonly string[]).includes(value);

// `label` is used in the issue filter, `short` in the summary tile breakdown.
export const ISSUE_INFO: Record<IssueCode, { label: string; short: string }> = {
  TITLE_LONG: { label: "Title too long", short: "too long" },
  TITLE_SHORT: { label: "Title too short", short: "too short" },
  TITLE_DUPLICATE: { label: "Duplicate title", short: "duplicate" },
  DESCRIPTION_LONG: { label: "Description too long", short: "too long" },
  DESCRIPTION_SHORT: { label: "Description too short", short: "too short" },
  DESCRIPTION_MISSING: { label: "Description missing", short: "missing" },
  DESCRIPTION_DUPLICATE: { label: "Duplicate description", short: "duplicate" },
  THIN_CONTENT: { label: "Thin content", short: "thin" },
  COPIED_CONTENT: { label: "Copied content", short: "copied" },
  MISSING_ALT: { label: "Images missing alt text", short: "missing alt text" },
  IMAGE_FILENAMES: { label: "Camera-style image names", short: "camera file names" },
  HANDLE: { label: "URL handle issue", short: "messy URLs" },
  EMPTY_COLLECTION: { label: "Empty collection", short: "empty collections" },
  NO_COLLECTION: { label: "Not in any collection", short: "not in a collection" },
};

export type IssueGroupKey = "titles" | "descriptions" | "content" | "images" | "structure";

export const ISSUE_GROUPS: {
  key: IssueGroupKey;
  label: string;
  caption: string;
  codes: IssueCode[];
}[] = [
  {
    key: "titles",
    label: "Meta titles",
    caption: "Length and duplicates",
    codes: ["TITLE_LONG", "TITLE_SHORT", "TITLE_DUPLICATE"],
  },
  {
    key: "descriptions",
    label: "Meta descriptions",
    caption: "Length, missing and duplicates",
    codes: ["DESCRIPTION_LONG", "DESCRIPTION_SHORT", "DESCRIPTION_MISSING", "DESCRIPTION_DUPLICATE"],
  },
  {
    key: "content",
    label: "Content",
    caption: "Thin or copied descriptions",
    codes: ["THIN_CONTENT", "COPIED_CONTENT"],
  },
  {
    key: "images",
    label: "Images",
    caption: "Alt text and file names",
    codes: ["MISSING_ALT", "IMAGE_FILENAMES"],
  },
  {
    key: "structure",
    label: "URLs & structure",
    caption: "Handles and collections",
    codes: ["HANDLE", "EMPTY_COLLECTION", "NO_COLLECTION"],
  },
];

// Stored in Scan.issueCounts: items per issue code, and items with any issue per group.
export type IssueCounts = {
  codes: Partial<Record<IssueCode, number>>;
  groups: Partial<Record<IssueGroupKey, number>>;
};
