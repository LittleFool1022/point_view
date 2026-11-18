import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const NODE_BUILTINS = new Set(["fs", "path", "child_process", "os", "crypto", "http", "https", "net", "stream", "url", "util"]);
const RENDERER_FORBIDDEN_IMPORTS = new Set(["electron", ...NODE_BUILTINS]);
const HEADLESS_FORBIDDEN_IMPORTS = new Set(["react", "react-dom", "three", "electron", ...NODE_BUILTINS]);
const UI_VIEW_NAMES = new Set([
  "App",
  "CloudView",
  "BuildingWorkspace",
  "BuildingPlan",
  "BuildingScene",
  "PairedWorkspace",
  "PairedOpeningEditor",
  "RenderWorkspace",
  "DeviceImport",
  "AccuracyPanel",
  "WallElevationView"
]);
const PREVIEW_ALLOWED_FILES = new Set(["src/domain/source.ts", "src/pipeline/binaryPcd.ts"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function walkFiles(dirPath, rootDir) {
  if (!fs.existsSync(dirPath)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "release" || entry.name === "artifacts") continue;
      files.push(...walkFiles(abs, rootDir));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(toPosix(path.relative(rootDir, abs)));
    }
  }
  return files.sort();
}

function scriptKindFor(relPath) {
  if (relPath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (relPath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (relPath.endsWith(".js") || relPath.endsWith(".mjs") || relPath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lineAt(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function packageRoot(specifier) {
  if (specifier.startsWith("node:")) return specifier.slice(5);
  if (specifier.startsWith(".") || specifier.startsWith("/")) return "";
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? "";
}

function isUiImport(specifier) {
  if (!specifier.startsWith(".")) return false;
  const clean = specifier.replace(/\.(tsx|ts|jsx|js)$/, "");
  const base = path.posix.basename(clean);
  return specifier.endsWith(".tsx") || UI_VIEW_NAMES.has(base);
}

function findComments(code, sourceFile) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.TSX, code);
  const hits = [];
  while (true) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) break;
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const text = scanner.getTokenText();
      if (/@ts-(ignore|nocheck|expect-error)\b/.test(text)) {
        hits.push({ line: lineAt(sourceFile, scanner.getTokenPos()), text: text.trim() });
      }
    }
  }
  return hits;
}

