const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const STORAGE_KEYS = {
  apiKey: "ai_chat_api_key",
  model: "ai_chat_model",
  messages: "ai_chat_messages",
};

const DEFAULTS = {
  model: "openrouter/free",
};
const MAX_SAVED_MESSAGES = 200;
const REQUEST_TIMEOUT_MS = 90000;
const PERMANENT_SYSTEM_PROMPT = "You are Tawseef. A helpful, concise assistant.You provide descriptive responses.";

const messageTemplate = document.getElementById("messageTemplate");
const appShell = document.getElementById("appShell");
const messagesEl = document.getElementById("messages");
const composerForm = document.getElementById("composerForm");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const statusText = document.getElementById("statusText");
const apiKeyInput = document.getElementById("apiKey");
const modelSelect = document.getElementById("model");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const clearChatBtn = document.getElementById("clearChatBtn");
const openSidebarBtn = document.getElementById("openSidebarBtn");
const closeSidebarBtn = document.getElementById("closeSidebarBtn");
const sidebarOverlay = document.getElementById("sidebarOverlay");

let messages = [];
let isSending = false;
let activeController = null;

function setStatus(text) {
  statusText.textContent = text;
}

function escapeFallbackText(value) {
  return value || "";
}

function saveMessages() {
  if (messages.length > MAX_SAVED_MESSAGES) {
    messages = messages.slice(-MAX_SAVED_MESSAGES);
  }
  localStorage.setItem(STORAGE_KEYS.messages, JSON.stringify(messages));
}

function loadSettings() {
  apiKeyInput.value = localStorage.getItem(STORAGE_KEYS.apiKey) || "";
  const savedModel = localStorage.getItem(STORAGE_KEYS.model) || DEFAULTS.model;
  modelSelect.value = savedModel;
  if (!modelSelect.value) {
    modelSelect.value = DEFAULTS.model;
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.apiKey, apiKeyInput.value.trim());
  localStorage.setItem(STORAGE_KEYS.model, modelSelect.value);
  setStatus("Settings saved");
}

function clearChat() {
  messages = [];
  messagesEl.innerHTML = "";
  saveMessages();
  addAssistantGreeting();
  setStatus("Chat cleared");
}

function loadMessages() {
  const raw = localStorage.getItem(STORAGE_KEYS.messages);
  if (!raw) {
    addAssistantGreeting();
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      addAssistantGreeting();
      return;
    }
    messages = parsed
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_SAVED_MESSAGES);
    if (messages.length === 0) {
      addAssistantGreeting();
      return;
    }
    renderAllMessages();
  } catch {
    addAssistantGreeting();
  }
}

function addAssistantGreeting() {
  const greeting = {
    role: "assistant",
    content: "Hello. I am ready. Add your API key in the left panel, then ask anything.",
  };
  messages.push(greeting);
  renderMessage(greeting);
  saveMessages();
}

function renderAllMessages() {
  messagesEl.innerHTML = "";
  messages.forEach(renderMessage);
  scrollToBottom();
}

function renderMessage(msg) {
  const { root, bubble } = createMessageElement(msg.role);
  bubble.textContent = escapeFallbackText(msg.content);
  messagesEl.appendChild(root);
  scrollToBottom();
  return { root, bubble };
}

function createMessageElement(role) {
  const node = messageTemplate.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector(".role").textContent = role === "user" ? "You" : "Assistant";
  const bubble = node.querySelector(".bubble");
  return { root: node, bubble };
}

function addTypingMessage() {
  const { root, bubble } = createMessageElement("assistant");
  bubble.innerHTML = `
    <span class="typing">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </span>
  `;
  messagesEl.appendChild(root);
  scrollToBottom();
  return { root, bubble };
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setComposerState(disabled) {
  isSending = disabled;
  sendBtn.disabled = false;
  sendBtn.textContent = disabled ? "Stop" : "Send";
  sendBtn.classList.toggle("btn-danger", disabled);
  messageInput.disabled = disabled;
}

function autoResizeInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
}

function buildApiMessages(nextUserMessage) {
  const systemPrompt = PERMANENT_SYSTEM_PROMPT;
  const history = messages.slice(-20);
  const payloadMessages = [];

  if (systemPrompt) {
    payloadMessages.push({ role: "system", content: systemPrompt });
  }

  history.forEach((m) => {
    payloadMessages.push({ role: m.role, content: m.content });
  });

  payloadMessages.push({ role: "user", content: nextUserMessage });
  return payloadMessages;
}

