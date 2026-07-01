const state = {
  conversationId: existingConversationId(),
  messages: [],
  memory: null,
  memoryDirty: false,
  busy: false,
  health: null,
  models: [],
};

const baseUrl = new URL("./", window.location.href);
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
const workersLabel = document.getElementById("workersLabel");
const selectedWorkerLabel = document.getElementById("selectedWorkerLabel");
const modelCountLabel = document.getElementById("modelCountLabel");
const modelsList = document.getElementById("modelsList");
const activityLog = document.getElementById("activityLog");
const clockLabel = document.getElementById("clockLabel");
const memorySaveButton = document.getElementById("memorySaveButton");
const memorySummaryInput = document.getElementById("memorySummaryInput");
const memoryPlansInput = document.getElementById("memoryPlansInput");
const memoryFactsInput = document.getElementById("memoryFactsInput");
const memoryTasksInput = document.getElementById("memoryTasksInput");

render();
renderMemory();
refreshHealth();
refreshModels();
loadConversation();
setInterval(refreshHealth, 5000);
setInterval(refreshModels, 10000);
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

for (const memoryInput of [memorySummaryInput, memoryPlansInput, memoryFactsInput, memoryTasksInput]) {
  memoryInput.addEventListener("input", () => {
    state.memoryDirty = true;
    memorySaveButton.textContent = "save";
  });
}

