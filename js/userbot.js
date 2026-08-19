(function () {
  "use strict";

  const config = window.APP_CONFIG || {};
  const API_BASE_URL = String(config.API_BASE_URL || "").replace(/\/$/, "");
  const SESSION_DURATION_MS = config.SESSION_DURATION_MS || 15 * 60 * 1000;
  const PENDING_LOGIN_DURATION_MS = config.PENDING_LOGIN_DURATION_MS || 10 * 60 * 1000;
  const TASK_POLL_INTERVAL_MS = config.TASK_POLL_INTERVAL_MS || 2500;
  const STORAGE_KEY = "telegram-media-cabinet-session-v1";

  const state = {
    token: null,
    expiresAt: 0,
    pendingToken: null,
    pendingExpiresAt: 0,
    phone: "",
    phoneCodeHash: "",
    vipUserId: null,
    accessType: null,
    chats: [],
    currentChatId: null,
    offsetId: 0,
    hasMoreMessages: true,
    loadingMessages: false,
    tasks: {},
    hiddenTaskIds: new Set(),
    countdownTimer: null,
    taskTimer: null,
    expiryWarningShown: false
  };

  const elements = {};
  const byId = (id) => document.getElementById(id);

  function cacheElements() {
    [
      "browser-notice", "connection-pill", "connection-label", "access-check-view",
      "access-denied-view", "access-denied-message", "upgrade-vip-button",
      "join-group-button", "retry-vip-button", "login-view",
      "cabinet-view", "phone-form", "code-form", "phone", "code", "password",
      "password-field", "sent-phone", "send-code-button", "login-button",
      "change-phone-button", "toggle-password-button", "step-phone", "step-code",
      "step-ready", "session-timer", "renew-button", "logout-button",
      "refresh-chats-button", "chat-search", "chat-list", "chat-list-view",
      "message-view", "back-to-chats-button", "current-chat-name",
      "load-more-button", "message-list", "task-panel", "task-list",
      "dismiss-tasks-button", "expiry-dialog", "expiry-close-button",
      "expiry-renew-button", "toast-region"
    ].forEach((id) => { elements[id] = byId(id); });
  }

  function readStoredSession() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      state.token = typeof saved.token === "string" ? saved.token : null;
      state.expiresAt = Number(saved.expiresAt) || 0;
      state.pendingToken = typeof saved.pendingToken === "string" ? saved.pendingToken : null;
      state.pendingExpiresAt = Number(saved.pendingExpiresAt) || 0;
      state.phone = typeof saved.phone === "string" ? saved.phone : "";
      state.phoneCodeHash = typeof saved.phoneCodeHash === "string" ? saved.phoneCodeHash : "";
      state.vipUserId = typeof saved.vipUserId === "string" ? saved.vipUserId : null;
    } catch (_) {
      localStorage.removeItem(STORAGE_KEY);
    }

    if (state.token && Date.now() >= state.expiresAt) {
      state.token = null;
      state.expiresAt = 0;
    }
    if (state.pendingToken && Date.now() >= state.pendingExpiresAt) clearPendingState();
    persistSession();
  }

  function persistSession() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      token: state.token,
      expiresAt: state.expiresAt,
      pendingToken: state.pendingToken,
      pendingExpiresAt: state.pendingExpiresAt,
      phone: state.phone,
      phoneCodeHash: state.phoneCodeHash,
      vipUserId: state.vipUserId
    }));
  }

  function clearPendingState() {
    state.pendingToken = null;
    state.pendingExpiresAt = 0;
    state.phoneCodeHash = "";
  }

  function clearActiveState() {
    state.token = null;
    state.expiresAt = 0;
    state.currentChatId = null;
    state.tasks = {};
    state.expiryWarningShown = false;
    clearPendingState();
    stopSessionTimers();
    persistSession();
  }

  function initTelegram() {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg) {
      elements["browser-notice"].classList.remove("hidden");
      return;
    }
    tg.ready();
    tg.expand();
    if (typeof tg.setHeaderColor === "function") tg.setHeaderColor("#0d1726");
    if (typeof tg.setBackgroundColor === "function") tg.setBackgroundColor("#07111f");
    if (!tg.initData) elements["browser-notice"].classList.remove("hidden");
  }

  function bindEvents() {
    elements["phone-form"].addEventListener("submit", sendCode);
    elements["code-form"].addEventListener("submit", login);
    elements["change-phone-button"].addEventListener("click", changePhone);
    elements["toggle-password-button"].addEventListener("click", togglePassword);
    elements["renew-button"].addEventListener("click", renewSession);
    elements["logout-button"].addEventListener("click", logout);
    elements["refresh-chats-button"].addEventListener("click", loadChats);
    elements["chat-search"].addEventListener("input", renderChats);
    elements["back-to-chats-button"].addEventListener("click", showChatList);
    elements["load-more-button"].addEventListener("click", () => loadMessages(false));
    elements["dismiss-tasks-button"].addEventListener("click", dismissFinishedTasks);
    elements["expiry-close-button"].addEventListener("click", closeExpiryDialog);
    elements["expiry-renew-button"].addEventListener("click", renewSession);
    elements["upgrade-vip-button"].addEventListener("click", openVipUpgrade);
    elements["join-group-button"].addEventListener("click", openDiscussionGroup);
    elements["retry-vip-button"].addEventListener("click", checkUserbotAccess);
  }

  function openTelegramUrl(url) {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg && typeof tg.openTelegramLink === "function") {
      tg.openTelegramLink(url);
      return;
    }
    window.location.assign(url);
  }

  function openVipUpgrade() {
    openTelegramUrl("https://t.me/flash_pic_helper_bot");
  }

  function openDiscussionGroup() {
    openTelegramUrl("https://t.me/flash_pic_onlytext");
  }

  function miniAppAuthorizationHeaders() {
    const initData = window.Telegram && window.Telegram.WebApp
      ? window.Telegram.WebApp.initData
      : "";
    return initData ? { Authorization: `tma ${initData}` } : {};
  }

  async function apiRequest(path, options = {}) {
    if (!API_BASE_URL) throw new Error("尚未設定後端 API 網址");
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const authToken = options.authToken === undefined ? state.token : options.authToken;
    if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

    let response;
    try {
      const fetchOptions = { ...options };
      delete fetchOptions.authToken;
      response = await fetch(`${API_BASE_URL}${path}`, { ...fetchOptions, headers });
    } catch (_) {
      throw new Error("無法連接伺服器，請檢查網絡後再試");
    }

    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
    if (!response.ok) {
      const detail = data && data.detail;
      const message = typeof detail === "string"
        ? detail
        : (detail && detail.message) || `伺服器回應錯誤 (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data || {};
  }

  function setButtonLoading(button, loading, loadingLabel) {
    if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent.trim();
    button.disabled = loading;
    button.classList.toggle("loading", loading);
    button.textContent = loading ? loadingLabel : button.dataset.defaultLabel;
  }

  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.textContent = type === "error" ? "!" : type === "success" ? "✓" : "i";
    const text = document.createElement("span");
    text.textContent = message;
    toast.append(icon, text);
    elements["toast-region"].appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("visible"));
    window.setTimeout(() => {
      toast.classList.remove("visible");
      window.setTimeout(() => toast.remove(), 250);
    }, 3400);
  }

  function errorMessage(error, fallback) {
    return error && error.message ? error.message : fallback;
  }

  function setStep(step) {
    const order = ["step-phone", "step-code", "step-ready"];
    const activeIndex = order.indexOf(step);
    order.forEach((id, index) => {
      elements[id].classList.toggle("active", index === activeIndex);
      elements[id].classList.toggle("done", index < activeIndex);
    });
  }

  function showLoginView(mode = "phone") {
    elements["access-check-view"].classList.add("hidden");
    elements["access-denied-view"].classList.add("hidden");
    elements["login-view"].classList.remove("hidden");
    elements["cabinet-view"].classList.add("hidden");
    elements["connection-pill"].classList.remove("connected");
    elements["connection-label"].textContent = "尚未登入";
    const codeMode = mode === "code" && state.pendingToken;
    elements["phone-form"].classList.toggle("hidden", codeMode);
    elements["code-form"].classList.toggle("hidden", !codeMode);
    if (codeMode) {
      setStep("step-code");
      elements["sent-phone"].textContent = state.phone;
      elements.phone.value = state.phone;
      window.setTimeout(() => elements.code.focus(), 50);
    } else {
      setStep("step-phone");
      elements.phone.value = state.phone;
    }
  }

  function showCabinetView() {
    elements["access-check-view"].classList.add("hidden");
    elements["access-denied-view"].classList.add("hidden");
    setStep("step-ready");
    elements["login-view"].classList.add("hidden");
    elements["cabinet-view"].classList.remove("hidden");
    elements["connection-pill"].classList.add("connected");
    elements["connection-label"].textContent = state.accessType === "weekend_member"
      ? "會員週末福利"
      : "已安全連線";
    startSessionTimers();
    showChatList();
    loadChats();
  }

  function showAccessChecking() {
    elements["access-check-view"].classList.remove("hidden");
    elements["access-denied-view"].classList.add("hidden");
    elements["login-view"].classList.add("hidden");
    elements["cabinet-view"].classList.add("hidden");
    elements["connection-pill"].classList.remove("connected");
    elements["connection-label"].textContent = "驗證資格中";
  }

  function showAccessDenied(message) {
    stopSessionTimers();
    elements["access-check-view"].classList.add("hidden");
    elements["access-denied-view"].classList.remove("hidden");
    elements["login-view"].classList.add("hidden");
    elements["cabinet-view"].classList.add("hidden");
    elements["access-denied-message"].textContent = message;
    elements["connection-pill"].classList.remove("connected");
    elements["connection-label"].textContent = "未獲授權";
  }

  async function revokeSessionSilently() {
    const token = state.token || state.pendingToken;
    if (token) {
      try {
        await apiRequest("/auth/logout", { method: "POST", authToken: token });
      } catch (_) {
        // An expired or already revoked server session needs no further action.
      }
    }
    clearActiveState();
  }

  async function checkUserbotAccess() {
    showAccessChecking();
    const headers = miniAppAuthorizationHeaders();
    if (!headers.Authorization) {
      elements["browser-notice"].classList.remove("hidden");
      showAccessDenied("請從 Telegram 內的 Mini App 按鈕開啟此頁面。");
      return;
    }
    elements["browser-notice"].classList.add("hidden");

    try {
      const access = await apiRequest("/api/access/check", {
        method: "POST",
        headers,
        authToken: null
      });
      const verifiedVipUserId = String(access.user_id);
      const ownsStoredSession = state.vipUserId === verifiedVipUserId;
      if ((state.token || state.pendingToken) && !ownsStoredSession) {
        clearActiveState();
      }
      state.vipUserId = verifiedVipUserId;
      state.accessType = access.access_type || null;
      persistSession();
      if (!access.has_access) {
        if (ownsStoredSession) await revokeSessionSilently();
        const reasonMessages = {
          not_weekend: "目前不是香港時間週末；你亦可升級為高級VIP隨時使用。",
          not_in_group: "你目前不是討論谷會員，請加入討論谷或升級為高級VIP。",
          banned_or_left: "未能確認有效的討論谷會員資格。",
          audit_bot_offline: "會員資格服務暫時離線，請稍後重新檢查。",
          error: "檢查討論谷會員資格時發生錯誤，請稍後重試。"
        };
        const reason = reasonMessages[access.reason]
          || "此功能僅限高級VIP，或香港時間週末的討論谷會員使用。";
        showAccessDenied(reason);
        return;
      }

      if (access.access_type === "weekend_member") {
        showToast("已套用討論谷會員週末福利", "success");
      }

      if (state.token) showCabinetView();
      else if (state.pendingToken) showLoginView("code");
      else showLoginView("phone");
    } catch (error) {
      showAccessDenied(errorMessage(error, "暫時無法檢查 VIP 資格，請稍後重試。"));
    }
  }

  async function sendCode(event) {
    event.preventDefault();
    let phone = elements.phone.value.replace(/[\s()-]/g, "");
    if (!phone.startsWith("+")) phone = `+${phone}`;
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      showToast("請輸入包含國碼的有效電話號碼", "error");
      elements.phone.focus();
      return;
    }

    setButtonLoading(elements["send-code-button"], true, "正在發送…");
    try {
      const data = await apiRequest("/auth/send_code", {
        method: "POST",
        body: JSON.stringify({ phone }),
        headers: miniAppAuthorizationHeaders(),
        authToken: null
      });
      state.phone = phone;
      state.pendingToken = data.session_token;
      state.phoneCodeHash = data.phone_code_hash;
      state.pendingExpiresAt = Date.now() + PENDING_LOGIN_DURATION_MS;
      persistSession();
      showLoginView("code");
      showToast("驗證碼已發送", "success");
    } catch (error) {
      const detail = error.data && error.data.detail;
      if (error.status === 400 && detail && detail.action === "restore_session") {
        state.phone = phone;
        state.token = detail.session_token;
        state.expiresAt = Date.now() + (Number(detail.expires_at) || SESSION_DURATION_MS);
        clearPendingState();
        persistSession();
        showToast(detail.message || "已恢復先前的登入", "success");
        showCabinetView();
      } else {
        if (error.status === 403) {
          showAccessDenied(error.message);
          return;
        }
        showToast(errorMessage(error, "發送驗證碼失敗"), "error");
      }
    } finally {
      setButtonLoading(elements["send-code-button"], false);
    }
  }

  async function login(event) {
    event.preventDefault();
    const code = elements.code.value.replace(/\s/g, "");
    const passwordNeeded = !elements["password-field"].classList.contains("hidden");
    const password = elements.password.value;
    if (!state.pendingToken) {
      showToast("驗證流程已失效，請重新取得驗證碼", "error");
      showLoginView("phone");
      return;
    }
    if (!code) {
      showToast("請輸入 Telegram 驗證碼", "error");
      elements.code.focus();
      return;
    }
    if (passwordNeeded && !password) {
      showToast("請輸入兩步驟驗證密碼", "error");
      elements.password.focus();
      return;
    }

    setButtonLoading(elements["login-button"], true, "正在登入…");
    try {
      const data = await apiRequest("/auth/login", {
        method: "POST",
        authToken: state.pendingToken,
        body: JSON.stringify({
          phone: state.phone,
          phone_code_hash: state.phoneCodeHash,
          code,
          password: password || null
        })
      });
      if (data.status === "password_needed") {
        elements["password-field"].classList.remove("hidden");
        elements.password.focus();
        showToast("此帳號已啟用兩步驟驗證", "info");
        return;
      }
      state.token = state.pendingToken;
      state.expiresAt = Date.now() + SESSION_DURATION_MS;
      clearPendingState();
      elements.password.value = "";
      persistSession();
      showToast(data.message || "登入成功", "success");
      showCabinetView();
    } catch (error) {
      if (error.status === 401) {
        clearPendingState();
        persistSession();
        showLoginView("phone");
      }
      showToast(errorMessage(error, "登入失敗"), "error");
    } finally {
      setButtonLoading(elements["login-button"], false);
    }
  }

  async function changePhone() {
    const token = state.pendingToken;
    clearPendingState();
    state.phone = "";
    persistSession();
    elements.code.value = "";
    elements.password.value = "";
    elements["password-field"].classList.add("hidden");
    showLoginView("phone");
    if (token) {
      try {
        await apiRequest("/auth/logout", { method: "POST", authToken: token });
      } catch (_) {
        // The pending server session will expire automatically if already gone.
      }
    }
  }

  function togglePassword() {
    const reveal = elements.password.type === "password";
    elements.password.type = reveal ? "text" : "password";
    elements["toggle-password-button"].textContent = reveal ? "隱藏" : "顯示";
    elements["toggle-password-button"].setAttribute("aria-label", reveal ? "隱藏密碼" : "顯示密碼");
  }

  function startSessionTimers() {
    stopSessionTimers();
    updateCountdown();
    state.countdownTimer = window.setInterval(updateCountdown, 1000);
    pollTasks();
    state.taskTimer = window.setInterval(pollTasks, TASK_POLL_INTERVAL_MS);
  }

  function stopSessionTimers() {
    window.clearInterval(state.countdownTimer);
    window.clearInterval(state.taskTimer);
    state.countdownTimer = null;
    state.taskTimer = null;
  }

  function updateCountdown() {
    const remaining = Math.max(0, state.expiresAt - Date.now());
    const totalSeconds = Math.ceil(remaining / 1000);
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    elements["session-timer"].textContent = `${minutes}:${seconds}`;
    const expiring = remaining > 0 && remaining <= 2 * 60 * 1000;
    elements["renew-button"].classList.toggle("hidden", !expiring);
    if (expiring && !state.expiryWarningShown) {
      state.expiryWarningShown = true;
      elements["expiry-dialog"].classList.remove("hidden");
    }
    if (remaining <= 0) {
      clearActiveState();
      closeExpiryDialog();
      showLoginView("phone");
      showToast("登入工作階段已到期，請重新登入", "error");
    }
  }

  async function renewSession() {
    const buttons = [elements["renew-button"], elements["expiry-renew-button"]];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const data = await apiRequest("/auth/renew", { method: "POST" });
      state.expiresAt = Date.now() + SESSION_DURATION_MS;
      state.expiryWarningShown = false;
      persistSession();
      closeExpiryDialog();
      updateCountdown();
      showToast(data.message || "連線已延長 15 分鐘", "success");
    } catch (error) {
      if (error.status === 403) {
        await revokeSessionSilently();
        showAccessDenied(error.message);
      } else {
        handleSessionError(error, "續期失敗，請重新登入");
      }
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function closeExpiryDialog() {
    elements["expiry-dialog"].classList.add("hidden");
  }

  async function logout() {
    if (!window.confirm("確定安全登出？所有未完成任務會被中止，伺服器端授權資料也會刪除。")) return;
    elements["logout-button"].disabled = true;
    try {
      await apiRequest("/auth/logout", { method: "POST" });
    } catch (error) {
      if (error.status !== 401) showToast(errorMessage(error, "伺服器登出失敗"), "error");
    } finally {
      clearActiveState();
      state.phone = "";
      persistSession();
      elements["logout-button"].disabled = false;
      showLoginView("phone");
      showToast("已登出此裝置", "success");
    }
  }

  function handleSessionError(error, fallback) {
    if (error && error.status === 401) {
      clearActiveState();
      showLoginView("phone");
      showToast("連線已失效，請重新登入", "error");
      return true;
    }
    showToast(errorMessage(error, fallback), "error");
    return false;
  }

  async function loadChats() {
    renderLoading(elements["chat-list"], "正在讀取私人對話…");
    elements["refresh-chats-button"].disabled = true;
    try {
      const data = await apiRequest("/api/chats");
      state.chats = Array.isArray(data.chats) ? data.chats : [];
      renderChats();
    } catch (error) {
      if (error.status === 403) {
        clearActiveState();
        showLoginView("phone");
        showToast("請重新登入以更新 VIP 授權", "error");
      } else if (!handleSessionError(error, "讀取對話失敗")) {
        renderError(elements["chat-list"], "無法載入對話，請稍後重試。", loadChats);
      }
    } finally {
      elements["refresh-chats-button"].disabled = false;
    }
  }

  function renderChats() {
    const query = elements["chat-search"].value.trim().toLocaleLowerCase();
    const chats = state.chats.filter((chat) => String(chat.name || "").toLocaleLowerCase().includes(query));
    elements["chat-list"].replaceChildren();
    if (!chats.length) {
      renderEmpty(elements["chat-list"], query ? "找不到相符的私人對話" : "目前沒有可用的私人對話");
      return;
    }

    const fragment = document.createDocumentFragment();
    chats.forEach((chat) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chat-item";
      const avatar = document.createElement("span");
      avatar.className = "chat-avatar";
      avatar.textContent = getInitial(chat.name);
      const copy = document.createElement("span");
      copy.className = "chat-copy";
      const name = document.createElement("strong");
      name.textContent = chat.name || "未命名對話";
      const sub = document.createElement("small");
      sub.textContent = Number(chat.unread_count) > 0 ? `${chat.unread_count} 則未讀訊息` : "點擊查看媒體";
      copy.append(name, sub);
      button.append(avatar, copy);
      if (Number(chat.unread_count) > 0) {
        const badge = document.createElement("span");
        badge.className = "unread-badge";
        badge.textContent = chat.unread_count > 99 ? "99+" : String(chat.unread_count);
        button.appendChild(badge);
      }
      const arrow = document.createElement("span");
      arrow.className = "chat-arrow";
      arrow.textContent = "›";
      button.appendChild(arrow);
      button.addEventListener("click", () => openChat(String(chat.id), chat.name || "未命名對話"));
      fragment.appendChild(button);
    });
    elements["chat-list"].appendChild(fragment);
  }

  function getInitial(name) {
    const value = String(name || "?").trim();
    return Array.from(value)[0] || "?";
  }

  function showChatList() {
    state.currentChatId = null;
    elements["message-view"].classList.add("hidden");
    elements["chat-list-view"].classList.remove("hidden");
  }

  function openChat(chatId, chatName) {
    state.currentChatId = chatId;
    state.offsetId = 0;
    state.hasMoreMessages = true;
    elements["current-chat-name"].textContent = chatName;
    elements["chat-list-view"].classList.add("hidden");
    elements["message-view"].classList.remove("hidden");
    elements["message-list"].replaceChildren();
    elements["load-more-button"].classList.add("hidden");
    loadMessages(true);
  }

  async function loadMessages(initial) {
    if (state.loadingMessages || !state.currentChatId || (!initial && !state.hasMoreMessages)) return;
    state.loadingMessages = true;
    const button = elements["load-more-button"];
    button.disabled = true;
    button.textContent = "載入中…";
    if (initial) renderLoading(elements["message-list"], "正在讀取訊息…");
    try {
      const params = new URLSearchParams({ limit: "20", offset_id: String(initial ? 0 : state.offsetId) });
      const data = await apiRequest(`/api/messages/${encodeURIComponent(state.currentChatId)}?${params}`);
      const messages = Array.isArray(data.messages) ? data.messages : [];
      if (initial) elements["message-list"].replaceChildren();
      if (!messages.length) {
        state.hasMoreMessages = false;
        button.classList.add("hidden");
        if (initial) renderEmpty(elements["message-list"], "這個對話目前沒有訊息");
        return;
      }
      const ids = messages.map((message) => Number(message.id)).filter(Number.isFinite);
      if (ids.length) state.offsetId = Math.min(...ids);
      state.hasMoreMessages = messages.length === 20;
      button.classList.toggle("hidden", !state.hasMoreMessages);
      const fragment = document.createDocumentFragment();
      [...messages].reverse().forEach((message) => fragment.appendChild(createMessage(message)));
      if (initial || !elements["message-list"].firstChild) {
        elements["message-list"].appendChild(fragment);
      } else {
        elements["message-list"].insertBefore(fragment, elements["message-list"].firstChild);
      }
      if (initial) window.setTimeout(() => elements["message-list"].lastElementChild?.scrollIntoView({ block: "end" }), 0);
    } catch (error) {
      if (!handleSessionError(error, "讀取訊息失敗") && initial) {
        renderError(elements["message-list"], "無法載入訊息。", () => loadMessages(true));
      }
    } finally {
      state.loadingMessages = false;
      button.disabled = false;
      button.textContent = "載入更早訊息";
    }
  }

  function createMessage(message) {
    const item = document.createElement("article");
    item.className = `message ${message.is_sender ? "outgoing" : "incoming"}`;
    const text = document.createElement("p");
    text.className = "message-text";
    text.textContent = message.text || (message.has_media ? "媒體訊息" : "空白訊息");
    item.appendChild(text);
    if (message.has_media) {
      const mediaRow = document.createElement("div");
      mediaRow.className = "media-row";
      const icon = document.createElement("span");
      icon.className = "media-icon";
      icon.textContent = "▣";
      const label = document.createElement("span");
      label.textContent = "可提取的媒體";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "save-media-button";
      button.dataset.messageId = String(message.id);
      button.textContent = "存到收藏";
      button.addEventListener("click", () => saveMedia(message.id, button));
      mediaRow.append(icon, label, button);
      item.appendChild(mediaRow);
      updateMediaButton(button, state.tasks[String(message.id)]);
    }
    const time = document.createElement("time");
    time.className = "message-time";
    time.dateTime = message.date || "";
    time.textContent = formatMessageDate(message.date);
    item.appendChild(time);
    return item;
  }

  function formatMessageDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return new Intl.DateTimeFormat("zh-Hant", sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
    ).format(date);
  }

  async function saveMedia(messageId, button) {
    button.disabled = true;
    button.textContent = "建立任務…";
    try {
      const data = await apiRequest(`/api/forward_media/${encodeURIComponent(state.currentChatId)}/${encodeURIComponent(messageId)}`, { method: "POST" });
      state.tasks[String(messageId)] = { task_id: data.task_id, status: "processing", message: "處理中…" };
      renderTasks();
      updateMediaButtons();
      showToast("已開始提取，完成後會出現在收藏的訊息", "success");
      pollTasks();
    } catch (error) {
      if (!handleSessionError(error, "無法建立提取任務")) updateMediaButton(button, null);
    }
  }

  async function pollTasks() {
    if (!state.token) return;
    try {
      const data = await apiRequest("/api/tasks");
      state.tasks = data.tasks && typeof data.tasks === "object" ? data.tasks : {};
      renderTasks();
      updateMediaButtons();
    } catch (error) {
      if (error.status === 401) handleSessionError(error, "連線已失效");
    }
  }

  function updateMediaButtons() {
    document.querySelectorAll(".save-media-button[data-message-id]").forEach((button) => {
      updateMediaButton(button, state.tasks[button.dataset.messageId]);
    });
  }

  function updateMediaButton(button, task) {
    button.classList.remove("processing", "success", "error");
    if (!task) {
      button.disabled = false;
      button.textContent = "存到收藏";
      return;
    }
    const status = ["processing", "success", "error"].includes(task.status) ? task.status : "processing";
    button.classList.add(status);
    button.disabled = status !== "error";
    button.textContent = status === "success" ? "已存到收藏" : status === "error" ? "重試" : "處理中…";
  }

  function renderTasks() {
    const entries = Object.entries(state.tasks).filter(([, task]) => !state.hiddenTaskIds.has(task.task_id));
    elements["task-list"].replaceChildren();
    elements["task-panel"].classList.toggle("hidden", entries.length === 0);
    entries.forEach(([key, task]) => {
      const row = document.createElement("div");
      row.className = `task-item ${task.status || "processing"}`;
      const statusIcon = document.createElement("span");
      statusIcon.className = "task-status-icon";
      statusIcon.textContent = task.status === "success" ? "✓" : task.status === "error" ? "!" : "↻";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = key === task.task_id ? "批量掃描" : `媒體 #${key}`;
      const message = document.createElement("p");
      message.textContent = task.message || "處理中…";
      copy.append(title, message);
      row.append(statusIcon, copy);
      elements["task-list"].appendChild(row);
    });
  }

  function dismissFinishedTasks() {
    Object.values(state.tasks).forEach((task) => {
      if (task.status !== "processing") state.hiddenTaskIds.add(task.task_id);
    });
    renderTasks();
  }

  function renderLoading(container, label) {
    container.replaceChildren();
    const box = document.createElement("div");
    box.className = "state-box";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    const text = document.createElement("p");
    text.textContent = label;
    box.append(spinner, text);
    container.appendChild(box);
  }

  function renderEmpty(container, label) {
    container.replaceChildren();
    const box = document.createElement("div");
    box.className = "state-box empty";
    const icon = document.createElement("span");
    icon.className = "state-icon";
    icon.textContent = "◇";
    const text = document.createElement("p");
    text.textContent = label;
    box.append(icon, text);
    container.appendChild(box);
  }

  function renderError(container, label, retry) {
    container.replaceChildren();
    const box = document.createElement("div");
    box.className = "state-box error-state";
    const text = document.createElement("p");
    text.textContent = label;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = "重新載入";
    button.addEventListener("click", retry);
    box.append(text, button);
    container.appendChild(box);
  }

  function initialize() {
    cacheElements();
    initTelegram();
    bindEvents();
    readStoredSession();
    checkUserbotAccess();
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