export function checkSourceContent(relPath, code) {
  const violations = [];
  const sourceFile = ts.createSourceFile(relPath, code, ts.ScriptTarget.Latest, true, scriptKindFor(relPath));
  const isSrc = relPath.startsWith("src/");
  const isDomain = relPath.startsWith("src/domain/");
  const isPipeline = relPath.startsWith("src/pipeline/");
  const isElectron = relPath.startsWith("electron/");
  const isTests = relPath.startsWith("tests/");

  for (const comment of findComments(code, sourceFile)) {
    violations.push({
      rule: "no-ts-suppression",
      file: relPath,
      line: comment.line,
      message: `禁止使用类型压制注释 (${comment.text})。`,
      fix: "通过完善类型定义、窄化收束或运行时类型守卫解决类型报错，不要屏蔽编译器。"
    });
  }

  function checkImportSpecifier(specifier, node) {
    const line = lineAt(sourceFile, node.getStart(sourceFile));
    if (/(^|\/)(dist|release|artifacts)(\/|$)/.test(specifier)) {
      violations.push({
        rule: "no-generated-import",
        file: relPath,
        line,
        message: `禁止从构建或产物目录导入 (${specifier})。`,
        fix: "仅从 src/ 或受控共享源码目录导入模块。"
      });
    }
    const pkg = packageRoot(specifier);
    if (isSrc && (specifier.startsWith("node:") || RENDERER_FORBIDDEN_IMPORTS.has(pkg))) {
      violations.push({
        rule: "renderer-no-node-or-electron",
        file: relPath,
        line,
        message: `渲染层与领域层禁止直接依赖 ${specifier}。`,
        fix: "保持 Node/Electron 隔离，桌面能力统一通过 window.surveyDesktop 桥接。"
      });
    }
    if ((isDomain || isPipeline) && (HEADLESS_FORBIDDEN_IMPORTS.has(pkg) || isUiImport(specifier))) {
      violations.push({
        rule: isDomain ? "domain-purity" : "pipeline-purity",
        file: relPath,
        line,
        message: `${isDomain ? "src/domain" : "src/pipeline"} 禁止依赖 UI/Three/React 模块 (${specifier})。`,
        fix: "将纯几何、校验或 Worker 算法保留在 headless 层，视图展示放在 src/*.tsx。"
      });
    }
    if ((isDomain || isPipeline) && /(^|\/)CloudView(\.[a-z]+)?$/.test(specifier)) {
      violations.push({
        rule: "preview-index-isolation",
        file: relPath,
        line,
        message: `禁止在 ${isDomain ? "domain" : "pipeline"} 中引用预览组件 CloudView。`,
        fix: "预览采样仅用于渲染层，点云清洗/拟合/剖切必须操作全量点云索引。"
      });
    }
  }

  function visit(node) {
    if (ts.isDebuggerStatement(node)) {
      violations.push({
        rule: "no-debugger",
        file: relPath,
        line: lineAt(sourceFile, node.getStart(sourceFile)),
        message: "代码中遗留了 debugger 语句。",
        fix: "删除 debugger 断点语句后再提交或构建。"
      });
    }

    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      checkImportSpecifier(node.moduleSpecifier.text, node);
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      if (isSrc || isElectron) {
        violations.push({
          rule: "no-unsafe-dom-or-eval",
          file: relPath,
          line: lineAt(sourceFile, node.getStart(sourceFile)),
          message: "禁止使用 new Function() 动态构造代码。",
          fix: "使用静态 TypeScript/JS 函数或声明式映射替代动态代码求值。"
        });
      }
    }

    if ((isSrc || isElectron) && ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "dangerouslySetInnerHTML") {
      violations.push({
        rule: "no-unsafe-dom-or-eval",
        file: relPath,
        line: lineAt(sourceFile, node.getStart(sourceFile)),
        message: "禁止使用 dangerouslySetInnerHTML。",
        fix: "使用受控 JSX 文本或结构化 SVG/Canvas 渲染，避免桌面环境 DOM 注入风险。"
      });
    }

    if ((isSrc || isElectron) && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(node.left) && node.left.name.text === "innerHTML") {
        violations.push({
          rule: "no-unsafe-dom-or-eval",
          file: relPath,
          line: lineAt(sourceFile, node.getStart(sourceFile)),
          message: "禁止直接赋值 .innerHTML。",
          fix: "改用 textContent 或受控 DOM API。"
        });
      }
    }

    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const line = lineAt(sourceFile, node.getStart(sourceFile));

      if ((isSrc || isElectron) && ts.isIdentifier(expr) && expr.text === "eval") {
        violations.push({
          rule: "no-unsafe-dom-or-eval",
          file: relPath,
          line,
          message: "禁止调用 eval()。",
          fix: "移除动态求值，改用显式解析器或参数映射。"
        });
      }

      if (expr.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        checkImportSpecifier(node.arguments[0].text, node);
      }
      if (isSrc && ts.isIdentifier(expr) && expr.text === "require") {
        violations.push({
          rule: "renderer-no-require",
          file: relPath,
          line,
          message: "src/ ESM 代码禁止调用 require()。",
          fix: "改用标准 ES import，桌面能力走 window.surveyDesktop。"
        });
      }
      if ((isSrc || isElectron) && ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "console" && expr.name.text === "log") {
        violations.push({
          rule: "clean-console",
          file: relPath,
          line,
          message: "禁止在生产代码保留调试 console.log。",
          fix: "移除调试日志；确需告警或错误边界请改用受控提示或 console.warn/error。"
        });
      }
      if (isTests && ts.isPropertyAccessExpression(expr) && expr.name.text === "only") {
        const target = expr.expression.getText(sourceFile);
        if (/^(test|it|describe|fixture)(\.|$)/.test(target)) {
          violations.push({
            rule: "no-focused-tests",
            file: relPath,
            line,
            message: `测试文件中禁止保留 ${target}.only(...)。`,
            fix: "移除 .only 以确保全部回归用例都能真实执行。"
          });
        }
      }
    }

    if (isSrc && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "window" && node.name.text === "require") {
      violations.push({
        rule: "renderer-no-require",
        file: relPath,
        line: lineAt(sourceFile, node.getStart(sourceFile)),
        message: "禁止访问 window.require。",
        fix: "桌面原生接口必须通过 preload 暴露的 window.surveyDesktop 声明与调用。"
      });
    }

    if (isSrc && ts.isIdentifier(node) && node.text === "PREVIEW_POINTS" && !PREVIEW_ALLOWED_FILES.has(relPath)) {
      const parent = node.parent;
      const isPropertyKey = ts.isPropertyAssignment(parent) && parent.name === node;
      if (!isPropertyKey) {
        violations.push({
          rule: "preview-index-isolation",
          file: relPath,
          line: lineAt(sourceFile, node.getStart(sourceFile)),
          message: "禁止在非预览采样模块中依赖 PREVIEW_POINTS。",
          fix: "点云清洗、画笔选择、墙线拟合与立面出图必须使用全量原始点索引，不得耦合 120,000 预览上限。"
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function hasCallTo(node, fnName) {
  let found = false;
  function walk(cur) {
    if (found) return;
    if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && cur.expression.text === fnName) {
      found = true;
      return;
    }
    ts.forEachChild(cur, walk);
  }
  walk(node);
  return found;
}

function extractBooleanProp(objLiteral, name) {
  for (const prop of objLiteral.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === name) {
      if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
    }
  }
  return undefined;
}

export function checkIpcContract({ mainCode, preloadCode, envDtsCode }) {
  const violations = [];
  const mainSf = ts.createSourceFile("electron/main.cjs", mainCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const preloadSf = ts.createSourceFile("electron/preload.cjs", preloadCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const envSf = ts.createSourceFile("src/env.d.ts", envDtsCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const mainChannels = new Map();
  let webPrefsVerified = false;
  let hasWindowOpenGuard = false;
  let hasWillNavigateGuard = false;

  function visitMain(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const obj = node.expression.expression;
      const method = node.expression.name.text;
      if (ts.isIdentifier(obj) && obj.text === "ipcMain" && method === "handle") {
        const [chArg, handlerArg] = node.arguments;
        const line = lineAt(mainSf, node.getStart(mainSf));
        if (chArg && ts.isStringLiteral(chArg)) {
          mainChannels.set(chArg.text, line);
          if (!handlerArg || !hasCallTo(handlerArg, "assertOwner")) {
            violations.push({
              rule: "ipc-assert-owner",
              file: "electron/main.cjs",
              line,
              message: `ipcMain.handle("${chArg.text}") 缺少 assertOwner(event) 窗口校验。`,
              fix: "在 handler 起始位置调用 assertOwner(event)，防止未授权 WebContents 调用原生能力。"
            });
          }
        }
      }
      if (method === "setWindowOpenHandler") hasWindowOpenGuard = true;
      if (method === "on" && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "will-navigate") {
        hasWillNavigateGuard = true;
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "BrowserWindow") {
      const opts = node.arguments?.[0];
      const line = lineAt(mainSf, node.getStart(mainSf));
      if (opts && ts.isObjectLiteralExpression(opts)) {
        const wpProp = opts.properties.find(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "webPreferences");
        if (wpProp && ts.isPropertyAssignment(wpProp) && ts.isObjectLiteralExpression(wpProp.initializer)) {
          const wp = wpProp.initializer;
          const ci = extractBooleanProp(wp, "contextIsolation");
          const ni = extractBooleanProp(wp, "nodeIntegration");
          const sb = extractBooleanProp(wp, "sandbox");
          if (ci === true && ni === false && sb === true) {
            webPrefsVerified = true;
          } else {
            violations.push({
              rule: "electron-security",
              file: "electron/main.cjs",
              line,
              message: `BrowserWindow webPreferences 安全配置漂移 (contextIsolation=${ci}, nodeIntegration=${ni}, sandbox=${sb})。`,
              fix: "保持 { contextIsolation: true, nodeIntegration: false, sandbox: true }。"
            });
            webPrefsVerified = true;
          }
        }
      }
    }
    ts.forEachChild(node, visitMain);
  }
  visitMain(mainSf);

  if (!webPrefsVerified) {
    violations.push({
      rule: "electron-security",
      file: "electron/main.cjs",
      line: 1,
      message: "未检测到明确的 BrowserWindow 安全配置 webPreferences。",
      fix: "保留 BrowserWindow webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }。"
    });
  }
  if (!hasWindowOpenGuard || !hasWillNavigateGuard) {
    violations.push({
      rule: "electron-security",
      file: "electron/main.cjs",
      line: 1,
      message: "缺少窗口弹窗拦截 (setWindowOpenHandler) 或导航拦截 (will-navigate)。",
      fix: "在 createWindow 中保留 setWindowOpenHandler(() => ({ action: \"deny\" })) 与 will-navigate 阻止逻辑。"
    });
  }

  const preloadChannels = new Map();
  const preloadMethods = new Map();
  function visitPreload(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const obj = node.expression.expression;
      const method = node.expression.name.text;
      const line = lineAt(preloadSf, node.getStart(preloadSf));
      if (ts.isIdentifier(obj) && obj.text === "ipcRenderer" && method === "invoke" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        preloadChannels.set(node.arguments[0].text, line);
      }
      if (ts.isIdentifier(obj) && obj.text === "contextBridge" && method === "exposeInMainWorld") {
        const [apiName, apiObj] = node.arguments;
        if (apiName && ts.isStringLiteral(apiName) && apiName.text === "surveyDesktop" && apiObj && ts.isObjectLiteralExpression(apiObj)) {
          for (const prop of apiObj.properties) {
            if ((ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) && ts.isIdentifier(prop.name)) {
              preloadMethods.set(prop.name.text, lineAt(preloadSf, prop.getStart(preloadSf)));
            }
          }
        }
      }
    }
    ts.forEachChild(node, visitPreload);
  }
  visitPreload(preloadSf);

  const envMethods = new Map();
  function visitEnv(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "Window") {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name) && member.name.text === "surveyDesktop" && member.type && ts.isTypeLiteralNode(member.type)) {
          for (const sub of member.type.members) {
            if ((ts.isMethodSignature(sub) || ts.isPropertySignature(sub)) && sub.name && ts.isIdentifier(sub.name)) {
              envMethods.set(sub.name.text, lineAt(envSf, sub.getStart(envSf)));
            }
          }
        }
      }
    }
    ts.forEachChild(node, visitEnv);
  }
  visitEnv(envSf);

  for (const [ch, line] of preloadChannels) {
    if (!mainChannels.has(ch)) {
      violations.push({
        rule: "ipc-contract-parity",
        file: "electron/preload.cjs",
        line,
        message: `preload 调用了未在 electron/main.cjs 注册的 IPC 通道 "${ch}"。`,
        fix: `在 electron/main.cjs 中补充 ipcMain.handle("${ch}", ...)，并执行 assertOwner(event)。`
      });
    }
  }
  for (const [ch, line] of mainChannels) {
    if (!preloadChannels.has(ch)) {
      violations.push({
        rule: "ipc-contract-parity",
        file: "electron/main.cjs",
        line,
        message: `main.cjs 注册了未在 electron/preload.cjs 暴露的 IPC 通道 "${ch}"。`,
        fix: `检查是否遗漏 preload 暴露或清理已废弃的 ipcMain.handle("${ch}")。`
      });
    }
  }
  for (const [name, line] of preloadMethods) {
    if (!envMethods.has(name)) {
      violations.push({
        rule: "bridge-type-parity",
        file: "electron/preload.cjs",
        line,
        message: `surveyDesktop.${name} 已在 preload 暴露，但缺少 src/env.d.ts 类型声明。`,
        fix: `在 src/env.d.ts 的 Window.surveyDesktop 接口中添加 ${name} 签名。`
      });
    }
  }
  for (const [name, line] of envMethods) {
    if (!preloadMethods.has(name)) {
      violations.push({
        rule: "bridge-type-parity",
        file: "src/env.d.ts",
        line,
        message: `Window.surveyDesktop.${name} 在 src/env.d.ts 中声明，但未在 electron/preload.cjs 实现。`,
        fix: `在 electron/preload.cjs 中实现 ${name} 或移除无效类型声明。`
      });
    }
  }

  return violations;
}

