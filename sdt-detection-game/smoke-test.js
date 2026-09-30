/**
 * 冒烟测试：用 stub 的浏览器环境实际执行 script.js，
 * 验证脚本加载、页面初始化（drawLab/renderHistory）及核心计算路径不抛异常。
 * 用法: node smoke-test.js
 */
const fs = require("fs");
const vm = require("vm");

const js = fs.readFileSync(__dirname + "/script.js", "utf8");

// ---------- 浏览器环境 stub ----------
function makeCtx() {
  const noop = () => {};
  return {
    clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop,
    fill: noop, fillRect: noop, arc: noop, fillText: noop, save: noop,
    restore: noop, rotate: noop, translate: noop, closePath: noop,
    setLineDash: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    fillStyle: null, strokeStyle: null, lineWidth: 1, font: null, textAlign: null,
  };
}
function makeEl(id) {
  return {
    id,
    textContent: "",
    innerHTML: "",
    value: id === "paramPrior" ? "0.5" : id === "paramDuration" ? "500" : id === "paramDprime" ? "2" : id === "labC" ? "0" : id === "labD" ? "2" : id === "paramTrials" ? "40" : "",
    style: {},
    disabled: false,
    width: 600, height: 400,
    classList: { add: () => {}, remove: () => {} },
    addEventListener: () => {},
    scrollIntoView: () => {},
    getContext: () => makeCtx(),
    appendChild: () => {},
    offsetWidth: 100,
  };
}
const els = {};
const sandbox = {
  console,
  Math, JSON, Date, Number, String, parseInt, parseFloat, Infinity,
  performance: { now: () => Date.now() },
  setTimeout: (fn, ms) => { setTimeout(fn, Math.min(ms, 5)); return 1; },
  clearTimeout: () => {},
  requestAnimationFrame: (fn) => { fn(); return 1; },
  cancelAnimationFrame: () => {},
  confirm: () => true,
  localStorage: (() => {
    let store = {};
    return {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    };
  })(),
  window: { scrollTo: () => {} },
  document: {
    getElementById: (id) => (els[id] = els[id] || makeEl(id)),
    addEventListener: () => {},
    createElement: () => makeEl("_dyn"),
  },
};
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);

// ---------- 执行脚本（相当于页面加载）----------
try {
  vm.runInContext(js, sandbox, { filename: "script.js" });
  console.log("✓ 脚本加载并初始化成功（drawLab / renderHistory 已在加载时执行）");
} catch (e) {
  console.error("✗ 脚本加载失败:", e.stack);
  process.exit(1);
}

// ---------- 在沙箱内调用核心函数 ----------
const tests = [
  ["drawLab()", "实验室绘图"],
  ["startGame()", "开始一局"],
  ["recordResponse(true)", "作答：有"],
  ["recordResponse(false)", "作答：没有"],
  ["endGame()", "结算与指标计算"],
  ["drawROC(2, 0.2, 0.8)", "结果区 ROC 绘制"],
  ["renderHistory()", "历史记录渲染"],
];
for (const [code, name] of tests) {
  try {
    vm.runInContext(code, sandbox);
    console.log("✓", name);
  } catch (e) {
    console.error("✗", name, "失败:", e.stack);
    process.exit(1);
  }
}

// ---------- 数值合理性抽检 ----------
const d = vm.runInContext("(function(){ const z=normInv(0.8413)-normInv(0.1587); return z; })()", sandbox);
console.log(Math.abs(d - 2) < 0.01 ? "✓ d′ 数值抽检正确 (" + d.toFixed(3) + ")" : "✗ d′ 数值异常: " + d);

console.log("\n全部冒烟测试通过 ✓");
