const state = {
  messages: [
    {
      role: "assistant",
      content: "marshall.chat session ready.",
    },
  ],
  busy: false,
  health: null,
};

const transcript = document.getElementById("transcript");
const form = document.getElementById("chatForm");
const input = document.getElementById("promptInput");
const tokensInput = document.getElementById("tokensInput");
const tempInput = document.getElementById("tempInput");
const sendButton = document.getElementById("sendButton");
const readyDot = document.getElementById("readyDot");
const readyText = document.getElementById("readyText");
const runtimeLabel = document.getElementById("runtimeLabel");
const latencyLabel = document.getElementById("latencyLabel");
const modelLabel = document.getElementById("modelLabel");
const adapterLabel = document.getElementById("adapterLabel");
const hashLabel = document.getElementById("hashLabel");
const evalLabel = document.getElementById("evalLabel");
const scoreLabel = document.getElementById("scoreLabel");
const activityLog = document.getElementById("activityLog");
const clockLabel = document.getElementById("clockLabel");

render();
refreshHealth();
setInterval(refreshHealth, 5000);
setInterval(() => {
  clockLabel.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}, 1000);

input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }
  event.preventDefault();
  if (state.busy || input.value.trim() === "") {
    return;
  }
  form.requestSubmit();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = input.value.trim();
  if (!prompt || state.busy) {
    return;
  }
  input.value = "";
  state.messages.push({ role: "user", content: prompt });
  state.busy = true;
  render();
  logEvent("request", short(prompt, 64));
  const startedAt = performance.now();
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: state.messages,
        max_tokens: Number(tokensInput.value),
        temperature: Number(tempInput.value),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `request failed ${response.status}`);
    }
    state.messages.push({ role: "assistant", content: payload.text || payload.raw_text || "" });
    latencyLabel.textContent = `${payload.elapsed_ms || Math.round(performance.now() - startedAt)}ms`;
    logEvent("response", `${payload.elapsed_ms || Math.round(performance.now() - startedAt)}ms`);
  } catch (error) {
    state.messages.push({ role: "error", content: error instanceof Error ? error.message : String(error) });
    readyDot.className = "status-dot bad";
    readyText.textContent = "error";
    logEvent("error", error instanceof Error ? error.message : String(error));
  } finally {
    state.busy = false;
    render();
  }
});

async function refreshHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const payload = await response.json();
    state.health = payload;
    readyDot.className = `status-dot ${payload.ready ? "ready" : "bad"}`;
    readyText.textContent = payload.ready ? "ready" : payload.runtime === "p2p_worker" ? "worker missing" : "adapter missing";
    runtimeLabel.textContent = payload.runtime || "local inference";
    modelLabel.textContent = payload.model || "--";
    adapterLabel.textContent = payload.adapter_id || "--";
    hashLabel.textContent = shortHash(payload.adapter_hash);
    evalLabel.textContent = evalText(payload.eval);
    scoreLabel.textContent = payload.eval?.score == null ? "score --" : `score ${Number(payload.eval.score).toFixed(3)}`;
  } catch {
    readyDot.className = "status-dot bad";
    readyText.textContent = "offline";
  }
}

function render() {
  transcript.innerHTML = "";
  for (const message of state.messages) {
    const item = document.createElement("div");
    item.className = `message ${message.role}`;
    const role = document.createElement("div");
    role.className = "message-role";
    role.textContent = message.role;
    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = message.content;
    item.append(role, text);
    transcript.append(item);
  }
  sendButton.disabled = state.busy;
  sendButton.textContent = state.busy ? "running" : "send";
  transcript.scrollTop = transcript.scrollHeight;
}

function logEvent(type, detail) {
  const item = document.createElement("div");
  item.className = "event";
  const time = document.createElement("span");
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const body = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = type;
  body.append(strong, document.createTextNode(` ${short(detail, 96)}`));
  item.append(time, body);
  activityLog.prepend(item);
  while (activityLog.children.length > 40) {
    activityLog.lastElementChild?.remove();
  }
}

function shortHash(value) {
  if (!value) {
    return "--";
  }
  return value.length <= 22 ? value : `${value.slice(0, 14)}...${value.slice(-8)}`;
}

function short(value, limit) {
  if (!value) {
    return "";
  }
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function evalText(evalInfo) {
  if (!evalInfo || evalInfo.accuracy == null) {
    return "--";
  }
  const accuracy = Number(evalInfo.accuracy).toFixed(3);
  const correct = evalInfo.correct == null || evalInfo.examples == null ? "" : ` ${evalInfo.correct}/${evalInfo.examples}`;
  return `${accuracy}${correct}`;
}
