import ts from "typescript";
import type {
  StrictSourceIssue,
  StrictSourceLanguage,
  StrictSourceLocation
} from "./types.js";

type StrictProgram = {
  diagnostics: readonly ts.Diagnostic[];
  sourceFile: ts.SourceFile;
};

function sourceLanguage(language: StrictSourceLanguage): {
  fileName: string;
  scriptKind: ts.ScriptKind;
} {
  return language === "javascript"
    ? { fileName: "/submitted.js", scriptKind: ts.ScriptKind.JS }
    : { fileName: "/submitted.ts", scriptKind: ts.ScriptKind.TS };
}

export function createStrictProgram(
  source: string,
  language: StrictSourceLanguage
): StrictProgram {
  const { fileName, scriptKind } = sourceLanguage(language);
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const diagnostics = ts.transpileModule(source, {
    compilerOptions: {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext
    },
    fileName,
    reportDiagnostics: true
  }).diagnostics ?? [];
  return {
    diagnostics,
    sourceFile
  };
}

function location(
  sourceFile: ts.SourceFile,
  position: number
): StrictSourceLocation {
  const value = sourceFile.getLineAndCharacterOfPosition(position);
  return { column: value.character + 1, line: value.line + 1 };
}

export function diagnosticIssue(
  sourceFile: ts.SourceFile,
  diagnostic: ts.Diagnostic
): StrictSourceIssue {
  const start = diagnostic.start ?? 0;
  const end = start + (diagnostic.length ?? 0);
  return {
    code: "parse-error",
    end: location(sourceFile, end),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    start: location(sourceFile, start)
  };
}

export function sourceIssue(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  code: StrictSourceIssue["code"],
  message: string
): StrictSourceIssue {
  return {
    code,
    end: location(sourceFile, node.getEnd()),
    message,
    start: location(sourceFile, node.getStart(sourceFile))
  };
}
