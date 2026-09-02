export type StrictSourceLanguage =
  | "javascript"
  | "javascript-jsx"
  | "typescript"
  | "typescript-jsx";

export type StrictSourceIssueCode =
  | "escape-hatch"
  | "external-call"
  | "external-write"
  | "parse-error"
  | "unsupported-syntax";

export type StrictSourceLocation = {
  column: number;
  line: number;
};

export type StrictSourceIssue = {
  code: StrictSourceIssueCode;
  end: StrictSourceLocation;
  message: string;
  start: StrictSourceLocation;
};

export type StrictSourceVerification = {
  issues: StrictSourceIssue[];
  ok: boolean;
};

export type VerifyStrictSourceOptions = {
  language?: StrictSourceLanguage;
};
