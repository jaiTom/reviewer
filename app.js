const $ = (sel) => document.querySelector(sel);

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function shuffleInPlace(arr){
  for(let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function deepClone(obj){ return JSON.parse(JSON.stringify(obj)); }
function normalizeText(s){
  return (s || "")
    .replace(/\u00A0/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function setLog(msg){
  const el = $("#log");
  el.textContent = msg || "";
}
function downloadFile(filename, text){
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* Persist across reload, clear on tab close */
const SESSION_KEY = "mcq_reviewer_state_v5_scrollsafe";
function loadSession(){
  try{ return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); }catch{ return null; }
}
function saveSession(state){
  try{ sessionStorage.setItem(SESSION_KEY, JSON.stringify(state)); }catch{}
}
function clearSession(){
  try{ sessionStorage.removeItem(SESSION_KEY); }catch{}
}

/* App state */
let parsedQuestions = [];
let quizQuestions = [];
let idx = 0;
let score = 0;
let answered = [];
let locked = false;
let autoNextTimer = null;

let isReviewerMode = false;
let quizPlaceholder = null;

const AUTO_NEXT_MS = 1100;

/* ---------------------------
   Scroll-safe tap protection
---------------------------- */
let lastScrollTs = 0;
function markScrolled(){ lastScrollTs = Date.now(); }

// capture scroll anywhere (page + modal)
document.addEventListener("scroll", markScrolled, { passive: true, capture: true });

// Block "clicks" that are really scroll-drags
function wireScrollSafeTap(el){
  let sx = 0, sy = 0;

  el.addEventListener("pointerdown", (e) => {
    sx = e.clientX; sy = e.clientY;
    el.dataset.drag = "0";
  }, { passive: true });

  el.addEventListener("pointermove", (e) => {
    const dx = Math.abs(e.clientX - sx);
    const dy = Math.abs(e.clientY - sy);
    if (dx > 12 || dy > 12) el.dataset.drag = "1";
  }, { passive: true });

  // If it was a drag or recent scroll, cancel click that would select the radio
  el.addEventListener("click", (e) => {
    const recentlyScrolled = (Date.now() - lastScrollTs) < 220;
    if (el.dataset.drag === "1" || recentlyScrolled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

// Auto-next, but NEVER while user is actively scrolling
function scheduleAutoNext(){
  clearTimeout(autoNextTimer);

  const tick = () => {
    if ((Date.now() - lastScrollTs) < 220) {
      autoNextTimer = setTimeout(tick, 220);
      return;
    }
    nextQuestion();
  };

  autoNextTimer = setTimeout(tick, AUTO_NEXT_MS);
}

/* ---------------------------
   PDF.js
---------------------------- */
async function ensurePdfJs(){
  if (window.pdfjsReady) await window.pdfjsReady;
  if (!window.pdfjsLib) throw new Error("PDF.js not loaded. Check lib/pdf.mjs and lib/pdf.worker.mjs.");
  return window.pdfjsLib;
}

async function extractTextFromPdf(file){
  const pdfjsLib = await ensurePdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let allLines = [];
  for(let p = 1; p <= pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const textContent = await page.getTextContent();

    const rows = new Map();
    for(const it of textContent.items){
      const x = it.transform[4];
      const y = it.transform[5];
      const yKey = Math.round(y * 2) / 2;
      if(!rows.has(yKey)) rows.set(yKey, []);
      rows.get(yKey).push({ x, str: it.str });
    }

    const yKeys = [...rows.keys()].sort((a,b)=> b-a);
    for(const yKey of yKeys){
      const parts = rows.get(yKey).sort((a,b)=> a.x - b.x).map(o => o.str);
      const line = normalizeText(parts.join(" "));
      if(line) allLines.push(line);
    }
    allLines.push("");
  }
  return normalizeText(allLines.join("\n"));
}

/* ---------------------------
   Parsing: Answer Explanations
---------------------------- */
function parseMcqText(rawText){
  const text = normalizeText(rawText);

  let mainText = text;
  let answerKeyText = "";

  const keyMatch = text.match(/\n(?:answers?|answer key|answer explanations)\b[\s\S]*$/i);
  if(keyMatch){
    answerKeyText = keyMatch[0];
    mainText = text.slice(0, keyMatch.index).trim();
  }

  // Question blocks "1." / "1)" / "1 -"
  const blocks = [];
  const reStart = /(?:^|\n)\s*(\d{1,4})\s*(?:[.)-])\s+/g;

  let m, lastIdx = 0, lastNo = null;
  while((m = reStart.exec(mainText)) !== null){
    const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
    const qNo = parseInt(m[1], 10);

    if(lastNo !== null){
      const prev = mainText.slice(lastIdx, start).trim();
      if(prev) blocks.push({ number: lastNo, body: prev });
    }
    lastNo = qNo;
    lastIdx = start;
  }
  if(lastNo !== null){
    const tail = mainText.slice(lastIdx).trim();
    if(tail) blocks.push({ number: lastNo, body: tail });
  }
  if(blocks.length === 0 && mainText.length > 0){
    blocks.push({ number: 1, body: mainText });
  }

  // Answer Explanations map
  const answerMap = new Map();
  if(answerKeyText){
    const ak = answerKeyText.trim();

    // "1. Correct answer: D" + explanation until next number
    const reBlock = /(?:^|\n)\s*(\d{1,4})\.\s*Correct\s*answer\s*:\s*([A-D])\s*([\s\S]*?)(?=(?:\n\s*\d{1,4}\.\s*Correct\s*answer\s*:)|$)/gi;

    let bm, found = false;
    while((bm = reBlock.exec(ak)) !== null){
      found = true;
      const num = parseInt(bm[1], 10);
      const letter = bm[2].toUpperCase();
      const exp = normalizeText(bm[3] || "");
      answerMap.set(num, { letter, exp });
    }

    // Fallback simple "1) B - explanation"
    if(!found){
      const lines = ak.split("\n").map(l => l.trim()).filter(Boolean);
      for(const line of lines){
        const mm = line.match(/^(\d{1,4})\s*[\).:-]?\s*([A-D])\b(?:\s*[-–—:]\s*(.+))?$/i);
        if(mm){
          answerMap.set(parseInt(mm[1],10), { letter: mm[2].toUpperCase(), exp: (mm[3]||"").trim() });
        }
      }
    }
  }

  // Extract MCQs with A-D options
  const out = [];
  for(const b of blocks){
    const body = b.body;

    const optRe = /(?:^|\n)\s*([A-D])\s*(?:[).:-])\s+/g;
    const optHits = [];
    let om;
    while((om = optRe.exec(body)) !== null){
      optHits.push({ idx: om.index, key: om[1].toUpperCase() });
    }
    if(optHits.length < 2) continue;

    const firstOptPos = optHits[0].idx + (body[optHits[0].idx] === "\n" ? 1 : 0);
    const qText = body.slice(0, firstOptPos).trim();

    const options = [];
    for(let i = 0; i < optHits.length; i++){
      const start = optHits[i].idx + (body[optHits[i].idx] === "\n" ? 1 : 0);
      const end = (i + 1 < optHits.length) ? optHits[i + 1].idx : body.length;
      const chunk = body.slice(start, end).trim();
      const kk = optHits[i].key;
      const cleaned = chunk.replace(new RegExp("^\\s*" + kk + "\\s*(?:[).:-])\\s+"), "").trim();
      if(cleaned) options.push({ key: kk, text: cleaned });
    }

    const ak = answerMap.get(b.number);
    const answerKey = ak ? ak.letter : "";
    const explanation = ak ? ak.exp : "";

    out.push({ number: b.number, question: qText, options, answerKey, explanation });
  }

  return out.filter(q => q.question && q.options && q.options.length >= 3);
}

/* ---------------------------
   Reviewer modal
---------------------------- */
function enterReviewerMode(){
  if(isReviewerMode) return;

  const overlay = $("#reviewerOverlay");
  const mount = $("#reviewerMount");
  const quizCard = $("#quizCard");

  quizPlaceholder = document.createElement("div");
  quizCard.parentNode.insertBefore(quizPlaceholder, quizCard);

  mount.appendChild(quizCard);

  overlay.classList.remove("hide");
  overlay.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  isReviewerMode = true;
  persist();
}

function exitReviewerMode(){
  if(!isReviewerMode) return;

  const overlay = $("#reviewerOverlay");
  const quizCard = $("#quizCard");

  overlay.classList.add("hide");
  overlay.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";

  if(quizPlaceholder && quizPlaceholder.parentNode){
    quizPlaceholder.parentNode.insertBefore(quizCard, quizPlaceholder);
    quizPlaceholder.remove();
    quizPlaceholder = null;
  }

  isReviewerMode = false;
  persist();
}

/* ---------------------------
   Quiz
---------------------------- */
function prepareQuizFresh(){
  const shuffleQ = $("#togShuffleQ").checked;
  const shuffleO = $("#togShuffleO").checked;

  quizQuestions = deepClone(parsedQuestions);

  for(const q of quizQuestions){
    q.options = q.options.map(o => ({ key: String(o.key || "").toUpperCase(), text: (o.text || "").trim() }));
    if(shuffleO) shuffleInPlace(q.options);
  }
  if(shuffleQ) shuffleInPlace(quizQuestions);

  idx = 0;
  score = 0;
  answered = [];
  locked = false;

  clearTimeout(autoNextTimer);
  autoNextTimer = null;
}

function updateKPIs(){
  $("#kpiParsed").textContent = String(parsedQuestions.length);
  $("#kpiQ").textContent = quizQuestions.length ? `${clamp(idx+1,1,quizQuestions.length)}/${quizQuestions.length}` : "0/0";
  $("#kpiScore").textContent = String(score);

  const pct = quizQuestions.length ? (idx / quizQuestions.length) * 100 : 0;
  $("#progressFill").style.width = `${clamp(pct,0,100)}%`;
}

function persist(){
  saveSession({
    parsedQuestions,
    quizQuestions,
    idx,
    score,
    answered,
    isReviewerMode,
    settings: {
      shuffleQ: $("#togShuffleQ").checked,
      shuffleO: $("#togShuffleO").checked
    }
  });
}

function renderQuestion(){
  const q = quizQuestions[idx];
  if(!q) return;

  $("#quizEmpty").classList.add("hide");
  $("#resultArea").classList.add("hide");
  $("#quizArea").classList.remove("hide");
  $("#btnRestart").disabled = false;

  $("#qText").textContent = q.question;

  const form = $("#optForm");
  form.innerHTML = "";

  q.options.forEach((o, i) => {
    const id = `opt_${idx}_${i}`;
    const label = document.createElement("label");
    label.className = "opt";
    label.setAttribute("for", id);

    label.innerHTML = `
      <input type="radio" name="opt" id="${id}" value="${escapeHtml(o.key)}">
      <div class="k">${escapeHtml(o.key)})</div>
      <div class="t">${escapeHtml(o.text)}</div>
    `;
    form.appendChild(label);

    // scroll-safe: prevent accidental select while scrolling
    wireScrollSafeTap(label);
  });

  $("#btnNext").classList.add("hide");
  $("#feedback").classList.remove("show");
  $("#fbTag").className = "tag";
  $("#fbText").textContent = "";

  // Auto-submit on tap/click (but ignore if user just scrolled)
  form.onchange = () => {
    if(locked) return;
    if ((Date.now() - lastScrollTs) < 220) return;
    const checked = form.querySelector('input[type="radio"]:checked');
    if(checked) submitAnswer();
  };

  // If this question was already answered (restore on reload), show the state
  const prev = answered[idx];
  if(prev && prev.chosenKey){
    const input = form.querySelector(`input[value="${CSS.escape(prev.chosenKey)}"]`);
    if(input) input.checked = true;
    locked = true;
    showFeedback(!!prev.isCorrect, String(prev.chosenKey).toUpperCase());
    $("#btnNext").classList.remove("hide");
  } else {
    locked = false;
  }

  updateKPIs();
  persist();
}

function showFeedback(isCorrect, chosenKey){
  const q = quizQuestions[idx];
  const correctKey = (q.answerKey || "").toUpperCase();

  [...$("#optForm").querySelectorAll(".opt")].forEach(lab => {
    const key = lab.querySelector("input").value.toUpperCase();
    lab.classList.remove("correct","wrong");
    if(correctKey && key === correctKey) lab.classList.add("correct");
    if(key === chosenKey && chosenKey !== correctKey) lab.classList.add("wrong");
  });

  $("#feedback").classList.add("show");
  const tag = $("#fbTag");
  tag.className = "tag " + (isCorrect ? "good" : "bad");
  tag.textContent = isCorrect ? "Correct" : "Incorrect";

  const exp = q.explanation || "No explanation found in Answer Explanations.";
  const ansLine = correctKey ? `Correct answer: ${correctKey}` : "Correct answer: (missing)";

  $("#fbText").innerHTML =
    `<div class="fbLine"><span class="mono">${escapeHtml(ansLine)}</span></div>` +
    `<div class="fbLine">${escapeHtml(exp)}</div>`;
}

function submitAnswer(){
  const q = quizQuestions[idx];
  const checked = $("#optForm").querySelector('input[type="radio"]:checked');
  if(!checked) return;

  locked = true;

  const chosenKey = checked.value.toUpperCase();
  const correctKey = (q.answerKey || "").toUpperCase();
  const isCorrect = !!correctKey && chosenKey === correctKey;

  answered[idx] = { chosenKey, isCorrect };
  if(isCorrect) score += 1;

  showFeedback(isCorrect, chosenKey);
  $("#btnNext").classList.remove("hide");

  updateKPIs();
  persist();

  clearTimeout(autoNextTimer);
  if(isCorrect){
    scheduleAutoNext(); // scroll-safe auto-next
  }
}

function nextQuestion(){
  clearTimeout(autoNextTimer);
  autoNextTimer = null;

  locked = false;
  idx += 1;

  if(idx >= quizQuestions.length) finishQuiz();
  else renderQuestion();
}

function finishQuiz(){
  $("#quizArea").classList.add("hide");
  $("#resultArea").classList.remove("hide");
  $("#progressFill").style.width = "100%";

  const total = quizQuestions.length;
  const pct = total ? Math.round((score/total)*100) : 0;
  $("#resultSummary").innerHTML = `You scored <b>${score}/${total}</b> (<b>${pct}%</b>).`;

  const list = $("#reviewList");
  list.innerHTML = "";

  quizQuestions.forEach((q, i) => {
    const a = answered[i] || { chosenKey:"(none)", isCorrect:false };
    const correct = q.answerKey || "(missing)";
    const exp = q.explanation || "No explanation provided.";

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <h3>${escapeHtml(q.question)}</h3>
      <div class="badge">${a.isCorrect ? "✅ Correct" : "❌ Wrong"} • Your: <span class="mono">${escapeHtml(a.chosenKey)}</span> • Correct: <span class="mono">${escapeHtml(correct)}</span></div>
      <p><b>Explanation:</b>\n${escapeHtml(exp)}</p>
    `;
    list.appendChild(div);
  });

  persist();
}

/* ---------------------------
   Restore on reload
---------------------------- */
function restore(){
  const st = loadSession();
  if(!st) return;

  parsedQuestions = Array.isArray(st.parsedQuestions) ? st.parsedQuestions : [];
  quizQuestions = Array.isArray(st.quizQuestions) ? st.quizQuestions : [];
  idx = Number.isFinite(st.idx) ? st.idx : 0;
  score = Number.isFinite(st.score) ? st.score : 0;
  answered = Array.isArray(st.answered) ? st.answered : [];
  locked = false;

  if(st.settings){
    $("#togShuffleQ").checked = !!st.settings.shuffleQ;
    $("#togShuffleO").checked = !!st.settings.shuffleO;
  }

  $("#btnExportJson").disabled = parsedQuestions.length === 0;
  $("#btnStart").disabled = parsedQuestions.length === 0;
  $("#btnRestart").disabled = quizQuestions.length === 0;

  updateKPIs();

  if(quizQuestions.length && idx < quizQuestions.length){
    $("#btnStart").textContent = "Resume";
    $("#quizEmpty").textContent = "Resume your quiz any time. Refresh won’t reset it.";
  } else {
    $("#btnStart").textContent = "Start";
  }

  if(quizQuestions.length){
    if(idx >= quizQuestions.length) finishQuiz();
    else renderQuestion();
  }

  if(st.isReviewerMode){
    enterReviewerMode();
  }
}

/* ---------------------------
   UI events
---------------------------- */
$("#btnParse").addEventListener("click", async () => {
  const file = $("#pdfFile").files?.[0];
  if(!file){ setLog("Choose a PDF first."); return; }

  setLog("Reading PDF…");
  try{
    const text = await extractTextFromPdf(file);
    parsedQuestions = parseMcqText(text);

    $("#btnExportJson").disabled = parsedQuestions.length === 0;
    $("#btnStart").disabled = parsedQuestions.length === 0;

    setLog(parsedQuestions.length ? `Parsed ${parsedQuestions.length} question(s).` : "Parsed 0 questions. Try Paste.");
    updateKPIs();
    persist();
  }catch(e){
    console.error(e);
    setLog("PDF read failed: " + (e?.message || e));
  }
});

$("#btnStart").addEventListener("click", () => {
  if(!parsedQuestions.length){ setLog("Parse a PDF first."); return; }

  enterReviewerMode();

  // Resume if already in-progress; otherwise start fresh
  if(!quizQuestions.length || idx >= quizQuestions.length){
    prepareQuizFresh();
  }
  $("#btnStart").textContent = "Resume";

  renderQuestion();
  setLog("");
});

$("#btnNext").addEventListener("click", () => {
  // if already answered and correct, timer might be waiting; stop it.
  clearTimeout(autoNextTimer);
  autoNextTimer = null;
  nextQuestion();
});

$("#btnRestart").addEventListener("click", () => {
  if(!parsedQuestions.length){ setLog("Parse a PDF first."); return; }
  prepareQuizFresh();
  renderQuestion();
  setLog("Quiz reset.");
  persist();
});

$("#btnClearSession").addEventListener("click", () => {
  clearSession();
  parsedQuestions = [];
  quizQuestions = [];
  idx = 0;
  score = 0;
  answered = [];
  locked = false;

  $("#btnStart").disabled = true;
  $("#btnStart").textContent = "Start";
  $("#btnExportJson").disabled = true;
  $("#btnRestart").disabled = true;

  $("#quizArea").classList.add("hide");
  $("#resultArea").classList.add("hide");
  $("#quizEmpty").classList.remove("hide");
  $("#quizEmpty").textContent = "Cleared. Upload and parse a PDF to begin.";

  updateKPIs();
  setLog("Cleared.");
});

$("#btnExportJson").addEventListener("click", () => {
  if(!parsedQuestions.length) return;
  downloadFile("parsed-mcqs.json", JSON.stringify(parsedQuestions, null, 2));
});

$("#btnPasteMode").addEventListener("click", () => $("#pasteBox").classList.toggle("hide"));
$("#btnClosePaste").addEventListener("click", () => $("#pasteBox").classList.add("hide"));

$("#btnParsePaste").addEventListener("click", () => {
  parsedQuestions = parseMcqText($("#pasteText").value || "");
  $("#btnExportJson").disabled = parsedQuestions.length === 0;
  $("#btnStart").disabled = parsedQuestions.length === 0;
  setLog(parsedQuestions.length ? `Parsed ${parsedQuestions.length} from pasted text.` : "Parsed 0 from pasted text.");
  updateKPIs();
  persist();
});

$("#btnExitReviewer").addEventListener("click", () => exitReviewerMode());
document.addEventListener("keydown", (e) => {
  if(e.key === "Escape" && isReviewerMode) exitReviewerMode();
});

(function init(){
  updateKPIs();
  restore();
})();