async function streamCompletion({ apiKey, model, payloadMessages, onToken, controller }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Title": "AI Chat App",
  };

  if (location.origin && location.origin.startsWith("http")) {
    headers["HTTP-Referer"] = location.origin;
  }

  const timeoutId = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: payloadMessages,
        temperature: 0.7,
        max_tokens: 800,
        stream: true,
      }),
    });

    if (!response.ok) {
      let details = `${response.status} ${response.statusText}`;
      try {
        const data = await response.json();
        details = data?.error?.message || JSON.stringify(data);
      } catch {
        // Ignore JSON parse errors and use fallback status text.
      }
      throw new Error(details);
    }

    if (!response.body) {
      throw new Error("No response stream available.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let fullText = "";
    let buffered = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) {
          continue;
        }

        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        const token = parsed?.choices?.[0]?.delta?.content || parsed?.choices?.[0]?.text || "";
        if (token) {
          fullText += token;
          onToken(token);
        }
      }
    }

    return fullText.trim();
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new Error("Request stopped or timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (activeController === controller) {
      activeController = null;
    }
  }
}

async function handleSend(event) {
  event.preventDefault();
  if (isSending) {
    if (activeController && !activeController.signal.aborted) {
      activeController.abort();
    }
    setStatus("Stopping...");
    return;
  }

  const userInput = messageInput.value.trim();
  if (!userInput) {
    return;
  }

  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus("Add API key first");
    apiKeyInput.focus();
    return;
  }

  const model = modelSelect.value;
  const payloadMessages = buildApiMessages(userInput);

  const userMessage = { role: "user", content: userInput };
  messages.push(userMessage);
  renderMessage(userMessage);
  saveMessages();

  messageInput.value = "";
  autoResizeInput();
  setComposerState(true);
  setStatus("Generating...");

  const typing = addTypingMessage();
  let assistantText = "";
  let hasFirstToken = false;
  const controller = new AbortController();
  activeController = controller;

  try {
    await streamCompletion({
      apiKey,
      model,
      payloadMessages,
      controller,
      onToken: (token) => {
        if (!hasFirstToken) {
          typing.bubble.textContent = "";
          hasFirstToken = true;
        }
        assistantText += token;
        typing.bubble.textContent = assistantText;
        scrollToBottom();
      },
    });

    const finalText = assistantText.trim() || "No response received.";
    typing.bubble.textContent = finalText;
    messages.push({ role: "assistant", content: finalText });
    saveMessages();
    setStatus("Ready");
  } catch (error) {
    const text = String(error?.message || "Request failed.");
    const wasStopped = text.toLowerCase().includes("stopped") || text.toLowerCase().includes("timed out");

    if (wasStopped) {
      if (assistantText.trim()) {
        const partial = `${assistantText.trim()}\n\n[stopped]`;
        typing.bubble.textContent = partial;
        messages.push({ role: "assistant", content: partial });
        saveMessages();
      } else {
        typing.root.remove();
      }
      setStatus("Stopped");
    } else {
      const message = `Error: ${text}`;
      typing.bubble.textContent = message;
      messages.push({ role: "assistant", content: message });
      saveMessages();
      setStatus("Failed");
    }
  } finally {
    setComposerState(false);
    messageInput.focus();
  }
}

function handleComposerKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composerForm.requestSubmit();
  }
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 900px)").matches;
}

function openSidebar() {
  if (!isMobileLayout() || !appShell) {
    return;
  }
  appShell.classList.add("sidebar-open");
}

function closeSidebar() {
  if (!appShell) {
    return;
  }
  appShell.classList.remove("sidebar-open");
}

function handleViewportChange() {
  if (!isMobileLayout()) {
    closeSidebar();
  }
}

function init() {
  loadSettings();
  loadMessages();
  autoResizeInput();

  saveSettingsBtn.addEventListener("click", saveSettings);
  clearChatBtn.addEventListener("click", clearChat);
  composerForm.addEventListener("submit", handleSend);
  messageInput.addEventListener("input", autoResizeInput);
  messageInput.addEventListener("keydown", handleComposerKeydown);

  modelSelect.addEventListener("change", saveSettings);
  apiKeyInput.addEventListener("change", saveSettings);
  openSidebarBtn.addEventListener("click", openSidebar);
  closeSidebarBtn.addEventListener("click", closeSidebar);
  sidebarOverlay.addEventListener("click", closeSidebar);
  window.addEventListener("resize", handleViewportChange);
}

init();
