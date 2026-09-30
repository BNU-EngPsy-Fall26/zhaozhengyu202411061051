/* ============================================================
 * 微光侦测站 · 信号检测论 (SDT) 互动实验
 * 纯前端实现，无依赖。双击 index.html 即可运行。
 *
 * 结构：
 *   1. 数学工具（正态分布采样 / Φ / Φ⁻¹）
 *   2. 参数面板
 *   3. 游戏主流程（注视点 → 刺激 → 反应 → 反馈）
 *   4. 结果计算与展示（混淆矩阵 / d′ / c / β / ROC）
 *   5. SDT 概念可视化实验室（分布图 + d′、c 滑块）
 *   6. 历史战绩（localStorage）
 * ============================================================ */

"use strict";

/* ============================================================
 * 1. 数学工具
 * ============================================================ */

/** Box-Muller 变换：生成标准正态分布随机数 N(0,1) */
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** 标准正态分布 CDF Φ(x)，基于误差函数 erf 的 Abramowitz-Stegun 近似 */
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** 标准正态分布逆 CDF Φ⁻¹(p)，Acklam 近似（精度足够 SDT 使用） */
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
              1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
              6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
             -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
             3.754408661907416e0];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r, x;
  if (p < plow) {                       // 下尾部
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
        ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= phigh) {              // 中间区域
    q = p - 0.5; r = q * q;
    x = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
        (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {                              // 上尾部
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
         ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  return x;
}

/* ============================================================
 * 2. DOM 引用 & 参数面板
 * ============================================================ */

const $ = (id) => document.getElementById(id);

const paramTrials    = $("paramTrials");
const paramPrior     = $("paramPrior");
const paramPriorVal  = $("paramPriorVal");
const paramDprime    = $("paramDprime");
const paramDuration  = $("paramDuration");
const paramDurationVal = $("paramDurationVal");
const storyDuration  = $("storyDuration");

// 滑块实时显示
paramTrials.addEventListener("input", () => {
  $("paramTrialsVal").textContent = paramTrials.value + " 次";
});
paramPrior.addEventListener("input", () => {
  paramPriorVal.textContent = Number(paramPrior.value).toFixed(2);
});
paramDprime.addEventListener("input", () => {
  $("paramDprimeVal").textContent = "d′ = " + Number(paramDprime.value).toFixed(1);
});
paramDuration.addEventListener("input", () => {
  paramDurationVal.textContent = paramDuration.value + "ms";
  storyDuration.textContent = paramDuration.value;
});

/* ============================================================
 * 3. 游戏主流程
 * ============================================================ */

const stimCanvas = $("stimCanvas");
const sctx = stimCanvas.getContext("2d");
const overlayText = $("overlayText");
const timerWrap = $("timerWrap");
const timerBar = $("timerBar");
const btnYes = $("btnYes");
const btnNo  = $("btnNo");

/** 游戏状态 */
const game = {
  active: false,
  session: 0,          // 局次计数：用于识别并作废旧局的残留定时器
  timers: [],          // 本局所有待触发的定时器 id（开局时统一清理）
  trials: [],          // 本局所有试次 {isSignal, evidence, saidSignal, rt}
  index: 0,            // 当前试次序号
  nTrials: 40,
  prior: 0.5,
  dprime: 2.0,
  duration: 500,
  awaitingResponse: false,
  stimStartTime: 0,
  rafId: null,         // requestAnimationFrame id
  responseTimer: null,
  flashPos: { x: 0, y: 0 },
};

/**
 * 会话感知的延迟调用：若等待期间开始了新一局（session 变化），
 * 回调自动作废，防止双击开始按钮造成两条试次链并行。
 */
function later(fn, delay) {
  const sess = game.session;
  const id = setTimeout(() => {
    if (game.active && game.session === sess) fn();
  }, delay);
  game.timers.push(id);
  return id;
}

/** 开始一局 */
function startGame() {
  // ---- 清理上一局可能残留的定时器与动画（防止双击开始导致试次链重叠）----
  cancelAnimationFrame(game.rafId);
  clearTimeout(game.responseTimer);
  game.timers.forEach(clearTimeout);
  game.timers = [];
  game.session++;
  game.awaitingResponse = false;

  game.nTrials = Math.max(20, parseInt(paramTrials.value, 10) || 40);
  game.prior   = parseFloat(paramPrior.value);
  game.dprime  = parseFloat(paramDprime.value);
  game.duration = parseInt(paramDuration.value, 10);

  // 按先验概率 P(S) 生成试次序列，并采样每个试次的证据强度
  game.trials = [];
  for (let i = 0; i < game.nTrials; i++) {
    const isSignal = Math.random() < game.prior;
    // 信号试次证据 ~ N(d′, 1)；噪音试次证据 ~ N(0, 1)
    const evidence = isSignal ? game.dprime + randn() : randn();
    game.trials.push({ isSignal, evidence, saidSignal: null, rt: null });
  }
  game.index = 0;
  game.active = true;

  // UI 切换
  $("scenario").classList.add("hidden");
  $("results").classList.add("hidden");
  $("game").classList.remove("hidden");
  $("gameDprime").textContent = "d′ = " + game.dprime.toFixed(1);
  $("gamePrior").textContent = game.prior.toFixed(2);
  updateProgress();
  window.scrollTo({ top: 0, behavior: "smooth" });

  later(nextTrial, 900);
}

function updateProgress() {
  $("trialProgress").textContent = `${Math.min(game.index + 1, game.nTrials)} / ${game.nTrials}`;
}

function setPhase(text) { $("trialPhase").textContent = text; }

/** 单个试次：注视点 → 刺激 → 反应窗 */
function nextTrial() {
  if (!game.active) return;
  if (game.index >= game.nTrials) { endGame(); return; }

  updateProgress();
  const trial = game.trials[game.index];

  // ---- 阶段一：注视点 ----
  setPhase("注视 +");
  btnYes.disabled = btnNo.disabled = true;
  game.awaitingResponse = false;
  drawFixation();

  later(() => {
    // ---- 阶段二：刺激呈现 ----
    setPhase("观察刺激…");
    // 闪光位置（若本试次为信号试次）：避开正中心，随机散布
    game.flashPos = {
      x: 80 + Math.random() * (stimCanvas.width - 160),
      y: 60 + Math.random() * (stimCanvas.height - 120),
    };
    game.stimStartTime = performance.now();
    runStimulusAnimation(trial);

    later(() => {
      cancelAnimationFrame(game.rafId);
      // ---- 阶段三：反应窗（3 秒） ----
      setPhase("请作答！");
      drawBlank();
      btnYes.disabled = btnNo.disabled = false;
      game.awaitingResponse = true;
      const respStart = performance.now();
      trial._respStart = respStart;

      // 反应倒计时条：先无过渡复位到 100%，强制重排后再启动过渡
      timerWrap.style.visibility = "visible";
      timerBar.style.transition = "none";
      timerBar.style.width = "100%";
      void timerBar.offsetWidth; // 强制浏览器先提交 100% 状态，否则过渡可能不播放
      timerBar.style.transition = "width 3s linear";
      timerBar.style.width = "0%";

      // 超时自动记为「没有」（同样受 session 保护）
      const sess = game.session;
      game.responseTimer = setTimeout(() => {
        if (game.session === sess) recordResponse(false);
      }, 3000);
    }, game.duration);
  }, 700);
}

/** 绘制注视点 */
function drawFixation() {
  sctx.fillStyle = "#05070f";
  sctx.fillRect(0, 0, stimCanvas.width, stimCanvas.height);
  sctx.strokeStyle = "rgba(255,255,255,0.9)";
  sctx.lineWidth = 2;
  const cx = stimCanvas.width / 2, cy = stimCanvas.height / 2, r = 12;
  sctx.beginPath();
  sctx.moveTo(cx - r, cy); sctx.lineTo(cx + r, cy);
  sctx.moveTo(cx, cy - r); sctx.lineTo(cx, cy + r);
  sctx.stroke();
  overlayText.textContent = "";
  overlayText.style.color = ""; // 重置上一试次反馈遗留的颜色
}

/** 清空为纯夜空 */
function drawBlank() {
  sctx.fillStyle = "#05070f";
  sctx.fillRect(0, 0, stimCanvas.width, stimCanvas.height);
  overlayText.textContent = "";
}

/**
 * 刺激动画：星空噪点持续闪烁；每个试次都会在随机位置出现一次
 * 「候选闪光」，其亮度由该试次的证据强度决定——
 * 这正是 SDT 的核心：无论信号还是噪音试次，感觉证据都是连续变量。
 */
function runStimulusAnimation(trial) {
  // 证据 → 亮度映射（截断到 [0.04, 1]）
  const brightness = Math.min(1, Math.max(0.04, 0.14 + trial.evidence * 0.28));
  const flashR = 26 + brightness * 10;

  function frame() {
    // 深空背景
    sctx.fillStyle = "#05070f";
    sctx.fillRect(0, 0, stimCanvas.width, stimCanvas.height);

    // 随机噪点（每帧重绘 → 闪烁感）
    for (let i = 0; i < 130; i++) {
      const x = Math.random() * stimCanvas.width;
      const y = Math.random() * stimCanvas.height;
      const a = Math.random() * 0.35;
      const sz = Math.random() < 0.92 ? 1 : 2;
      sctx.fillStyle = `rgba(200,215,255,${a})`;
      sctx.fillRect(x, y, sz, sz);
    }

    // 候选闪光（柔和的径向光斑，位置随机、亮度随证据变化）
    const g = sctx.createRadialGradient(
      game.flashPos.x, game.flashPos.y, 0,
      game.flashPos.x, game.flashPos.y, flashR
    );
    g.addColorStop(0,   `rgba(255,244,214,${0.85 * brightness})`);
    g.addColorStop(0.4, `rgba(255,236,190,${0.35 * brightness})`);
    g.addColorStop(1,   "rgba(255,236,190,0)");
    sctx.fillStyle = g;
    sctx.beginPath();
    sctx.arc(game.flashPos.x, game.flashPos.y, flashR, 0, Math.PI * 2);
    sctx.fill();

    game.rafId = requestAnimationFrame(frame);
  }
  frame();
}

/** 记录一次作答 */
function recordResponse(saidSignal) {
  if (!game.awaitingResponse) return;
  game.awaitingResponse = false;
  clearTimeout(game.responseTimer);
  timerWrap.style.visibility = "hidden";
  btnYes.disabled = btnNo.disabled = true;

  const trial = game.trials[game.index];
  trial.saidSignal = saidSignal;
  trial.rt = Math.round(performance.now() - trial._respStart);

  // ---- 反馈 ----
  let label, color;
  if (trial.isSignal && saidSignal)       { label = "✅ 击中！";      color = "#16a34a"; }
  else if (trial.isSignal && !saidSignal) { label = "😢 漏报：刚才其实有闪光"; color = "#f59e0b"; }
  else if (!trial.isSignal && saidSignal) { label = "😵 虚报：刚才并没有闪光"; color = "#dc2626"; }
  else                                    { label = "✅ 正确拒斥！";   color = "#0ea5e9"; }
  overlayText.textContent = label;
  overlayText.style.color = color;

  setPhase("反馈");
  game.index++;
  later(nextTrial, 950);
}

btnYes.addEventListener("click", () => recordResponse(true));
btnNo.addEventListener("click",  () => recordResponse(false));
// 键盘：F = 有，J = 没有
document.addEventListener("keydown", (e) => {
  if (!game.awaitingResponse) return;
  const k = e.key.toLowerCase();
  if (k === "f") recordResponse(true);
  else if (k === "j") recordResponse(false);
});

/* ============================================================
 * 4. 结果计算与展示
 * ============================================================ */

function endGame() {
  game.active = false;
  game.timers.forEach(clearTimeout);   // 清理本局残留定时器
  game.timers = [];
  setPhase("完成");
  overlayText.textContent = "🎉 本局结束！";
  overlayText.style.color = "";        // 重置反馈遗留的颜色

  // ---- 统计四种结果 ----
  let hit = 0, miss = 0, fa = 0, cr = 0;
  for (const t of game.trials) {
    if (t.isSignal && t.saidSignal) hit++;
    else if (t.isSignal && !t.saidSignal) miss++;
    else if (!t.isSignal && t.saidSignal) fa++;
    else cr++;
  }
  const nSignal = hit + miss;
  const nNoise  = fa + cr;

  // ---- 指标计算（log-linear 校正：每个格子 +0.5，避免 0/1 极端值导致 Z 发散）----
  const pHit = (hit + 0.5) / (nSignal + 1);
  const pFA  = (fa + 0.5) / (nNoise + 1);
  const zH   = normInv(pHit);
  const zFA  = normInv(pFA);
  const dprime = zH - zFA;
  const c      = -0.5 * (zH + zFA);
  const beta   = Math.exp(dprime * c);
  const acc    = (hit + cr) / game.nTrials;

  // ---- 渲染 ----
  $("statHit").textContent = hit;
  $("statMiss").textContent = miss;
  $("statFA").textContent = fa;
  $("statCR").textContent = cr;
  $("statSignalTotal").textContent = nSignal;
  $("statNoiseTotal").textContent = nNoise;

  $("mPHit").textContent   = pHit.toFixed(3);
  $("mPFA").textContent    = pFA.toFixed(3);
  $("mDprime").textContent = dprime.toFixed(2);
  $("mC").textContent      = c.toFixed(2);
  $("mBeta").textContent   = beta.toFixed(2);
  $("mAcc").textContent    = (acc * 100).toFixed(1) + "%";

  // 对 c 的文字解读
  let cNote;
  if (c > 0.25)      cNote = "c > 0：你的判断偏保守——宁可漏报也不轻易说「有」。";
  else if (c < -0.25) cNote = "c < 0：你的判断偏激进——宁可虚报也不想错过闪光。";
  else               cNote = "c ≈ 0：你的判断标准比较中立、客观。";
  $("metricNote").textContent = cNote + "（已采用 log-linear 校正）";

  drawROC(dprime, pFA, pHit);
  saveHistory({
    time: new Date().toLocaleString("zh-CN", { hour12: false }),
    trials: game.nTrials,
    setD: game.dprime,
    dprime, c, pHit, pFA, acc,
  });
  renderHistory();

  // 展示结果（若期间已开启新一局则跳过）
  const sess = game.session;
  setTimeout(() => {
    if (game.session !== sess) return;
    $("game").classList.add("hidden");
    $("results").classList.remove("hidden");
    $("results").scrollIntoView({ behavior: "smooth" });
  }, 1200);
}

/** 绘制 ROC 曲线 */
function drawROC(dprime, pFA, pHit) {
  const cv = $("rocCanvas"), ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, pad = 46;
  ctx.clearRect(0, 0, W, H);

  const X = (v) => pad + v * (W - 2 * pad);
  const Y = (v) => H - pad - v * (H - 2 * pad);

  // 网格与坐标轴
  ctx.strokeStyle = "#e5e7eb";
  ctx.fillStyle = "#6b7280";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  for (let i = 0; i <= 10; i += 2) {
    const v = i / 10;
    ctx.beginPath(); ctx.moveTo(X(v), Y(0)); ctx.lineTo(X(v), Y(1)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(0), Y(v)); ctx.lineTo(X(1), Y(v)); ctx.stroke();
    ctx.fillText(v.toFixed(1), X(v), Y(0) + 16);
    ctx.textAlign = "right"; ctx.fillText(v.toFixed(1), X(0) - 6, Y(v) + 4);
    ctx.textAlign = "center";
  }
  ctx.fillText("P(虚报)", W / 2, H - 8);
  ctx.save();
  ctx.translate(14, H / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("P(击中)", 0, 0);
  ctx.restore();

  // 对角线（随机水平）
  ctx.strokeStyle = "#cbd5e1";
  ctx.setLineDash([6, 5]);
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(1), Y(1)); ctx.stroke();
  ctx.setLineDash([]);

  // 理论 ROC：P(Hit) = Φ(d′ + Z(P(FA)))
  ctx.strokeStyle = "#4f6ef7";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let i = 1; i < 200; i++) {
    const fa = i / 200;
    const h = normCdf(dprime + normInv(fa));
    const px = X(fa), py = Y(h);
    i === 1 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.stroke();

  // 历史数据点（灰）
  const hist = loadHistory();
  ctx.fillStyle = "rgba(100,116,139,0.45)";
  for (const rec of hist) {
    ctx.beginPath();
    ctx.arc(X(rec.pFA), Y(rec.pHit), 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // 本局实测点（红）
  ctx.fillStyle = "#dc2626";
  ctx.beginPath();
  ctx.arc(X(pFA), Y(pHit), 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.stroke();

  // 图例
  ctx.fillStyle = "#374151";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`—— 理论 ROC (d′=${dprime.toFixed(2)})`, pad + 10, pad + 4);
  ctx.fillStyle = "#dc2626";
  ctx.fillText("● 本局实测", pad + 10, pad + 22);
  ctx.fillStyle = "rgba(100,116,139,0.9)";
  ctx.fillText("● 历史各局", pad + 10, pad + 40);
}

/* ============================================================
 * 5. SDT 概念可视化实验室
 * ============================================================ */

const labCanvas = $("labCanvas");
const lctx = labCanvas.getContext("2d");
const labD = $("labD"), labC = $("labC");

function drawLab() {
  const d = parseFloat(labD.value);
  const c = parseFloat(labC.value);
  $("labDVal").textContent = d.toFixed(2);
  $("labCVal").textContent = c.toFixed(2);

  const W = labCanvas.width, H = labCanvas.height, pad = 40;
  lctx.clearRect(0, 0, W, H);

  // 证据轴范围：-3 ~ d+3
  const xMin = -3, xMax = Math.max(3, d + 3);
  const X = (v) => pad + ((v - xMin) / (xMax - xMin)) * (W - 2 * pad);
  const maxPdf = 0.42; // N(0,1) 峰值 ~0.399
  const Y = (pdf) => H - pad - (pdf / maxPdf) * (H - 2 * pad) * 0.92;

  // 判断标准在证据轴上的位置：x_c = d′/2 + c
  const xc = d / 2 + c;

  const pdf = (x, mu) => Math.exp(-((x - mu) ** 2) / 2) / Math.sqrt(2 * Math.PI);

  // 横轴
  lctx.strokeStyle = "#94a3b8";
  lctx.beginPath(); lctx.moveTo(pad, H - pad); lctx.lineTo(W - pad, H - pad); lctx.stroke();
  lctx.fillStyle = "#6b7280";
  lctx.font = "11px sans-serif";
  lctx.textAlign = "center";
  for (let v = Math.ceil(xMin); v <= Math.floor(xMax); v++) {
    lctx.fillText(String(v), X(v), H - pad + 15);
  }
  lctx.fillText("感觉证据强度 →", W / 2, H - 8);

  // 先画两条分布曲线下方的命中/虚报阴影区
  function shadeTail(mu, color) {
    lctx.fillStyle = color;
    lctx.beginPath();
    lctx.moveTo(X(Math.max(xc, xMin)), Y(0));
    for (let x = Math.max(xc, xMin); x <= xMax; x += 0.05) {
      lctx.lineTo(X(x), Y(pdf(x, mu)));
    }
    lctx.lineTo(X(xMax), Y(0));
    lctx.closePath();
    lctx.fill();
  }
  shadeTail(d, "rgba(22,163,74,0.22)");   // 击中区（信号分布右侧）
  shadeTail(0, "rgba(220,38,38,0.18)");   // 虚报区（噪音分布右侧）

  // 绘制两条分布曲线
  function drawCurve(mu, color) {
    lctx.strokeStyle = color;
    lctx.lineWidth = 2.2;
    lctx.beginPath();
    for (let x = xMin; x <= xMax; x += 0.03) {
      const px = X(x), py = Y(pdf(x, mu));
      x === xMin ? lctx.moveTo(px, py) : lctx.lineTo(px, py);
    }
    lctx.stroke();
  }
  drawCurve(0, "#dc2626");  // 噪音
  drawCurve(d, "#16a34a");  // 信号

  // 判断标准竖线
  lctx.strokeStyle = "#2b3a67";
  lctx.lineWidth = 2;
  lctx.setLineDash([7, 5]);
  lctx.beginPath();
  lctx.moveTo(X(xc), pad * 0.6);
  lctx.lineTo(X(xc), H - pad);
  lctx.stroke();
  lctx.setLineDash([]);
  lctx.fillStyle = "#2b3a67";
  lctx.font = "bold 12px sans-serif";
  lctx.fillText(`标准 x_c = ${xc.toFixed(2)}`, X(xc), pad * 0.6 - 8);

  // 图例
  lctx.textAlign = "left";
  lctx.font = "12px sans-serif";
  lctx.fillStyle = "#dc2626";
  lctx.fillText("—— 噪音分布 N(0,1)", pad + 8, pad + 2);
  lctx.fillStyle = "#16a34a";
  lctx.fillText(`—— 信号分布 N(${d.toFixed(2)},1)`, pad + 8, pad + 20);
  lctx.fillStyle = "rgba(22,163,74,0.7)";
  lctx.fillText("■ 击中区", pad + 170, pad + 2);
  lctx.fillStyle = "rgba(220,38,38,0.7)";
  lctx.fillText("■ 虚报区", pad + 170, pad + 20);

  // 读数：标准右移会降低击中率同时也降低虚报率
  const pHit = 1 - normCdf(xc - d);
  const pFA  = 1 - normCdf(xc);
  $("labPHit").textContent = pHit.toFixed(3);
  $("labPFA").textContent  = pFA.toFixed(3);
  $("labDOut").textContent = d.toFixed(2);
  $("labCOut").textContent = c.toFixed(2);
  // AUC（ROC 曲线下面积）：等方差高斯 SDT 下有解析解 AUC = Φ(d′/√2)
  const auc = normCdf(d / Math.SQRT2);
  $("labAUC").textContent = auc.toFixed(3);

  // 联动绘制 ROC 曲线与 zROC 直线
  drawLabROC(d, pFA, pHit);
}

/**
 * 实验室 ROC 交互可视化（与 d′、c 滑块联动）
 * 左：概率坐标 ROC；右：Z 变换后的 zROC 直线 z(H) = z(FA) + d′
 * 红点为当前判断标准 c 对应的操作点，两个坐标系一一对应。
 */
function drawLabROC(d, pFA, pHit) {
  /* ---------- 左图：概率坐标 ROC ---------- */
  {
    const cv = $("labRocCanvas"), ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height, pad = 34;
    ctx.clearRect(0, 0, W, H);
    const X = (v) => pad + v * (W - 2 * pad);
    const Y = (v) => H - pad - v * (H - 2 * pad);

    // 网格 + 刻度
    ctx.strokeStyle = "#eef1f6";
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let i = 0; i <= 5; i++) {
      const v = i / 5;
      ctx.beginPath(); ctx.moveTo(X(v), Y(0)); ctx.lineTo(X(v), Y(1)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(0), Y(v)); ctx.lineTo(X(1), Y(v)); ctx.stroke();
      ctx.fillText(v.toFixed(1), X(v), Y(0) + 13);
      ctx.textAlign = "right"; ctx.fillText(v.toFixed(1), X(0) - 5, Y(v) + 3);
      ctx.textAlign = "center";
    }
    ctx.fillText("P(FA)", W / 2, H - 4);
    ctx.save(); ctx.translate(11, H / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText("P(Hit)", 0, 0); ctx.restore();

    // 参考曲线组：多个 d′ 的 ROC（淡灰，便于对比当前 d′）
    for (const ref of [0.5, 1, 1.5, 2, 2.5, 3]) {
      ctx.strokeStyle = "rgba(148,163,184,0.35)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 1; i < 200; i++) {
        const fa = i / 200;
        const h = normCdf(ref + normInv(fa));
        i === 1 ? ctx.moveTo(X(fa), Y(h)) : ctx.lineTo(X(fa), Y(h));
      }
      ctx.stroke();
    }
    // 精确绘制当前 d′ 的曲线（保证红点始终落在曲线上）
    ctx.strokeStyle = "#4f6ef7";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 1; i < 200; i++) {
      const fa = i / 200;
      const h = normCdf(d + normInv(fa));
      i === 1 ? ctx.moveTo(X(fa), Y(h)) : ctx.lineTo(X(fa), Y(h));
    }
    ctx.stroke();

    // 对角线（随机水平 d′=0）
    ctx.strokeStyle = "#cbd5e1";
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(1), Y(1)); ctx.stroke();
    ctx.setLineDash([]);

    // 当前操作点
    ctx.fillStyle = "#dc2626";
    ctx.beginPath(); ctx.arc(X(pFA), Y(pHit), 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
    // 点到两轴的虚线投影
    ctx.strokeStyle = "rgba(220,38,38,0.5)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(pFA), Y(pHit)); ctx.lineTo(X(pFA), Y(0));
    ctx.moveTo(X(pFA), Y(pHit)); ctx.lineTo(X(0), Y(pHit)); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#374151";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`d′ = ${d.toFixed(2)}　AUC = ${normCdf(d / Math.SQRT2).toFixed(3)}`, pad + 6, pad + 6);
  }

  /* ---------- 右图：zROC 直线（Z 变换坐标） ---------- */
  {
    const cv = $("labZRocCanvas"), ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height, pad = 34;
    ctx.clearRect(0, 0, W, H);
    const zMax = 2.5;
    const X = (z) => pad + ((z + zMax) / (2 * zMax)) * (W - 2 * pad);
    const Y = (z) => H - pad - ((z + zMax) / (2 * zMax)) * (H - 2 * pad);

    // 网格 + 刻度
    ctx.strokeStyle = "#eef1f6";
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let z = -2; z <= 2; z++) {
      ctx.beginPath(); ctx.moveTo(X(z), Y(-zMax)); ctx.lineTo(X(z), Y(zMax)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(-zMax), Y(z)); ctx.lineTo(X(zMax), Y(z)); ctx.stroke();
      ctx.fillText(String(z), X(z), Y(-zMax) + 13);
      ctx.textAlign = "right"; ctx.fillText(String(z), X(-zMax) - 5, Y(z) + 3);
      ctx.textAlign = "center";
    }
    ctx.fillText("z(FA)", W / 2, H - 4);
    ctx.save(); ctx.translate(11, H / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText("z(Hit)", 0, 0); ctx.restore();

    // 参考直线组（截距 = d′）
    for (const ref of [0.5, 1, 1.5, 2, 2.5, 3]) {
      ctx.strokeStyle = "rgba(148,163,184,0.35)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(X(-zMax), Y(-zMax + ref));
      ctx.lineTo(X(zMax - ref), Y(zMax));
      ctx.stroke();
    }
    // 随机水平：d′=0 → 过原点、斜率 1
    ctx.strokeStyle = "#cbd5e1";
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(X(-zMax), Y(-zMax)); ctx.lineTo(X(zMax), Y(zMax)); ctx.stroke();
    ctx.setLineDash([]);

    // 当前 d′ 的 zROC 直线：z(H) = z(FA) + d′
    ctx.strokeStyle = "#4f6ef7";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(X(-zMax), Y(-zMax + d));
    ctx.lineTo(X(zMax - d), Y(zMax));
    ctx.stroke();
    // 标注截距（z(FA)=0 处的高度即 d′）；y 值夹紧到画布内，避免 d′ > 2.5 时越界消失
    ctx.fillStyle = "#4f6ef7";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "left";
    const labelY = Math.max(Y(d) - 5, pad + 12);
    ctx.fillText(`截距 = d′ = ${d.toFixed(2)}`, X(0) + 5, labelY);

    // 当前操作点（与左图同一 c）
    const zFA = normInv(pFA), zH = normInv(pHit);
    ctx.fillStyle = "#dc2626";
    ctx.beginPath(); ctx.arc(X(zFA), Y(zH), 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = "rgba(220,38,38,0.5)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(zFA), Y(zH)); ctx.lineTo(X(zFA), Y(-zMax));
    ctx.moveTo(X(zFA), Y(zH)); ctx.lineTo(X(-zMax), Y(zH)); ctx.stroke();
    ctx.setLineDash([]);

    // 更新坐标读数
    $("rocPtFA").textContent  = pFA.toFixed(3);
    $("rocPtH").textContent   = pHit.toFixed(3);
    $("zrocPtFA").textContent = zFA.toFixed(2);
    $("zrocPtH").textContent  = zH.toFixed(2);
  }
}

labD.addEventListener("input", drawLab);
labC.addEventListener("input", drawLab);

/* ============================================================
 * 6. 历史战绩（localStorage）
 * ============================================================ */

const HISTORY_KEY = "sdt_history_v1";

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}

function saveHistory(rec) {
  const hist = loadHistory();
  hist.unshift(rec);                 // 最新在前
  if (hist.length > 30) hist.pop();  // 最多保留 30 局
  localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
}

function renderHistory() {
  const hist = loadHistory();
  const body = $("historyBody");
  body.innerHTML = "";
  if (hist.length === 0) {
    body.innerHTML = '<tr><td colspan="9" class="empty-row">暂无记录，玩一局试试吧！</td></tr>';
    return;
  }
  // 找出最佳准确率用于高亮
  const bestAcc = Math.max(...hist.map((r) => r.acc));
  hist.slice(0, 12).forEach((r, i) => {
    const tr = document.createElement("tr");
    if (r.acc === bestAcc) tr.style.background = "#fefce8";
    tr.innerHTML =
      `<td>${i + 1}</td><td>${r.time}</td><td>${r.trials}</td>` +
      `<td>${r.setD.toFixed(1)}</td><td>${r.dprime.toFixed(2)}</td>` +
      `<td>${r.c.toFixed(2)}</td><td>${r.pHit.toFixed(2)}</td>` +
      `<td>${r.pFA.toFixed(2)}</td><td><strong>${(r.acc * 100).toFixed(1)}%</strong></td>`;
    body.appendChild(tr);
  });
}

$("btnClearHistory").addEventListener("click", () => {
  if (confirm("确定要清空所有历史战绩吗？")) {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  }
});

/* ============================================================
 * 入口绑定
 * ============================================================ */

$("btnStart").addEventListener("click", startGame);
$("btnAgain").addEventListener("click", startGame);
$("btnBackSettings").addEventListener("click", () => {
  $("results").classList.add("hidden");
  $("scenario").classList.remove("hidden");
  $("scenario").scrollIntoView({ behavior: "smooth" });
});

// 页面加载后初始化
drawLab();
renderHistory();