export function runGuardrails(rootDir = path.resolve(import.meta.dirname, "..")) {
  const relFiles = ["src", "electron", "scripts", "tests"].flatMap(dir => walkFiles(path.join(rootDir, dir), rootDir));
  const violations = [];
  for (const rel of relFiles) {
    const code = fs.readFileSync(path.join(rootDir, rel), "utf8");
    violations.push(...checkSourceContent(rel, code));
  }

  const mainPath = path.join(rootDir, "electron/main.cjs");
  const preloadPath = path.join(rootDir, "electron/preload.cjs");
  const envPath = path.join(rootDir, "src/env.d.ts");
  if (fs.existsSync(mainPath) && fs.existsSync(preloadPath) && fs.existsSync(envPath)) {
    violations.push(
      ...checkIpcContract({
        mainCode: fs.readFileSync(mainPath, "utf8"),
        preloadCode: fs.readFileSync(preloadPath, "utf8"),
        envDtsCode: fs.readFileSync(envPath, "utf8")
      })
    );
  }

  return { ok: violations.length === 0, violations, checkedFiles: relFiles.length };
}

const isDirectEntry = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectEntry) {
  const result = runGuardrails();
  if (!result.ok) {
    for (const v of result.violations) {
      console.error(`[${v.rule}] ${v.file}:${v.line} - ${v.message}`);
      console.error(`  fix: ${v.fix}`);
    }
    console.error(`\nGuardrails failed: ${result.violations.length} violation(s) across ${result.checkedFiles} files.`);
    process.exit(1);
  }
  console.log(`Guardrails passed (${result.checkedFiles} files checked).`);
}
