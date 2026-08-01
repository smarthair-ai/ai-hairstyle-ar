/**
 * 临时校验脚本：确认 loop / stepFrame 里使用的标识符都能在模块作用域解析。
 * 用于验证「vw is not defined」这类跨作用域引用 bug 已被修复。
 */
import { readFileSync } from 'node:fs';

// 去掉注释与字符串字面量，避免注释里的词被误判为标识符
function strip(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')  // 行注释（避开 http://）
    .replace(/'(?:\\.|[^'\\])*'/g, "''")   // 单引号字符串
    .replace(/"(?:\\.|[^"\\])*"/g, '""');  // 双引号字符串
}

const src = strip(readFileSync('js/main.js', 'utf8'));

function bodyOf(name) {
  const re = new RegExp(`function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n\\}\\n`);
  const m = src.match(re);
  return m ? { params: m[1], body: m[2] } : null;
}

const KW = new Set(['if', 'else', 'return', 'const', 'let', 'var', 'function', 'new', 'typeof',
  'of', 'in', 'true', 'false', 'null', 'undefined', 'this', 'void', 'delete', 'instanceof',
  'for', 'while', 'do', 'break', 'continue', 'try', 'catch', 'throw', 'await', 'async',
  'Math', 'Number', 'String', 'Object', 'Array', 'JSON', 'performance', 'console',
  'window', 'document', 'requestAnimationFrame', 'setTimeout', 'Promise', 'Error']);

// 模块作用域声明
const declared = new Set();
src.replace(/(?:^|\n)(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g, (_, n) => (declared.add(n), _));
src.replace(/import\s*\{([^}]+)\}/g, (_, g) => {
  g.split(',').forEach(s => declared.add(s.trim().split(/\s+as\s+/).pop()));
  return _;
});
src.replace(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g, (_, n) => (declared.add(n), _));

let bad = 0;
for (const fn of ['loop', 'stepFrame', 'noFaceHint']) {
  const f = bodyOf(fn);
  if (!f) { console.log(`⚠️  未找到函数 ${fn}`); continue; }

  const local = new Set(declared);
  f.params.split(',').map(s => s.trim()).filter(Boolean).forEach(p => local.add(p));
  f.body.replace(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, (_, n) => (local.add(n), _));
  f.body.replace(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g, (_, n) => (local.add(n), _));

  const ids = new Set();
  // 去掉模板字符串里的 ${} 插值标记与属性访问，只留真正的自由变量
  const clean = f.body.replace(/\$\{/g, ' ').replace(/`/g, ' ');
  clean.replace(/(?<![.\w$?])([A-Za-z_$][\w$]*)(?!\s*:)/g, (_, id) => (ids.add(id), _));

  const missing = [...ids].filter(id => !KW.has(id) && !local.has(id));
  if (missing.length) { bad++; console.log(`❌ ${fn}() 中未声明: ${missing.join(', ')}`); }
  else console.log(`✅ ${fn}() 标识符全部可解析`);
}

process.exit(bad ? 1 : 0);