memorySaveButton.addEventListener("click", async () => {
  if (state.busy) {
    return;
  }
  memorySaveButton.disabled = true;
  memorySaveButton.textContent = "saving";
  try {
    const response = await fetch(appUrl("api/conversation/memory"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversation_id: state.conversationId,
        memory: collectMemory(),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `memory save failed ${response.status}`);
    }
    state.conversationId = payload.conversation?.conversation_id || state.conversationId;
    localStorage.setItem("marshall.chat.conversation_id", state.conversationId);
    state.memory = payload.conversation?.memory || state.memory;
    state.memoryDirty = false;
    renderMemory();
    logEvent("memory", "saved");
  } catch (error) {
    logEvent("memory_error", error instanceof Error ? error.message : String(error));
    memorySaveButton.textContent = "save";
  } finally {
    memorySaveButton.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = input.value.trim();
  if (!prompt || state.busy) {
    return;
  }
  input.value = "";
  const assistantMessage = { role: "assistant", content: "" };
  state.messages.push({ role: "user", content: prompt }, assistantMessage);
  state.busy = true;
  render();
  logEvent("request", short(prompt, 64));
  const startedAt = performance.now();
  try {
    const payload = await streamChat({
      conversation_id: state.conversationId,
      prompt,
      max_tokens: Number(tokensInput.value),
      temperature: Number(tempInput.value),
    }, assistantMessage, startedAt);
    state.conversationId = payload.conversation_id || state.conversationId;
    localStorage.setItem("marshall.chat.conversation_id", state.conversationId);
    state.messages = payload.conversation?.messages || [
      ...state.messages,
    ];
    if (!state.memoryDirty) {
      state.memory = payload.conversation?.memory || state.memory;
      renderMemory();
    }
    latencyLabel.textContent = `${payload.elapsed_ms || Math.round(performance.now() - startedAt)}ms`;
    const selectedWorker = payload.worker_id || payload.worker_peer_id || "";
    selectedWorkerLabel.textContent = selectedWorker ? short(selectedWorker, 32) : "--";
    logEvent("response", `${payload.elapsed_ms || Math.round(performance.now() - startedAt)}ms ${selectedWorker ? `via ${short(selectedWorker, 40)}` : ""}`.trim());
  } catch (error) {
    if (assistantMessage.content === "") {
      state.messages = state.messages.filter((message) => message !== assistantMessage);
    }
    state.messages.push({ role: "error", content: error instanceof Error ? error.message : String(error) });
    readyDot.className = "status-dot bad";
    readyText.textContent = "error";
    logEvent("error", error instanceof Error ? error.message : String(error));
  } finally {
    state.busy = false;
    render();
  }
});

async function streamChat(body, assistantMessage, startedAt) {
  const response = await fetch(appUrl("api/chat/stream"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `request failed ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload = null;

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const event = parseSseBlock(block);
        if (event) {
          const result = handleStreamEvent(event.name, event.data, assistantMessage, startedAt);
          if (event.name === "done") {
            finalPayload = result;
          }
        }
        separatorIndex = buffer.indexOf("\n\n");
      }
    }
    if (done) {
      break;
    }
  }

  if (finalPayload == null) {
    throw new Error("stream ended without final response");
  }
  return finalPayload;
}

function parseSseBlock(block) {
  const lines = block.split("\n");
  let name = "message";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      name = line.slice("event:".length).trim();
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return {
    name,
    data: JSON.parse(dataLines.join("\n")),
  };
}

function handleStreamEvent(name, payload, assistantMessage, startedAt) {
  if (name === "accepted") {
    state.conversationId = payload.conversation_id || state.conversationId;
    logEvent("accepted", `${payload.model || ""} ${payload.adapter_id || ""}`.trim());
    return null;
  }
  if (name === "started") {
    const selectedWorker = payload.worker_id || payload.peer_id || "";
    selectedWorkerLabel.textContent = selectedWorker ? short(selectedWorker, 32) : "--";
    logEvent("started", selectedWorker ? `worker ${short(selectedWorker, 40)}` : "local");
    return null;
  }
  if (name === "chunk") {
    assistantMessage.content += payload.text || "";
    render();
    return null;
  }
  if (name === "completed") {
    assistantMessage.content = payload.text || assistantMessage.content;
    latencyLabel.textContent = `${payload.elapsed_ms || Math.round(performance.now() - startedAt)}ms`;
    render();
    return null;
  }
  if (name === "error") {
    throw new Error(payload.error || "stream failed");
  }
  if (name === "done") {
    return payload;
  }
  return null;
}

async function loadConversation() {
  if (!state.conversationId) {
    return;
  }
  try {
    const response = await fetch(appUrl(`api/conversation?conversation_id=${encodeURIComponent(state.conversationId)}`), { cache: "no-store" });
    if (response.status === 404) {
      return;
    }
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `conversation failed ${response.status}`);
    }
    state.messages = payload.conversation?.messages || [];
    state.memory = payload.conversation?.memory || state.memory;
    render();
    renderMemory();
    logEvent("memory", `${state.messages.length} persisted messages`);
  } catch (error) {
    logEvent("memory_error", error instanceof Error ? error.message : String(error));
  }
}

async function refreshHealth() {
  try {
    const response = await fetch(appUrl("api/health"), { cache: "no-store" });
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
    workersLabel.textContent = workerText(payload.inference);
  } catch {
    readyDot.className = "status-dot bad";
    readyText.textContent = "offline";
  }
}

async function refreshModels() {
  try {
    const response = await fetch(appUrl("api/models"), { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `models failed ${response.status}`);
    }
    state.models = Array.isArray(payload.serving) && payload.serving.length > 0
      ? payload.serving
      : payload.current
      ? [payload.current]
      : [];
    renderModels();
  } catch (error) {
    modelCountLabel.textContent = "offline";
    modelsList.innerHTML = "";
    const item = document.createElement("div");
    item.className = "model-row muted";
    item.textContent = error instanceof Error ? short(error.message, 80) : "model registry unavailable";
    modelsList.append(item);
  }
}

function render() {
  transcript.innerHTML = "";
  const messages = state.messages.length === 0
    ? [{ role: "assistant", content: "marshall.chat session ready." }]
    : state.messages;
  for (const message of messages) {
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

function renderMemory() {
  const memory = state.memory || emptyMemory();
  if (!state.memoryDirty) {
    memorySummaryInput.value = memory.summary || "";
    memoryPlansInput.value = itemsToLines(memory.plans);
    memoryFactsInput.value = itemsToLines(memory.facts);
    memoryTasksInput.value = itemsToLines(memory.open_tasks);
  }
  memorySaveButton.textContent = state.memoryDirty ? "save" : "saved";
}

function renderModels() {
  modelsList.innerHTML = "";
  modelCountLabel.textContent = `${state.models.length} ready`;
  if (state.models.length === 0) {
    const item = document.createElement("div");
    item.className = "model-row muted";
    item.textContent = "no ready packages";
    modelsList.append(item);
    return;
  }
  for (const model of state.models.slice(0, 6)) {
    const item = document.createElement("div");
    item.className = `model-row ${model.selected ? "selected" : ""}`;
    const head = document.createElement("div");
    head.className = "model-row-head";
    const title = document.createElement("strong");
    title.textContent = short(model.base_model || "unknown-model", 48);
    const status = document.createElement("span");
    const readyWorkers = model.ready_workers ?? (model.status === "ready" ? 1 : 0);
    status.textContent = model.selected ? "serving" : `${readyWorkers} workers`;
    head.append(title, status);

    const meta = document.createElement("div");
    meta.className = "model-row-meta";
    meta.textContent = [
      short(model.adapter_id || "--", 34),
      model.eval?.score == null ? "score --" : `score ${Number(model.eval.score).toFixed(3)}`,
      shortHash(model.package_artifact_hash || model.adapter_artifact_hash),
      "p2p hash-checked chunks",
    ].filter(Boolean).join(" · ");
    item.append(head, meta);
    modelsList.append(item);
  }
}

function collectMemory() {
  return {
    summary: memorySummaryInput.value,
    plans: linesToItems(memoryPlansInput.value),
    facts: linesToItems(memoryFactsInput.value),
    open_tasks: linesToItems(memoryTasksInput.value),
  };
}

function emptyMemory() {
  return {
    summary: "",
    facts: [],
    preferences: [],
    goals: [],
    open_tasks: [],
    plans: [],
  };
}

function itemsToLines(items) {
  return (items || [])
    .filter((item) => !item.status || item.status === "active")
    .map((item) => item.text || "")
    .filter(Boolean)
    .join("\n");
}

function linesToItems(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

function workerText(inference) {
  if (!inference) {
    return "--";
  }
  const ready = inference.ready_workers ?? 0;
  const configured = inference.configured_workers ?? 0;
  return `${ready}/${configured} ready`;
}

function appUrl(path) {
  return new URL(path.replace(/^\/+/, ""), baseUrl).toString();
}

function existingConversationId() {
  const existing = localStorage.getItem("marshall.chat.conversation_id");
  if (existing) {
    return existing;
  }
  const next = `conv_${crypto.randomUUID()}`;
  localStorage.setItem("marshall.chat.conversation_id", next);
  return next;
}
