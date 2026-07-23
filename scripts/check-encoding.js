const fs = require("node:fs");
const path = require("node:path");

const decoder = new TextDecoder("utf-8", { fatal: true });
const excludedDirectories = new Set([".git", "node_modules"]);
const textExtensions = new Set([
  ".example",
  ".js",
  ".json",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
]);
const textFileNames = new Set([".editorconfig", ".gitignore"]);
const files = [];

function collectTextFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;

    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectTextFiles(filePath);
    } else if (textFileNames.has(entry.name) || textExtensions.has(path.extname(entry.name))) {
      files.push(filePath);
    }
  }
}

collectTextFiles(".");

let failed = false;
for (const filePath of files) {
  const bytes = fs.readFileSync(filePath);
  try {
    const text = decoder.decode(bytes);
    if (text.includes("\uFFFD") || /[\u0080-\u009F]/u.test(text)) {
      console.error(`Invalid Unicode marker: ${filePath}`);
      failed = true;
    }
  } catch (error) {
    console.error(`Invalid UTF-8: ${filePath}: ${error.message}`);
    failed = true;
  }
}

const srcRoot = path.join("src");
const sourceFiles = files.filter((filePath) => filePath === srcRoot || filePath.startsWith(`src${path.sep}`) || filePath.startsWith("src/"));
const source = sourceFiles.map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");
const expectedSourceText = [
  "\u9ED8\u8BA4\u5F00\u542F",
  "\u7F16\u8F91\u8282\u6D41\u95F4\u9694",
  "\u672A\u914D\u7F6E Azure \u8BED\u97F3\u670D\u52A1",
  "\u8BED\u97F3\u8BC6\u522B\u5931\u8D25",
  "\u9274\u6743\u5931\u8D25",
];

for (const expected of expectedSourceText) {
  if (!source.includes(expected)) {
    console.error(`Expected Chinese source text is missing: ${JSON.stringify(expected)}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`UTF-8 check passed (${files.length} files).`);
