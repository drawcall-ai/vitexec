import ts from "typescript";
import type {
  StrictSourceIssue,
  StrictSourceLanguage,
  StrictSourceLocation
} from "./types.js";

type StrictProgram = {
  checker: ts.TypeChecker;
  program: ts.Program;
  sourceFile: ts.SourceFile;
};

const librarySourceFiles = new Map<string, ts.SourceFile>();

function sourceLanguage(language: StrictSourceLanguage): {
  fileName: string;
  scriptKind: ts.ScriptKind;
} {
  switch (language) {
    case "javascript":
      return { fileName: "/submitted.js", scriptKind: ts.ScriptKind.JS };
    case "javascript-jsx":
      return { fileName: "/submitted.jsx", scriptKind: ts.ScriptKind.JSX };
    case "typescript":
      return { fileName: "/submitted.ts", scriptKind: ts.ScriptKind.TS };
    case "typescript-jsx":
      return { fileName: "/submitted.tsx", scriptKind: ts.ScriptKind.TSX };
    default:
      throw new Error(`Unsupported strict source language: ${String(language)}`);
  }
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
  const options: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    noResolve: true,
    target: ts.ScriptTarget.ESNext
  };
  const baseHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (path) => path === fileName || baseHost.fileExists(path),
    getSourceFile: (path, languageVersion) => {
      if (path === fileName) return sourceFile;
      const cached = librarySourceFiles.get(path);
      if (cached) return cached;
      const loaded = baseHost.getSourceFile(path, languageVersion);
      if (loaded) librarySourceFiles.set(path, loaded);
      return loaded;
    },
    readFile: (path) => path === fileName ? source : baseHost.readFile(path),
    writeFile: () => {
      throw new Error("Strict source verification does not emit files.");
    }
  };
  const program = ts.createProgram({ host, options, rootNames: [fileName] });
  const programSource = program.getSourceFile(fileName);
  if (!programSource) {
    throw new Error(`TypeScript did not create the strict source file ${fileName}.`);
  }
  return {
    checker: program.getTypeChecker(),
    program,
    sourceFile: programSource
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
